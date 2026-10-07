import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import type { Conversation } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createMemory } from "../src/index.js";
import type { Memory } from "../src/index.js";
import { createPiMemoryExtension } from "../src/pi/index.js";
import type { MemoryAdmission, PiMemoryExtensionOptions } from "../src/pi/index.js";
import { createSqliteMemoryStore } from "../src/sqlite/index.js";
import { openNodeSqlite } from "../src/sqlite/node.js";
import { joinSummarizer } from "./helpers.js";

const context = BACKGROUND_CONTEXT;
const SCOPES = ["agent:a", "project:x"] as const;

const INSTRUCTIONS =
	"Long-term memory, kept across sessions, oldest first per scope. " +
	"Remember with memory_note: durable preferences, decisions, facts likely useful in future sessions, outcomes, lessons. " +
	"Do not remember greetings, transient execution details, routine tool output, or anything already remembered. " +
	"One line per memory, under 280 bytes. " +
	"A #a-b line summarizes memories a through b: use memory_recall for exact old facts and memory_zoom on a #a-b line to open it.";

/** One SQLite database shared by every scope, with one `Memory` instance per scope so tool calls and assertions see the same log. */
function scopedMemories() {
	const db = openNodeSqlite(":memory:");
	const memories = new Map<string, Promise<Memory>>();
	const memory: PiMemoryExtensionOptions["memory"] = (scope) => {
		let pending = memories.get(scope);
		if (pending === undefined) {
			pending = createSqliteMemoryStore(db, { scope }).then((store) => createMemory({ store, summarizer: joinSummarizer }));
			memories.set(scope, pending);
		}
		return pending;
	};
	return memory;
}

async function openHarness(options: Partial<PiMemoryExtensionOptions> = {}) {
	const memory = scopedMemories();
	const extension = createPiMemoryExtension({ memory, scopes: () => SCOPES, ...options });
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(extension);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	return { memory, extension, faux, harness, root };
}

/** Submit one input and run the faux script to its end. */
async function run(root: Conversation, faux: ReturnType<typeof fauxProvider>, responses: AssistantMessage[], input = "go") {
	faux.setResponses(responses);
	await (await root.submit({ type: "input", content: input }, context)).wait(context);
}

const toolCall = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function toolResults(root: Conversation): Promise<{ text: string; isError: boolean }[]> {
	const { messages } = await root.context(context);
	return messages.flatMap((message) =>
		message.role === "toolResult"
			? [{ text: message.content.map((part) => (part.type === "text" ? part.text : "<image>")).join(""), isError: message.isError }]
			: [],
	);
}

async function memorySection(root: Conversation): Promise<string | null | undefined> {
	const { messages } = await root.context(context);
	const system = messages.find((message) => message.role === "system");
	return system?.sections?.memory;
}

/** Settle every live compaction task; background tasks are outside `wait()` and `waitForIdle()`. */
async function settleCompaction(harness: Harness): Promise<void> {
	const { tasks } = await harness.inspect(context);
	for (const task of tasks) {
		if (task.record.kind === "memory.compact") await harness.waitForTask(task.record.id, context);
	}
}

