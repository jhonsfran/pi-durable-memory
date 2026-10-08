import { describe, expect, it } from "vitest";
import { InvalidRange, MemoryEntryEmpty, MemoryEntryTooLong, formatMemoryContext } from "../src/index.js";
import type { MemoryItem, MemoryRange, MemoryStore, MemorySummarizer, SummarizeInput } from "../src/index.js";
import { constantSummarizer, noteMany, openFixture, refusingSummarizer, seedMemoriesBySql } from "./helpers.js";

/** The memories `start..end` as a free merge writes them. */
const joined = (start: number, end: number): string => Array.from({ length: end - start + 1 }, (_, i) => `m${start + i}`).join(" / ");

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

	it("builds every node from its two children, joining them without a model while they fit", async () => {
		const inputs: SummarizeInput[] = [];
		const summarizer: MemorySummarizer = {
			async summarize(input) {
				inputs.push(input);
				return `s${input.startId}-${input.endId}`;
			},
		};
		const { memory, store } = await openFixture({ summarizer, limits: { summaryBytes: 21 } });
		await noteMany(memory, 16);
		expect(await memory.compact()).toEqual({ merged: 15, pending: 0 });
		expect(inputs).toEqual([
			{ startId: 0, endId: 7, maxBytes: 21, items: [{ startId: 0, endId: 3, content: "m0 / m1 / m2 / m3" }, { startId: 4, endId: 7, content: "m4 / m5 / m6 / m7" }] },
			{ startId: 8, endId: 15, maxBytes: 21, items: [{ startId: 8, endId: 11, content: "m8 / m9 / m10 / m11" }, { startId: 12, endId: 15, content: "m12 / m13 / m14 / m15" }] },
		]);
		const keys = [1, 2, 3, 4].flatMap((level) => Array.from({ length: 16 / 2 ** level }, (_, k) => ({ level, startId: k * 2 ** level })));
		expect((await store.getNodes(keys)).map((node) => node.summary)).toEqual([
			"m0 / m1", "m2 / m3", "m4 / m5", "m6 / m7", "m8 / m9", "m10 / m11", "m12 / m13", "m14 / m15",
			"m0 / m1 / m2 / m3", "m4 / m5 / m6 / m7", "m8 / m9 / m10 / m11", "m12 / m13 / m14 / m15",
			"s0-7", "s8-15",
			"s0-7 / s8-15",
		]);
	});

	it("wakes with at most 96 items that tile the whole log and end on the newest memory", async () => {
		const { memory } = await openFixture({ limits: { maxEntryBytes: 8192 } });
		await noteMany(memory, 1000);
		await memory.compact();
		const { items, total } = await memory.wake();
		expect(total).toBe(1000);
		expect(items.length).toBe(96);
		expect(items[0]).toEqual({ type: "summary", startId: 0, endId: 63, content: joined(0, 63) });
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
		expect(items[0]).toEqual({ type: "summary", startId: 0, endId: 8191, content: Array(64).fill("x").join(" / ") });
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
			{ type: "summary", startId: 0, endId: 1, content: "m0 / m1" },
			{ type: "summary", startId: 2, endId: 3, content: "m2 / m3" },
			{ type: "summary", startId: 4, endId: 5, content: "m4 / m5" },
			{ type: "summary", startId: 6, endId: 7, content: "m6 / m7" },
			{ type: "memory", id: 8, createdAt: 1_700_000_000_008, content: "m8" },
		]);
		expect(after.items.filter((item) => item.type === "pending")).toEqual([]);
	});

	it("zooms from the root block down to memory 0 and rejects ranges that are not blocks", async () => {
		const { memory } = await openFixture({ limits: { summaryBytes: 8192 } });
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
		expect(await memory.zoom({ startId: 992, endId: 1007 })).toEqual([{ type: "summary", startId: 992, endId: 999, content: joined(992, 999) }]);
		expect(await memory.zoom({ startId: 512, endId: 1023 })).toEqual([
			{ type: "summary", startId: 512, endId: 767, content: joined(512, 767) },
			{ type: "pending", startId: 768, endId: 1023 },
		]);
		await expect(memory.zoom({ startId: 1, endId: 2 })).rejects.toThrow(InvalidRange);
		await expect(memory.zoom({ startId: 4, endId: 4 })).rejects.toThrow(InvalidRange);
		await expect(memory.zoom({ startId: 0, endId: 2 })).rejects.toThrow(InvalidRange);
		await expect(memory.zoom({ startId: 1000, endId: 1001 })).rejects.toThrow(InvalidRange);
	});

	it("stops after maxMerges and reports what is still pending", async () => {
		const { memory, store } = await openFixture();
		await noteMany(memory, 8);
		expect(await memory.pending()).toBe(7);
		expect(await memory.compact({ maxMerges: 1 })).toEqual({ merged: 1, pending: 6 });
		expect(await store.getNodes([{ level: 1, startId: 0 }, { level: 1, startId: 2 }])).toEqual([{ level: 1, startId: 0, endId: 1, summary: "m0 / m1" }]);
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
		expect(await store.getNodes([{ level: 1, startId: 0 }])).toEqual([{ level: 1, startId: 0, endId: 1, summary: "prefers detail" }]);
		expect(await memory.zoom({ startId: 0, endId: 1 })).toEqual([{ type: "memory", id: 1, createdAt: 2, content: "prefers detail" }]);
		expect(await memory.recall("prefers")).toEqual([{ id: 1, createdAt: 2, content: "prefers detail", supersedes: 0 }]);
		await expect(memory.note({ content: "prefers tables", supersedes: 7 })).rejects.toThrow(new InvalidRange("#7 is not in the memory: it holds 2 memories"));
		expect(await store.count()).toBe(2);
	});

	it("stores an empty summary for a block whose every memory was superseded, without the summarizer", async () => {
		const { memory, store } = await openFixture({ summarizer: refusingSummarizer });
		await memory.note({ content: "prefers brevity", createdAt: 1 });
		await memory.note({ content: "prefers detail", supersedes: 0, createdAt: 2 });
		await memory.note({ content: "prefers tables", supersedes: 1, createdAt: 3 });
		await memory.note({ content: "prefers lists", createdAt: 4 });
		expect(await memory.compact()).toEqual({ merged: 3, pending: 0 });
		expect(await store.getNodes([{ level: 1, startId: 0 }, { level: 1, startId: 2 }, { level: 2, startId: 0 }])).toEqual([
			{ level: 1, startId: 0, endId: 1, summary: "" },
			{ level: 1, startId: 2, endId: 3, summary: "prefers tables / prefers lists" },
			{ level: 2, startId: 0, endId: 3, summary: "prefers tables / prefers lists" },
		]);
	});

	it("normalizes and truncates summaries on a character boundary", async () => {
		const { memory, store } = await openFixture({
			summarizer: { async summarize() { return `  line one\n line two ${"é".repeat(40)}`; } },
			limits: { summaryBytes: 64 },
		});
		await memory.note({ content: "a".repeat(40), createdAt: 0 });
		await memory.note({ content: "b".repeat(40), createdAt: 1 });
		await memory.compact();
		const [node] = await store.getNodes([{ level: 1, startId: 0 }]);
		expect(node?.summary).toBe(`line one line two ${"é".repeat(23)}`);
		expect(new TextEncoder().encode(node!.summary).length).toBe(64);
	});

	it("hands out the blocks that need a model in build order through nextMerge and stores what commitMerge is given", async () => {
		const { memory, store } = await openFixture({ limits: { summaryBytes: 4 } });
		await noteMany(memory, 4);
		expect(await memory.nextMerge()).toEqual({
			startId: 0,
			endId: 1,
			items: [
				{ startId: 0, endId: 0, content: "m0" },
				{ startId: 1, endId: 1, content: "m1" },
			],
			maxBytes: 4,
		});
		expect(await memory.commitMerge({ startId: 0, endId: 1 }, "p01")).toBe(true);
		expect(await memory.nextMerge()).toEqual({
			startId: 2,
			endId: 3,
			items: [
				{ startId: 2, endId: 2, content: "m2" },
				{ startId: 3, endId: 3, content: "m3" },
			],
			maxBytes: 4,
		});
		expect(await memory.commitMerge({ startId: 2, endId: 3 }, "p23")).toBe(true);
		expect(await memory.nextMerge()).toEqual({
			startId: 0,
			endId: 3,
			items: [
				{ startId: 0, endId: 1, content: "p01" },
				{ startId: 2, endId: 3, content: "p23" },
			],
			maxBytes: 4,
		});
		expect(await memory.commitMerge({ startId: 0, endId: 3 }, "all")).toBe(true);
		expect(await memory.nextMerge()).toBeUndefined();
		expect(await memory.pending()).toBe(0);
		expect(await memory.commitMerge({ startId: 0, endId: 1 }, "again")).toBe(false);
		expect(await store.getNodes([{ level: 1, startId: 0 }])).toEqual([{ level: 1, startId: 0, endId: 1, summary: "p01" }]);
		await expect(memory.commitMerge({ startId: 1, endId: 2 }, "x")).rejects.toThrow(InvalidRange);
	});

	it("refuses a commit for a block that is not next at its level, so the blocks before it stay buildable", async () => {
		const { memory, store } = await openFixture({ summarizer: null });
		await noteMany(memory, 6);
		expect(await memory.commitMerge({ startId: 4, endId: 5 }, "third pair")).toBe(false);
		expect(await memory.commitMerge({ startId: 0, endId: 3 }, "first four")).toBe(false);
		expect(await memory.pending()).toBe(4);
		expect(await memory.commitMerge({ startId: 0, endId: 1 }, "first pair")).toBe(true);
		expect(await memory.commitMerge({ startId: 2, endId: 3 }, "second pair")).toBe(true);
		expect(await memory.commitMerge({ startId: 4, endId: 5 }, "third pair")).toBe(true);
		expect(await memory.commitMerge({ startId: 0, endId: 3 }, "first four")).toBe(true);
		expect(await memory.pending()).toBe(0);
		expect(await store.getNodes([{ level: 1, startId: 0 }, { level: 1, startId: 2 }, { level: 1, startId: 4 }, { level: 2, startId: 0 }])).toEqual([
			{ level: 1, startId: 0, endId: 1, summary: "first pair" },
			{ level: 1, startId: 2, endId: 3, summary: "second pair" },
			{ level: 1, startId: 4, endId: 5, summary: "third pair" },
			{ level: 2, startId: 0, endId: 3, summary: "first four" },
		]);
	});

	it("without a summarizer compact stores only free merges and manual commits fill the rest", async () => {
		const { memory, store } = await openFixture({ summarizer: null, limits: { summaryBytes: 8 } });
		await noteMany(memory, 4);
		await memory.note({ content: "long note", createdAt: 4 });
		await memory.note({ content: "another", createdAt: 5 });
		expect(await memory.compact()).toEqual({ merged: 2, pending: 2 });
		const keys = [{ level: 1, startId: 0 }, { level: 1, startId: 2 }, { level: 1, startId: 4 }, { level: 2, startId: 0 }];
		expect((await store.getNodes(keys)).map((node) => node.summary)).toEqual(["m0 / m1", "m2 / m3"]);
		for (let input = await memory.nextMerge(); input !== undefined; input = await memory.nextMerge()) {
			await memory.commitMerge(input, `c${input.startId}${input.endId}`);
		}
		expect(await memory.compact()).toEqual({ merged: 0, pending: 0 });
		expect((await store.getNodes(keys)).map((node) => node.summary)).toEqual(["m0 / m1", "m2 / m3", "c45", "c03"]);
	});
});
