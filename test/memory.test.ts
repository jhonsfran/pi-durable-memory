import { describe, expect, it } from "vitest";
import { InvalidRange, MemoryEntryEmpty, MemoryEntryTooLong, formatMemoryContext } from "../src/index.js";
import type { MemoryItem, MemoryNode, MemoryRange, MemoryStore } from "../src/index.js";
import { constantSummarizer, joinSummarizer, noteMany, openFixture, seedMemoriesBySql } from "./helpers.js";

const size = (range: MemoryRange): number => range.endId - range.startId + 1;

/** What `joinSummarizer` must have produced for a node, from the store's own view of its children. */
async function expectedSummary(store: MemoryStore, node: MemoryNode): Promise<string> {
	if (size(node) <= 16) {
		const entries = await store.getMemories(node);
		return `[${entries.map((entry) => entry.content).join(" ")}]`;
	}
	const half = size(node) / 2;
	const children = await store.getNodes([
		{ level: node.level - 1, startId: node.startId },
		{ level: node.level - 1, startId: node.startId + half },
	]);
	const left = children.find((child) => child.startId === node.startId)!;
	const right = children.find((child) => child.startId === node.startId + half)!;
	return `[${left.summary} ${right.summary}]`;
}

async function allNodes(store: MemoryStore, total: number): Promise<MemoryNode[]> {
	const keys: { level: number; startId: number }[] = [];
	for (let level = 1; 2 ** level <= total; level++) {
		for (let k = 0; k < Math.floor(total / 2 ** level); k++) keys.push({ level, startId: k * 2 ** level });
	}
	return store.getNodes(keys);
}