describe("pi extension", () => {
	it("renders the instruction paragraph and one wake per scope in the memory section", async () => {
		const { memory, faux, root, harness } = await openHarness();
		const a = await memory("agent:a");
		await a.note({ content: "User prefers concise answers.", createdAt: 1 });
		await a.note({ content: "Project builds with pnpm.", createdAt: 2 });
		await run(root, faux, [fauxAssistantMessage("ok")]);
		expect(await memorySection(root)).toBe(
			`<memory>\n${INSTRUCTIONS}\n\n[agent:a]\n#0 User prefers concise answers.\n#1 Project builds with pnpm.\n\n[project:x]\n(no memories yet)\n</memory>`,
		);
		await harness.close(context);
	});

	it("memory_note writes to the first scope with the tool task as its sourceId", async () => {
		const { memory, faux, root, harness } = await openHarness({ compaction: "none" });
		await run(root, faux, [toolCall("memory_note", { content: "User prefers concise answers." }), fauxAssistantMessage("Noted.")]);
		expect(await toolResults(root)).toEqual([{ text: "Saved as #0 in agent:a.", isError: false }]);
		const a = await memory("agent:a");
		expect((await a.wake()).items).toEqual([{ type: "memory", id: 0, createdAt: expect.any(Number), content: "User prefers concise answers." }]);
		const [entry] = await a.recall("concise");
		const taskId = Number(entry?.sourceId);
		const task = await harness.getTask(taskId as Parameters<Harness["getTask"]>[0], context);
		expect(task?.kind).toBe("pi.tool");
		expect(task?.conversationId).toBe(root.id);
		await harness.close(context);
	});

	it("runs the compaction task after a note", async () => {
		const { memory, faux, root, harness } = await openHarness({ compaction: "task" });
		await run(root, faux, [
			toolCall("memory_note", { content: "m0" }),
			toolCall("memory_note", { content: "m1" }),
			toolCall("memory_note", { content: "m2" }),
			fauxAssistantMessage("Done."),
		]);
		await settleCompaction(harness);
		const a = await memory("agent:a");
		expect(await a.pending()).toBe(0);
		expect((await a.wake({ maxItems: 2 })).items).toEqual([
			{ type: "summary", startId: 0, endId: 1, content: "[m0 m1]" },
			{ type: "memory", id: 2, createdAt: expect.any(Number), content: "m2" },
		]);
		await harness.close(context);
	});

	it("rejects a scope the conversation does not have and writes nothing", async () => {
		const { memory, faux, root, harness } = await openHarness({ compaction: "none" });
		await run(root, faux, [toolCall("memory_note", { content: "secret", scope: "company:z" }), fauxAssistantMessage("Sorry.")]);
		expect(await toolResults(root)).toEqual([{ text: 'Unknown scope "company:z". Allowed scopes: agent:a, project:x.', isError: true }]);
		expect((await (await memory("agent:a")).wake()).total).toBe(0);
		expect((await (await memory("project:x")).wake()).total).toBe(0);
		await harness.close(context);
	});

	it("memory_recall finds by words and memory_zoom opens a block", async () => {
		const { memory, faux, root, harness } = await openHarness({ compaction: "none" });
		const a = await memory("agent:a");
		for (let id = 0; id < 8; id++) await a.note({ content: `fact ${["zero", "one", "two", "three", "four", "five", "six", "seven"][id]}`, createdAt: id });
		await a.compact();
		await run(root, faux, [
			toolCall("memory_recall", { query: "seven", scope: "agent:a" }),
			toolCall("memory_zoom", { startId: 0, endId: 7 }),
			toolCall("memory_zoom", { startId: 1, endId: 2 }),
			fauxAssistantMessage("Done."),
		]);
		expect(await toolResults(root)).toEqual([
			{ text: "#7 fact seven", isError: false },
			{ text: "#0-3 [fact zero fact one fact two fact three]\n#4-7 [fact four fact five fact six fact seven]", isError: false },
			{ text: "#1-2 is not a block: use an aligned power-of-two range of at least 2 memories, like #16-31", isError: true },
		]);
		await harness.close(context);
	});

	it("memory_recall searches every scope with headers when no scope is given", async () => {
		const { memory, faux, root, harness } = await openHarness({ compaction: "none" });
		await (await memory("agent:a")).note({ content: "likes tabs", createdAt: 1 });
		await (await memory("project:x")).note({ content: "tabs not spaces", createdAt: 2 });
		await run(root, faux, [toolCall("memory_recall", { query: "tabs" }), toolCall("memory_recall", { query: "nothing" }), fauxAssistantMessage("Done.")]);
		expect(await toolResults(root)).toEqual([
			{ text: "[agent:a]\n#0 likes tabs\n\n[project:x]\n#0 tabs not spaces", isError: false },
			{ text: "No match.", isError: false },
		]);
		await harness.close(context);
	});

	it("memory_note returns the admission reason and writes nothing when admission rejects", async () => {
		const admission: MemoryAdmission = {
			evaluate: ({ content }) => (content.includes("hello") ? { admit: false, reason: "greetings are not memories." } : { admit: true }),
		};
		const { memory, faux, root, harness } = await openHarness({ compaction: "none", admission });
		await run(root, faux, [toolCall("memory_note", { content: "hello there" }), fauxAssistantMessage("Ok.")]);
		expect(await toolResults(root)).toEqual([{ text: "Not saved: greetings are not memories.", isError: false }]);
		expect((await (await memory("agent:a")).wake()).total).toBe(0);
		await harness.close(context);
	});

	it("memory_note stores the content and scope an admission rewrites", async () => {
		const admission: MemoryAdmission = {
			evaluate: ({ content }) => ({ admit: true, content: content.toUpperCase(), scope: "project:x" }),
		};
		const { memory, faux, root, harness } = await openHarness({ compaction: "none", admission });
		await run(root, faux, [toolCall("memory_note", { content: "deploys go through ci" }), fauxAssistantMessage("Ok.")]);
		expect(await toolResults(root)).toEqual([{ text: "Saved as #0 in project:x.", isError: false }]);
		expect((await (await memory("project:x")).wake()).items).toEqual([
			{ type: "memory", id: 0, createdAt: expect.any(Number), content: "DEPLOYS GO THROUGH CI" },
		]);
		expect((await (await memory("agent:a")).wake()).total).toBe(0);
		await harness.close(context);
	});

	it("returns the length error for a note over 280 bytes and writes nothing", async () => {
		const { memory, faux, root, harness } = await openHarness({ compaction: "none" });
		await run(root, faux, [toolCall("memory_note", { content: "x".repeat(300) }), fauxAssistantMessage("Shorter.")]);
		expect(await toolResults(root)).toEqual([
			{ text: "Too long: 300 bytes, limit 280. Accented characters cost 2 bytes or more", isError: true },
		]);
		expect((await (await memory("agent:a")).wake()).total).toBe(0);
		await harness.close(context);
	});
});
