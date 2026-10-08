import { McpServer } from "@modelcontextprotocol/server";
import type { Memory, MemoryItem } from "pi-durable-memory";
import { z } from "zod";

const INSTRUCTIONS =
	"Long-term memory, kept across sessions. " +
	"Call memory_wake at the start of every session and read it: one line per memory, oldest first. A #a-b line summarizes memories a through b. " +
	"Remember with memory_note: durable preferences, decisions, facts likely useful in future sessions, outcomes, lessons. " +
	"Do not remember greetings, transient execution details, routine tool output, or anything already remembered. " +
	"One line per memory, under 280 bytes. " +
	"After memory_note, call memory_pending. While it returns a block, write the line it asks for and store it with memory_commit before you continue. " +
	"Use memory_recall for exact old facts and memory_zoom on a #a-b line to open it. " +
	"Zoom whenever a line only mentions something you need, before you act, guess or ask.";

const line = (item: MemoryItem): string => (item.type === "memory" ? `#${item.id} ${item.content}` : `#${item.startId}-${item.endId} ${item.content}`);

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export function createMemoryServer(memory: Memory): McpServer {
	const server = new McpServer({ name: "memory", version: "0.1.0" }, { instructions: INSTRUCTIONS });

	server.registerTool(
		"memory_wake",
		{
			description: "Read the long-term memory, oldest first: one line per memory, and #a-b lines that summarize memories a through b. Call it at the start of every session.",
		},
		async () => {
			const { items } = await memory.wake();
			return text(items.length === 0 ? "No memories yet." : items.map(line).join("\n"));
		},
	);

	server.registerTool(
		"memory_note",
		{
			description:
				"Save one durable memory for future sessions: a preference, decision, fact, outcome, or lesson. Not greetings, transient execution details, routine tool output, or anything already remembered. One line, under 280 bytes.",
			inputSchema: z.object({
				content: z.string().describe("The memory, one line"),
				supersedes: z.number().int().optional().describe("Id of an older memory this one replaces; the older one leaves wake and recall"),
			}),
		},
		async ({ content, supersedes }) => {
			const { id } = await memory.note({ content, supersedes });
			return text(`Saved as #${id}.`);
		},
	);

	server.registerTool(
		"memory_recall",
		{
			description: "Search memories by words for an exact old fact; newest matches first.",
			inputSchema: z.object({
				query: z.string(),
				limit: z.number().int().positive().optional().describe("Matches; default 10"),
			}),
		},
		async ({ query, limit }) => {
			const hits = await memory.recall(query, { limit });
			return text(hits.length === 0 ? "No match." : hits.map((hit) => `#${hit.id} ${hit.content}`).join("\n"));
		},
	);

	server.registerTool(
		"memory_zoom",
		{
			description: "Open a summary line #a-b into its two halves, each a summary or the raw memories. The range must be an aligned power-of-two block, like #16-31.",
			inputSchema: z.object({ startId: z.number().int(), endId: z.number().int() }),
		},
		async ({ startId, endId }) => text((await memory.zoom({ startId, endId })).map(line).join("\n")),
	);

	server.registerTool(
		"memory_pending",
		{
			description: "The next block of memories to summarize, as a prompt to answer with one line through memory_commit. Says so when nothing is left.",
		},
		async () => {
			const job = await memory.nextMerge();
			if (job === undefined) return text("Nothing to summarize.");
			const blocks = job.request.turns.flatMap((turn) => (turn.role === "user" ? turn.blocks : [turn.text]));
			const ask = `Call memory_commit with startId ${job.startId}, endId ${job.endId}, and your line as summary.`;
			return text([job.request.system, ...blocks, ask].join("\n\n"));
		},
	);

	server.registerTool(
		"memory_commit",
		{
			description: "Store the one-line summary of the block memory_pending gave you. An empty line or one over the byte limit is refused with the reason; fix the line and call again.",
			inputSchema: z.object({ startId: z.number().int(), endId: z.number().int(), summary: z.string().describe("The line, nothing else") }),
		},
		async ({ startId, endId, summary }) => {
			const stored = await memory.commitMerge({ startId, endId }, summary);
			return text(
				stored
					? `Stored #${startId}-${endId}. Call memory_pending for the next block.`
					: `Not stored: #${startId}-${endId} is summarized already or is not the next block. Call memory_pending for the next one.`,
			);
		},
	);

	return server;
}
