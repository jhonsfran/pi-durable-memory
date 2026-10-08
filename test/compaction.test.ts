import { describe, expect, it } from "vitest";
import type { Memory, MemorySummarizer } from "../src/index.js";
import { mergedLines, noteMany, openFixture, refusingSummarizer } from "./helpers.js";

async function noteLong(memory: Memory, count: number): Promise<void> {
	for (let id = 0; id < count; id++) await memory.note({ content: `note-${String(id).padStart(2, "0")}`, createdAt: id });
}

describe("compaction", () => {
	it("stores merges that fit without calling the model", async () => {
		const { memory } = await openFixture({ summarizer: refusingSummarizer });
		await noteMany(memory, 8);
		expect(await memory.compact()).toEqual({ merged: 7, pending: 0, failed: [] });
		expect(await memory.zoom({ startId: 0, endId: 7 })).toEqual([
			{ type: "summary", startId: 0, endId: 3, content: "m0 / m1 / m2 / m3" },
			{ type: "summary", startId: 4, endId: 7, content: "m4 / m5 / m6 / m7" },
		]);
	});

	it("runs at most 8 summarizer conversations at once with 32 blocks ready", async () => {
		let running = 0;
		let most = 0;
		let calls = 0;
		const summarizer: MemorySummarizer = {
			async complete() {
				calls++;
				most = Math.max(most, ++running);
				await new Promise((resolve) => setTimeout(resolve, 5));
				running--;
				return "ok";
			},
		};
		const { memory } = await openFixture({ summarizer, limits: { summaryBytes: 12 } });
		await noteLong(memory, 64);
		expect(await memory.compact()).toEqual({ merged: 63, pending: 0, failed: [] });
		expect(most).toBe(8);
		expect(calls).toBe(42);
	});

	it("reports a failing block as data, keeps building the others, and retries it on the next call", async () => {
		let down = true;
		const tried: string[] = [];
		const summarizer: MemorySummarizer = {
			async complete(request) {
				const lines = mergedLines(request);
				tried.push(lines.join(" + "));
				if (down && lines.includes("note-06")) throw new Error("model down");
				return "ok";
			},
		};
		const { memory, store } = await openFixture({ summarizer, limits: { summaryBytes: 12 } });
		await noteLong(memory, 8);
		expect(await memory.compact()).toEqual({ merged: 4, pending: 3, failed: [{ startId: 6, endId: 7, message: "model down" }] });
		expect(tried).toEqual(["note-00 + note-01", "note-02 + note-03", "note-04 + note-05", "note-06 + note-07"]);
		expect((await store.getNodes([{ level: 1, startId: 4 }, { level: 1, startId: 6 }, { level: 2, startId: 0 }])).map((node) => node.summary)).toEqual(["ok", "ok / ok"]);
		down = false;
		expect(await memory.compact()).toEqual({ merged: 3, pending: 0, failed: [] });
	});

	it("reports an empty reply as a failure and stores nothing", async () => {
		const { memory, store } = await openFixture({ summarizer: { complete: async () => "  \n " }, limits: { summaryBytes: 12 } });
		await noteLong(memory, 2);
		expect(await memory.compact()).toEqual({ merged: 0, pending: 1, failed: [{ startId: 0, endId: 1, message: "The summarizer replied with an empty line" }] });
		expect(await store.listNodes()).toEqual([]);
		expect((await memory.wake()).items.map((item) => item.content)).toEqual(["note-00", "note-01"]);
	});
});
