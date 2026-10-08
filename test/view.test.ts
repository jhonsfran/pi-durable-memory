import { describe, expect, it } from "vitest";
import { InvalidRange } from "../src/index.js";
import type { MemoryContext, MemoryItem, MemoryRange } from "../src/index.js";
import { noteMany, openFixture, refusingSummarizer, seedMemoriesBySql, seedNodesBySql, spanSummarizer } from "./helpers.js";

const rangeOf = (item: MemoryItem): MemoryRange => (item.type === "memory" ? { startId: item.id, endId: item.id } : { startId: item.startId, endId: item.endId });
const bytes = (context: MemoryContext): number => context.items.reduce((sum, item) => sum + new TextEncoder().encode(item.content).length, 0);

function ends(item: MemoryItem): [string | undefined, string | undefined] {
	const ids = item.content.match(/m\d+/g) ?? [];
	return [ids[0], ids.at(-1)];
}

function gaps(parts: readonly MemoryRange[], total: number): string[] {
	const found: string[] = [];
	let next = 0;
	for (const part of parts) {
		if (part.startId !== next) found.push(`expected ${next}, got ${part.startId}`);
		next = part.endId + 1;
	}
	if (next !== total) found.push(`ends at ${next}, log holds ${total}`);
	return found;
}

describe("view", () => {
	it("wakes within viewBytes once compaction has built the parents, tiling the whole log", async () => {
		const { memory } = await openFixture({ summarizer: spanSummarizer, limits: { summaryBytes: 16, viewBytes: 256 } });
		await noteMany(memory, 1000);
		expect(await memory.compact()).toEqual({ merged: 994, pending: 0, failed: [] });
		const view = await memory.wake();
		expect(view.total).toBe(1000);
		expect(bytes(view)).toBeLessThanOrEqual(256);
		expect(gaps(view.items.map(rangeOf), 1000)).toEqual([]);
		expect(view.items[0]).toEqual({ type: "summary", startId: 0, endId: 63, content: "m0..m63" });
		expect(view.items.at(-1)).toEqual({ type: "summary", startId: 992, endId: 999, content: "m992..m999" });
	});

	it("only appends memories and merges lines from one wake to the next, and every line is real text", async () => {
		const { memory } = await openFixture({ summarizer: spanSummarizer, limits: { summaryBytes: 16, viewBytes: 128 } });
		const broken: string[] = [];
		let previous: MemoryRange[] = [];
		for (let id = 0; id < 300; id++) {
			await memory.note({ content: `m${id}`, createdAt: id });
			await memory.compact();
			const view = await memory.wake();
			const parts = view.items.map(rangeOf);
			if (bytes(view) > 128) broken.push(`after m${id}: ${bytes(view)} bytes`);
			broken.push(...gaps(parts, id + 1).map((gap) => `after m${id}: ${gap}`));
			for (const part of previous) {
				if (!parts.some((next) => next.startId <= part.startId && part.endId <= next.endId)) broken.push(`after m${id}: #${part.startId}-${part.endId} was split`);
			}
			for (const item of view.items) {
				const range = rangeOf(item);
				if (ends(item).join() !== `m${range.startId},m${range.endId}`) broken.push(`after m${id}: #${range.startId}-${range.endId} shows "${item.content}"`);
			}
			previous = parts;
		}
		expect(broken).toEqual([]);
		expect((await memory.wake()).items.map((item) => item.content)).toEqual([
			"m0..m127", "m128..m191", "m192..m223", "m224..m239", "m240..m255", "m256..m271", "m272..m279", "m280..m287",
			"m288..m291", "m292 / m293", "m294 / m295", "m296", "m297", "m298", "m299",
		]);
	});

	it("shows every memory before compaction, even over budget", async () => {
		const { memory } = await openFixture({ summarizer: spanSummarizer, limits: { summaryBytes: 16, viewBytes: 16 } });
		await noteMany(memory, 12);
		expect((await memory.wake()).items.map(rangeOf)).toEqual(Array.from({ length: 12 }, (_, id) => ({ startId: id, endId: id })));
		await memory.compact();
		expect((await memory.wake()).items.map((item) => item.content)).toEqual(["m0..m3 / m4..m7", "m8..m11"]);
	});

	it("leaves an empty summary in the view out of wake", async () => {
		const { memory, store } = await openFixture({ summarizer: null, limits: { summaryBytes: 4, viewBytes: 3 } });
		await memory.note({ content: "aaaa", createdAt: 0 });
		await memory.note({ content: "bbbb", createdAt: 1 });
		await memory.note({ content: "cc", supersedes: 0, createdAt: 2 });
		await memory.note({ content: "dd", supersedes: 1, createdAt: 3 });
		expect(await memory.compact()).toEqual({ merged: 1, pending: 2, failed: [] });
		expect(await store.readView()).toEqual([
			{ startId: 0, endId: 1 },
			{ startId: 2, endId: 2 },
			{ startId: 3, endId: 3 },
		]);
		expect((await memory.wake()).items).toEqual([
			{ type: "memory", id: 2, createdAt: 2, content: "cc" },
			{ type: "memory", id: 3, createdAt: 3, content: "dd" },
		]);
	});

	it("folds a 100k-memory log that has nodes but no stored view in seconds", async () => {
		const scope = "big";
		const { db, memory } = await openFixture({ scope, summarizer: refusingSummarizer });
		await seedMemoriesBySql(db, scope, 100_000);
		await seedNodesBySql(db, scope, 100_000, (level, startId) => `level ${level} from ${startId}`);
		const started = performance.now();
		expect(await memory.compact()).toEqual({ merged: 0, pending: 0, failed: [] });
		const folded = performance.now() - started;
		const view = await memory.wake();
		console.log(`100k: fold ${Math.round(folded)}ms, ${view.items.length} lines`);
		expect(view.total).toBe(100_000);
		expect(bytes(view)).toBeLessThanOrEqual(16_384);
		expect(gaps(view.items.map(rangeOf), 100_000)).toEqual([]);
		expect(view.items[0]).toEqual({ type: "summary", startId: 0, endId: 1023, content: "level 10 from 0" });
		expect(view.items.at(-1)).toEqual({ type: "memory", id: 99_999, createdAt: 99_999, content: "m99999" });
		expect(folded).toBeLessThan(5_000);
	});

	it("folds on wake a log written before the view existed, so an upgraded scope never shows every memory", async () => {
		const scope = "upgraded";
		const { db, memory, store } = await openFixture({ scope, summarizer: refusingSummarizer, limits: { viewBytes: 256 } });
		await seedMemoriesBySql(db, scope, 1000);
		await seedNodesBySql(db, scope, 1000, (level, startId) => `level ${level} from ${startId}`);
		const view = await memory.wake();
		expect(view.total).toBe(1000);
		expect(bytes(view)).toBeLessThanOrEqual(256);
		expect(gaps(view.items.map(rangeOf), 1000)).toEqual([]);
		expect(view.items[0]).toEqual({ type: "summary", startId: 0, endId: 255, content: "level 8 from 0" });
		expect((await store.readView()).length).toBe(view.items.length);
	});

	it("zooms from the first line down to a memory and refuses a block that is not built", async () => {
		const { memory } = await openFixture({ summarizer: spanSummarizer, limits: { summaryBytes: 16, viewBytes: 64 } });
		await noteMany(memory, 1000);
		await memory.compact();
		const [first] = (await memory.wake()).items;
		expect(first).toEqual({ type: "summary", startId: 0, endId: 511, content: "m0..m511" });
		expect(await memory.zoom({ startId: 0, endId: 511 })).toEqual([
			{ type: "summary", startId: 0, endId: 255, content: "m0..m255" },
			{ type: "summary", startId: 256, endId: 511, content: "m256..m511" },
		]);
		let range: MemoryRange = { startId: 0, endId: 511 };
		let steps = 0;
		let opened: MemoryItem | undefined;
		do {
			opened = (await memory.zoom(range))[0];
			if (opened?.type === "summary") range = opened;
			steps++;
		} while (opened?.type === "summary" && steps < 20);
		expect(steps).toBe(9);
		expect(opened).toEqual({ type: "memory", id: 0, createdAt: 1_700_000_000_000, content: "m0" });
		expect(await memory.zoom({ startId: 998, endId: 999 })).toEqual([
			{ type: "memory", id: 998, createdAt: 1_700_000_000_998, content: "m998" },
			{ type: "memory", id: 999, createdAt: 1_700_000_000_999, content: "m999" },
		]);
		await expect(memory.zoom({ startId: 512, endId: 1023 })).rejects.toThrow(
			new InvalidRange("#512-1023 is not a summary you can open: zoom a #a-b line you saw in memory or in an earlier zoom"),
		);
		await expect(memory.zoom({ startId: 992, endId: 1007 })).rejects.toThrow(InvalidRange);
		await expect(memory.zoom({ startId: 1, endId: 2 })).rejects.toThrow(InvalidRange);
		await expect(memory.zoom({ startId: 4, endId: 4 })).rejects.toThrow(InvalidRange);
		await expect(memory.zoom({ startId: 0, endId: 2 })).rejects.toThrow(InvalidRange);
	});
});
