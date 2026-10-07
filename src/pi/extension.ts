import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { Extension, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { InvalidRange, MemoryEntryEmpty, MemoryEntryTooLong } from "../core/errors.js";
import { formatMemoryContext, formatMemoryItems } from "../core/format.js";
import { createMemoryCompactionTask } from "./compaction-task.js";
import type { MemoryResolver } from "./compaction-task.js";

export interface AdmissionInput {
	readonly content: string;
	/** The scope the call targets after validation; the first scope when none was requested. */
	readonly scope: string;
	readonly scopes: readonly string[];
	readonly conversationId: string;
}

export type AdmissionDecision =
	| { readonly admit: true; readonly content?: string | undefined; readonly scope?: string | undefined }
	| { readonly admit: false; readonly reason: string };

export interface MemoryAdmission {
	evaluate(input: AdmissionInput): AdmissionDecision | Promise<AdmissionDecision>;
}

export interface PiMemoryExtensionOptions {
	/** The memory for one scope. Called per request and per tool call; implementations should be cheap or cache. */
	readonly memory: MemoryResolver;
	/** Decides whether a memory_note call is stored, and may rewrite its content or scope. Default: admit as given. */
	readonly admission?: MemoryAdmission | undefined;
	/** Scopes a conversation reads and may write, in order. The first is the default write scope. */
	readonly scopes: (input: { readonly conversationId: string }) => readonly string[] | Promise<readonly string[]>;
	/** Wake budget across scopes. Default 96, split equally, with a floor of 8 per scope. */
	readonly maxItems?: number | undefined;
	/** After a note: "task" runs a durable Pi task (default), "inline" awaits `compact()` in the tool, "none" leaves it to the host, such as a Durable Object alarm. */
	readonly compaction?: "task" | "inline" | "none" | undefined;
	/** Extension name. Default "memory". */
	readonly name?: string | undefined;
}

const DEFAULT_MAX_ITEMS = 96;
const MIN_ITEMS_PER_SCOPE = 8;

const ADMIT_AS_GIVEN: MemoryAdmission = { evaluate: () => ({ admit: true }) };

const INSTRUCTIONS =
	"Long-term memory, kept across sessions, oldest first per scope. " +
	"Remember with memory_note: durable preferences, decisions, facts likely useful in future sessions, outcomes, lessons. " +
	"Do not remember greetings, transient execution details, routine tool output, or anything already remembered. " +
	"One line per memory, under 280 bytes. " +
	"A #a-b line summarizes memories a through b: use memory_recall for exact old facts and memory_zoom on a #a-b line to open it.";

/** The conversation cannot use the requested scope: it is not one of its scopes, or it has none. */
class UnknownScope extends Error {
	override readonly name = "UnknownScope";
}

const text = (value: string, isError = false): ToolExecutionResult => ({ content: [{ type: "text", text: value }], isError });

/** The scope a call targets: the requested one when allowed, else the first. */
function selectScope(scopes: readonly string[], requested: string | undefined): string {
	const fallback = scopes[0];
	if (fallback === undefined) throw new UnknownScope("This conversation has no memory scopes.");
	if (requested === undefined) return fallback;
	if (!scopes.includes(requested)) throw new UnknownScope(`Unknown scope "${requested}". Allowed scopes: ${scopes.join(", ")}.`);
	return requested;
}

const isToolError = (error: unknown): error is Error =>
	error instanceof MemoryEntryTooLong || error instanceof MemoryEntryEmpty || error instanceof InvalidRange || error instanceof UnknownScope;

/** Errors the model can act on become error results; anything else is a bug and propagates. */
function toolBoundary<P extends TSchema>(tool: ToolRegistration<P>): ToolRegistration<P> {
	return {
		...tool,
		async execute(args, api, context) {
			try {
				return await tool.execute(args, api, context);
			} catch (error) {
				if (isToolError(error)) return text(error.message, true);
				throw error;
			}
		},
	};
}

const renderScope = (scope: string, body: string): string => `[${scope}]\n${body}`;

export function createPiMemoryExtension(options: PiMemoryExtensionOptions): Extension {
	const name = options.name ?? "memory";
	const admission = options.admission ?? ADMIT_AS_GIVEN;
	const compaction = options.compaction ?? "task";
	const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
	const compactionTask = createMemoryCompactionTask(options.memory, name);
	const scopesOf = (conversationId: number): Promise<readonly string[]> =>
		Promise.resolve(options.scopes({ conversationId: String(conversationId) }));

	const memorySection = section("memory", async (input) => {
		const scopes = await scopesOf(input.conversationId);
		if (scopes.length === 0) return undefined;
		const perScope = Math.max(MIN_ITEMS_PER_SCOPE, Math.floor(maxItems / scopes.length));
		const blocks = await Promise.all(
			scopes.map(async (scope) => {
				const context = await (await options.memory(scope)).wake({ maxItems: perScope });
				return renderScope(scope, context.items.length === 0 ? "(no memories yet)" : formatMemoryContext(context));
			}),
		);
		return `${INSTRUCTIONS}\n\n${blocks.join("\n\n")}`;
	});

	const note = toolBoundary(
		defineTool({
			name: "memory_note",
			description:
				"Save one durable memory for future sessions: a preference, decision, fact, outcome, or lesson. Not greetings, transient execution details, routine tool output, or anything already remembered. One line, under 280 bytes.",
			parameters: Type.Object({
				content: Type.String({ description: "The memory, one line" }),
				scope: Type.Optional(Type.String({ description: "Target scope; default is the first scope" })),
			}),
			replay: "safe",
			execute: async (args, api, context) => {
				const scopes = await scopesOf(api.conversationId);
				const requested = selectScope(scopes, args.scope);
				const decision = await admission.evaluate({ content: args.content, scope: requested, scopes, conversationId: String(api.conversationId) });
				if (!decision.admit) return text(`Not saved: ${decision.reason}`);
				const scope = selectScope(scopes, decision.scope ?? requested);
				const memory = await options.memory(scope);
				const { id } = await memory.note({ content: decision.content ?? args.content, sourceId: String(api.taskId) });
				switch (compaction) {
					case "task":
						await api.createTask(compactionTask, { scope }, { ownership: { kind: "conversation" }, background: true }, context);
						break;
					case "inline":
						await memory.compact();
						break;
					case "none":
						break;
					default: {
						const exhaustive: never = compaction;
						throw new Error(`Unknown compaction mode ${String(exhaustive)}`);
					}
				}
				return text(`Saved as #${id} in ${scope}.`);
			},
		}),
	);

	const recall = toolBoundary(
		defineTool({
			name: "memory_recall",
			description: "Search memories by words for an exact old fact; newest matches first. Omit scope to search every scope.",
			parameters: Type.Object({
				query: Type.String(),
				scope: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Number({ description: "Matches per scope; default 10" })),
			}),
			replay: "safe",
			execute: async (args, api) => {
				const allowed = await scopesOf(api.conversationId);
				const searched = args.scope === undefined ? allowed : [selectScope(allowed, args.scope)];
				const blocks = await Promise.all(
					searched.map(async (scope) => {
						const hits = await (await options.memory(scope)).recall(args.query, { limit: args.limit });
						if (hits.length === 0) return undefined;
						const lines = hits.map((hit) => `#${hit.id} ${hit.content}`).join("\n");
						return searched.length > 1 ? renderScope(scope, lines) : lines;
					}),
				);
				const found = blocks.filter((block) => block !== undefined);
				return text(found.length === 0 ? "No match." : found.join("\n\n"));
			},
		}),
	);

	const zoom = toolBoundary(
		defineTool({
			name: "memory_zoom",
			description: "Open a summary line #a-b into its two halves, each a summary or the raw memories. The range must be an aligned power-of-two block, like #16-31.",
			parameters: Type.Object({
				startId: Type.Number(),
				endId: Type.Number(),
				scope: Type.Optional(Type.String()),
			}),
			replay: "safe",
			execute: async (args, api) => {
				const scope = selectScope(await scopesOf(api.conversationId), args.scope);
				return text(formatMemoryItems(await (await options.memory(scope)).zoom({ startId: args.startId, endId: args.endId })));
			},
		}),
	);

	return defineExtension({
		name,
		sections: [memorySection],
		tools: [note, recall, zoom],
		tasks: [compactionTask],
	});
}
