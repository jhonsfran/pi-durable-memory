import { describe, expect, it } from "vitest";
import { InvalidRange, MemoryEntryEmpty, MemoryEntryTooLong, formatMemoryContext } from "../src/index.js";
import type { MemorySummarizer } from "../src/index.js";
import { mergedLines, noteMany, openFixture, refusingSummarizer, spanSummarizer } from "./helpers.js";

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
		const merged: string[][] = [];
		const summarizer: MemorySummarizer = {
			async complete(request) {
				merged.push(mergedLines(request));
				return spanSummarizer.complete(request);
			},
		};
		const { memory, store } = await openFixture({ summarizer, limits: { summaryBytes: 21 } });
		await noteMany(memory, 16);
		expect(await memory.compact()).toEqual({ merged: 15, pending: 0 });
		expect(merged).toEqual([
			["m0 / m1 / m2 / m3", "m4 / m5 / m6 / m7"],
			["m8 / m9 / m10 / m11", "m12 / m13 / m14 / m15"],
		]);
		const keys = [1, 2, 3, 4].flatMap((level) => Array.from({ length: 16 / 2 ** level }, (_, k) => ({ level, startId: k * 2 ** level })));
		expect((await store.getNodes(keys)).map((node) => node.summary)).toEqual([
			"m0 / m1", "m2 / m3", "m4 / m5", "m6 / m7", "m8 / m9", "m10 / m11", "m12 / m13", "m14 / m15",
			"m0 / m1 / m2 / m3", "m4 / m5 / m6 / m7", "m8 / m9 / m10 / m11", "m12 / m13 / m14 / m15",
			"m0..m7", "m8..m15",
			"m0..m7 / m8..m15",
		]);
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

	it("hands out the blocks that need a model in build order through nextMerge and stores what commitMerge is given", async () => {
		const { memory, store } = await openFixture({ summarizer: null, limits: { summaryBytes: 4 } });
		await noteMany(memory, 4);
		const jobs: string[][] = [];
		for (let job = await memory.nextMerge(); job !== undefined; job = await memory.nextMerge()) {
			jobs.push([`${job.startId}-${job.endId}`, ...mergedLines(job.request)]);
			expect(await memory.commitMerge(job, `p${job.startId}${job.endId}`)).toBe(true);
		}
		expect(jobs).toEqual([
			["0-1", "m0", "m1"],
			["2-3", "m2", "m3"],
			["0-3", "p01", "p23"],
		]);
		expect(await memory.pending()).toBe(0);
		expect(await memory.commitMerge({ startId: 0, endId: 1 }, "x")).toBe(false);
		expect(await store.getNodes([{ level: 1, startId: 0 }])).toEqual([{ level: 1, startId: 0, endId: 1, summary: "p01" }]);
		await expect(memory.commitMerge({ startId: 1, endId: 2 }, "x")).rejects.toThrow(InvalidRange);
		await expect(memory.commitMerge({ startId: 0, endId: 1 }, " \n ")).rejects.toThrow(MemoryEntryEmpty);
		await expect(memory.commitMerge({ startId: 0, endId: 1 }, "toolong")).rejects.toThrow(new MemoryEntryTooLong(7, 4));
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
