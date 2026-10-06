import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { Extension, ToolExecutionResult } from "@earendil-works/pi-durable";
import { InvalidRange, MemoryEntryEmpty, MemoryEntryTooLong } from "../core/errors.js";
import { formatMemoryContext, formatMemoryItems } from "../core/format.js";
import { createMemoryCompactionTask } from "./compaction-task.js";
import type { MemoryResolver } from "./compaction-task.js";

export interface PiMemoryExtensionOptions {
	/** The memory for one scope. Called per request and per tool call; implementations should be cheap or cache. */
	readonly memory: MemoryResolver;
	/** Scopes a conversation reads and may write, in order. The first is the default write scope. */
	readonly scopes: (input: { readonly conversationId: string }) => readonly string[] | Promise<readonly string[]>;
	/** Wake budget across scopes. Default 96, split equally, with a floor of 8 per scope. */
	readonly maxItems?: number;
	/** After a note: "task" runs a durable Pi task (default), "inline" awaits `compact()` in the tool, "none" leaves it to the host, such as a Durable Object alarm. */
	readonly compaction?: "task" | "inline" | "none";
	/** Extension name. Default "memory". */
	readonly name?: string;
}

const DEFAULT_MAX_ITEMS = 96;
const MIN_ITEMS_PER_SCOPE = 8;

const INSTRUCTIONS =
	"Long-term memory, kept across sessions, oldest first per scope. " +
	"Remember with memory_note: durable preferences, decisions, facts likely useful in future sessions, outcomes, lessons. " +
	"Do not remember greetings, transient execution details, routine tool output, or anything already remembered. " +
	"One line per memory, under 280 bytes. " +
	"A #a-b line summarizes memories a through b: use memory_recall for exact old facts and memory_zoom on a #a-b line to open it.";

const text = (value: string, isError = false): ToolExecutionResult => ({ content: [{ type: "text", text: value }], isError });

const noScopes = (): ToolExecutionResult => text("This conversation has no memory scopes.", true);

const unknownScope = (scope: string, scopes: readonly string[]): ToolExecutionResult =>
	text(`Unknown scope "${scope}". Allowed scopes: ${scopes.join(", ")}.`, true);

/** The scope a call targets: the requested one when allowed, else the first, else an error result. */
function selectScope(scopes: readonly string[], requested: string | undefined): string | ToolExecutionResult {
	const fallback = scopes[0];
	if (fallback === undefined) return noScopes();
	if (requested === undefined) return fallback;
	return scopes.includes(requested) ? requested : unknownScope(requested, scopes);
}

const renderScope = (scope: string, body: string): string => `[${scope}]\n${body}`;

export function createPiMemoryExtension(options: PiMemoryExtensionOptions): Extension {
	const compaction = options.compaction ?? "task";
	const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
	const compactionTask = createMemoryCompactionTask(options.memory);
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

	const note = defineTool({
		name: "memory_note",
		description:
			"Save one durable memory for future sessions: a preference, decision, fact, outcome, or lesson. Not greetings, transient execution details, routine tool output, or anything already remembered. One line, under 280 bytes.",
		parameters: Type.Object({
			content: Type.String({ description: "The memory, one line" }),
			scope: Type.Optional(Type.String({ description: "Target scope; default is the first scope" })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const scope = selectScope(await scopesOf(api.conversationId), args.scope);
			if (typeof scope !== "string") return scope;
			const memory = await options.memory(scope);
			let id: number;
			try {
				({ id } = await memory.note({ content: args.content, sourceId: String(api.taskId) }));
			} catch (error) {
				if (error instanceof MemoryEntryTooLong || error instanceof MemoryEntryEmpty) return text(error.message, true);
				throw error;
			}
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
	});

	const recall = defineTool({
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
			const scope = selectScope(allowed, args.scope);
			if (typeof scope !== "string") return scope;
			const searched = args.scope === undefined ? allowed : [scope];
			const blocks: string[] = [];
			for (const name of searched) {
				const hits = await (await options.memory(name)).recall(args.query, args.limit === undefined ? {} : { limit: args.limit });
				if (hits.length === 0) continue;
				const lines = hits.map((hit) => `#${hit.id} ${hit.content}`).join("\n");
				blocks.push(searched.length > 1 ? renderScope(name, lines) : lines);
			}
			return text(blocks.length === 0 ? "No match." : blocks.join("\n\n"));
		},
	});

	const zoom = defineTool({
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
			if (typeof scope !== "string") return scope;
			try {
				return text(formatMemoryItems(await (await options.memory(scope)).zoom({ startId: args.startId, endId: args.endId })));
			} catch (error) {
				if (error instanceof InvalidRange) return text(error.message, true);
				throw error;
			}
		},
	});

	return defineExtension({
		name: options.name ?? "memory",
		sections: [memorySection],
		tools: [note, recall, zoom],
		tasks: [compactionTask],
	});
}