describe("memory", () => {
	it("notes with sourceIds, compacts, wakes with both memories and recalls the second", async () => {
		const { memory } = await openFixture();
		await memory.note({ content: "Pi Durable runs agents as durable workflows", sourceId: "task-1", createdAt: 1 });
		await memory.note({ content: "Memory lives in a Cloudflare Durable Object", sourceId: "task-2", createdAt: 2 });
		expect(await memory.compact()).toEqual({ merged: 1, pending: 0 });
		expect(await memory.wake()).toEqual({
			total: 2,
			items: [
				{ type: "memory", id: 0, createdAt: 1, content: "Pi Durable runs agents as durable workflows" },
				{ type: "memory", id: 1, createdAt: 2, content: "Memory lives in a Cloudflare Durable Object" },
			],
		});
		expect(await memory.recall("Cloudflare")).toEqual([{ id: 1, createdAt: 2, content: "Memory lives in a Cloudflare Durable Object", sourceId: "task-2" }]);
	});

	it("treats sourceId as an idempotency key and appends freely without one", async () => {
		const { memory, store } = await openFixture();
		const first = await memory.note({ content: "once", sourceId: "s1", createdAt: 5 });
		const again = await memory.note({ content: "once again", sourceId: "s1", createdAt: 6 });
		expect(again).toEqual(first);
		expect(again).toEqual({ id: 0, createdAt: 5, content: "once", sourceId: "s1" });
		expect(await store.count()).toBe(1);
		expect((await memory.note({ content: "twice", sourceId: "s2", createdAt: 7 })).id).toBe(1);
		expect((await memory.note({ content: "free", createdAt: 8 })).id).toBe(2);
		expect((await memory.note({ content: "free", createdAt: 9 })).id).toBe(3);
		expect(await store.count()).toBe(4);
	});

	it("rejects empty and oversized notes and collapses line breaks", async () => {
		const { memory } = await openFixture();
		await expect(memory.note({ content: "  \n\t " })).rejects.toThrow(MemoryEntryEmpty);
		await expect(memory.note({ content: "é".repeat(141) })).rejects.toThrow(new MemoryEntryTooLong(282, 280));
		expect((await memory.note({ content: "a".repeat(280), createdAt: 1 })).content).toBe("a".repeat(280));
		expect((await memory.note({ content: "  first line \n\n   second line\r\n", createdAt: 2 })).content).toBe("first line second line");
	});

	it("builds every node from its raw memories up to 16 and from its two children above", async () => {
		const { memory, store } = await openFixture({ limits: { maxEntryBytes: 8192 } });
		await noteMany(memory, 1000);
		expect(await memory.compact()).toEqual({ merged: 994, pending: 0 });
		const nodes = await allNodes(store, 1000);
		expect(nodes.length).toBe(994);
		const byKey = new Map(nodes.map((node) => [`${node.level}:${node.startId}`, node.summary]));
		expect(byKey.get("1:0")).toBe("[m0 m1]");
		expect(byKey.get("4:16")).toBe("[m16 m17 m18 m19 m20 m21 m22 m23 m24 m25 m26 m27 m28 m29 m30 m31]");
		expect(byKey.get("5:0")).toBe(`[${byKey.get("4:0")} ${byKey.get("4:16")}]`);
		for (const node of nodes) {
			expect(node.startId % size(node)).toBe(0);
			expect(size(node)).toBe(2 ** node.level);
			expect(node.summary).toBe(await expectedSummary(store, node));
		}
	});

	it("wakes with at most 96 items that tile the whole log and end on the newest memory", async () => {
		const { memory } = await openFixture({ limits: { maxEntryBytes: 8192 } });
		await noteMany(memory, 1000);
		await memory.compact();
		const { items, total } = await memory.wake();
		expect(total).toBe(1000);
		expect(items.length).toBe(96);
		expect(items[0]).toEqual({ type: "summary", startId: 0, endId: 63, content: expect.stringMatching(/^\[\[\[.*m63\]\]\]$/) });
		expect(items[items.length - 1]).toEqual({ type: "memory", id: 999, createdAt: 1_700_000_000_999, content: "m999" });
		let next = 0;
		for (const item of items) {
			const range = item.type === "memory" ? { startId: item.id, endId: item.id } : item;
			expect(item.type).not.toBe("pending");
			expect(range.startId).toBe(next);
			next = range.endId + 1;
		}
		expect(next).toBe(1000);
	});

	it("wakes 100k memories with one read per kind and at most 96 rows", async () => {
		const calls: Record<string, number> = {};
		let rows = 0;
		const scope = "big";
		const counting = (store: MemoryStore): MemoryStore =>
			new Proxy(store, {
				get(target, method: keyof MemoryStore) {
					return async (...args: unknown[]) => {
						calls[method] = (calls[method] ?? 0) + 1;
						const result = await (target[method] as (...a: unknown[]) => Promise<unknown>)(...args);
						if (Array.isArray(result)) rows += result.length;
						return result;
					};
				},
			});
		const { db, memory } = await openFixture({ scope, store: counting, summarizer: constantSummarizer });
		const started = performance.now();
		await seedMemoriesBySql(db, scope, 100_000);
		expect(await memory.compact()).toEqual({ merged: 99_994, pending: 0 });
		const seeded = performance.now();
		Object.keys(calls).forEach((key) => delete calls[key]);
		rows = 0;
		const { items, total } = await memory.wake();
		const woke = performance.now();
		console.log(`100k: seed+compact ${Math.round(seeded - started)}ms, wake ${Math.round(woke - seeded)}ms`);
		expect(total).toBe(100_000);
		expect(items.length).toBe(96);
		expect(items[0]).toEqual({ type: "summary", startId: 0, endId: 8191, content: "x" });
		expect(items[95]).toEqual({ type: "memory", id: 99_999, createdAt: 99_999, content: "m99999" });
		expect(calls).toEqual({ count: 1, getMemories: 1, getNodes: 1 });
		expect(rows).toBeLessThanOrEqual(96);
		expect(woke - seeded).toBeLessThan(1000);
	});

	it("wakes with pending blocks before compaction and none after", async () => {
		const { memory } = await openFixture();
		await noteMany(memory, 100);
		const before = await memory.wake();
		expect(before.items.length).toBe(96);
		expect(before.items.slice(0, 5)).toEqual([
			{ type: "pending", startId: 0, endId: 1 },
			{ type: "pending", startId: 2, endId: 3 },
			{ type: "pending", startId: 4, endId: 5 },
			{ type: "pending", startId: 6, endId: 7 },
			{ type: "memory", id: 8, createdAt: 1_700_000_000_008, content: "m8" },
		]);
		expect(formatMemoryContext(before).split("\n").slice(0, 5)).toEqual(["#0-1 (not summarized yet)", "#2-3 (not summarized yet)", "#4-5 (not summarized yet)", "#6-7 (not summarized yet)", "#8 m8"]);
		await memory.compact();
		const after = await memory.wake();
		expect(after.items.length).toBe(96);
		expect(after.items.slice(0, 5)).toEqual([
			{ type: "summary", startId: 0, endId: 1, content: "[m0 m1]" },
			{ type: "summary", startId: 2, endId: 3, content: "[m2 m3]" },
			{ type: "summary", startId: 4, endId: 5, content: "[m4 m5]" },
			{ type: "summary", startId: 6, endId: 7, content: "[m6 m7]" },
			{ type: "memory", id: 8, createdAt: 1_700_000_000_008, content: "m8" },
		]);
		expect(after.items.filter((item) => item.type === "pending")).toEqual([]);
	});

	it("zooms from the root block down to memory 0 and rejects ranges that are not blocks", async () => {
		const { memory } = await openFixture({ limits: { maxEntryBytes: 8192 } });
		await noteMany(memory, 1000);
		await memory.compact();
		const root = await memory.zoom({ startId: 0, endId: 511 });
		expect(root.map((item) => (item.type === "summary" ? [item.startId, item.endId] : item.type))).toEqual([[0, 255], [256, 511]]);
		let range: MemoryRange = { startId: 0, endId: 511 };
		let steps = 0;
		let first: MemoryItem | undefined;
		while (steps < 10) {
			first = (await memory.zoom(range))[0];
			steps++;
			if (first?.type !== "summary") break;
			range = first;
		}
		expect(steps).toBe(9);
		expect(first).toEqual({ type: "memory", id: 0, createdAt: 1_700_000_000_000, content: "m0" });
		expect(await memory.zoom({ startId: 998, endId: 999 })).toEqual([
			{ type: "memory", id: 998, createdAt: 1_700_000_000_998, content: "m998" },
			{ type: "memory", id: 999, createdAt: 1_700_000_000_999, content: "m999" },
		]);
		expect(await memory.zoom({ startId: 992, endId: 1007 })).toEqual([{ type: "summary", startId: 992, endId: 999, content: "[m992 m993 m994 m995 m996 m997 m998 m999]" }]);
		expect(await memory.zoom({ startId: 512, endId: 1023 })).toEqual([
			{ type: "summary", startId: 512, endId: 767, content: expect.stringMatching(/^\[\[.*\]\]$/) },
			{ type: "pending", startId: 768, endId: 1023 },
		]);
		await expect(memory.zoom({ startId: 1, endId: 2 })).rejects.toThrow(InvalidRange);
		await expect(memory.zoom({ startId: 4, endId: 4 })).rejects.toThrow(InvalidRange);
		await expect(memory.zoom({ startId: 0, endId: 2 })).rejects.toThrow(InvalidRange);
		await expect(memory.zoom({ startId: 1000, endId: 1001 })).rejects.toThrow(InvalidRange);
	});

	it("forgets a node and its ancestors, keeps the raw memories, and rebuilds the same summary", async () => {
		const { memory, store } = await openFixture();
		await noteMany(memory, 8);
		await memory.compact();
		const before = await store.getNodes([{ level: 1, startId: 2 }, { level: 2, startId: 0 }, { level: 3, startId: 0 }]);
		expect(before.map((node) => node.summary)).toEqual(["[m2 m3]", "[m0 m1 m2 m3]", "[m0 m1 m2 m3 m4 m5 m6 m7]"]);
		expect(await memory.forget({ startId: 2, endId: 3 })).toBe(6);
		expect(await store.getNodes([{ level: 1, startId: 2 }, { level: 2, startId: 0 }, { level: 3, startId: 0 }])).toEqual([]);
		expect((await store.getNodes([{ level: 1, startId: 0 }])).map((node) => node.summary)).toEqual(["[m0 m1]"]);
		expect(await store.getMemories({ startId: 0, endId: 7 })).toHaveLength(8);
		expect((await store.getMemories({ startId: 2, endId: 3 })).map((entry) => entry.content)).toEqual(["m2", "m3"]);
		expect(await memory.pending()).toBe(6);
		expect(await memory.compact()).toEqual({ merged: 6, pending: 0 });
		const after = await store.getNodes([{ level: 1, startId: 2 }, { level: 2, startId: 0 }, { level: 3, startId: 0 }]);
		expect(after).toEqual(before);
	});

	it("stops after maxMerges and reports what is still pending", async () => {
		const { memory, store } = await openFixture();
		await noteMany(memory, 8);
		expect(await memory.pending()).toBe(7);
		expect(await memory.compact({ maxMerges: 1 })).toEqual({ merged: 1, pending: 6 });
		expect(await store.getNodes([{ level: 1, startId: 0 }, { level: 1, startId: 2 }])).toEqual([{ level: 1, startId: 0, endId: 1, summary: "[m0 m1]" }]);
		expect(await memory.compact({ maxMerges: 3 })).toEqual({ merged: 3, pending: 3 });
		expect(await memory.compact()).toEqual({ merged: 3, pending: 0 });
	});

	it("supersedes an older memory: hidden from wake, zoom and the summarizer, still in the store", async () => {
		const { memory, store } = await openFixture();
		await memory.note({ content: "prefers brevity", createdAt: 1 });
		expect(await memory.note({ content: "prefers detail", supersedes: 0, createdAt: 2 })).toEqual({ id: 1, createdAt: 2, content: "prefers detail", supersedes: 0 });
		expect(await memory.wake()).toEqual({ total: 2, items: [{ type: "memory", id: 1, createdAt: 2, content: "prefers detail" }] });
		expect(formatMemoryContext(await memory.wake())).toBe("#1 prefers detail");
		expect(await store.getMemories({ startId: 0, endId: 1 })).toEqual([
			{ id: 0, createdAt: 1, content: "prefers brevity", supersededBy: 1 },
			{ id: 1, createdAt: 2, content: "prefers detail", supersedes: 0 },
		]);
		expect(await memory.compact()).toEqual({ merged: 1, pending: 0 });
		expect(await store.getNodes([{ level: 1, startId: 0 }])).toEqual([{ level: 1, startId: 0, endId: 1, summary: "[prefers detail]" }]);
		expect(await memory.zoom({ startId: 0, endId: 1 })).toEqual([{ type: "memory", id: 1, createdAt: 2, content: "prefers detail" }]);
		expect(await memory.recall("prefers")).toEqual([{ id: 1, createdAt: 2, content: "prefers detail", supersedes: 0 }]);
		await expect(memory.note({ content: "prefers tables", supersedes: 7 })).rejects.toThrow(new InvalidRange("#7 is not in the memory: it holds 2 memories"));
		expect(await store.count()).toBe(2);
	});

	it("summarizes a block whose every memory was superseded with a fixed line instead of calling the summarizer", async () => {
		const { memory, store } = await openFixture({
			summarizer: { async summarize({ items }) { if (items.length === 0) throw new Error("summarizer called with no items"); return joinSummarizer.summarize({ startId: 0, endId: 0, items, maxBytes: 280 }); } },
		});
		await memory.note({ content: "prefers brevity", createdAt: 1 });
		await memory.note({ content: "prefers detail", supersedes: 0, createdAt: 2 });
		await memory.note({ content: "prefers tables", supersedes: 1, createdAt: 3 });
		expect(await memory.compact()).toEqual({ merged: 1, pending: 0 });
		expect(await store.getNodes([{ level: 1, startId: 0 }])).toEqual([
			{ level: 1, startId: 0, endId: 1, summary: "(every memory in this block was superseded)" },
		]);
		expect(formatMemoryContext(await memory.wake({ maxItems: 2 }))).toBe("#0-1 (every memory in this block was superseded)\n#2 prefers tables");
	});

	it("normalizes and truncates summaries on a character boundary", async () => {
		const { memory, store } = await openFixture({
			summarizer: { async summarize() { return `  line one\n line two ${"é".repeat(200)}`; } },
		});
		await noteMany(memory, 2);
		await memory.compact();
		const [node] = await store.getNodes([{ level: 1, startId: 0 }]);
		expect(node?.summary).toBe(`line one line two ${"é".repeat(131)}`);
		expect(new TextEncoder().encode(node!.summary).length).toBe(280);
	});
});
