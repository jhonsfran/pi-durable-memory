import { describe, expect, it } from "vitest";
import type { MemorySummarizer, SummaryRequest } from "../src/index.js";
import { openFixture } from "./helpers.js";

function scripted(replies: readonly string[]) {
	const requests: SummaryRequest[] = [];
	const summarizer: MemorySummarizer = {
		async complete(request) {
			requests.push(request);
			const reply = replies[requests.length - 1];
			if (reply === undefined) throw new Error(`asked ${requests.length} times, scripted ${replies.length}`);
			return reply;
		},
	};
	return { summarizer, requests };
}

const step = (lines: string): string =>
	`Merge these two adjacent lines into one line of at most 16 bytes (about 2 words), the length of this ruler:\n----------------\n<memory> may hold their notes in more detail: take details of them from there too.\n<input>\n${lines}\n</input>`;

describe("summarizer conversation", () => {
	it("sends the bare view up to the block as context and the two lines as the step, with no id anywhere", async () => {
		const { memory } = await openFixture({ summarizer: null, limits: { summaryBytes: 16, viewBytes: 40 } });
		await memory.note({ content: "prefers tabs", createdAt: 0 });
		await memory.note({ content: "deploys on Fridays", createdAt: 1 });
		await memory.note({ content: "uses pnpm 9", createdAt: 2 });
		await memory.note({ content: "tests in workerd", createdAt: 3 });
		const first = await memory.nextMerge();
		expect(first).toEqual({
			startId: 0,
			endId: 1,
			request: {
				system: expect.any(String),
				turns: [{ role: "user", blocks: ["<memory>\nprefers tabs\ndeploys on Fridays\n</memory>", step("prefers tabs\ndeploys on Fridays")] }],
			},
		});
		expect(await memory.commitMerge({ startId: 0, endId: 1 }, "tabs, Fri deploy")).toBe(true);
		const second = await memory.nextMerge();
		expect(second).toEqual({
			startId: 2,
			endId: 3,
			request: {
				system: first?.request.system,
				turns: [{ role: "user", blocks: ["<memory>\ntabs, Fri deploy\nuses pnpm 9\ntests in workerd\n</memory>", step("uses pnpm 9\ntests in workerd")] }],
			},
		});
		expect(JSON.stringify([first, second]).match(/#/g)).toBeNull();
	});

	it("asks again in the same conversation when the line is over the limit, showing where the limit cuts it", async () => {
		const { summarizer, requests } = scripted(["  tabs on Friday\n é ok \n", "tabs, Fri deploy"]);
		const { memory, store } = await openFixture({ summarizer, limits: { summaryBytes: 16 } });
		await memory.note({ content: "prefers tabs", createdAt: 0 });
		await memory.note({ content: "deploys on Fridays", createdAt: 1 });
		expect(await memory.compact()).toEqual({ merged: 1, pending: 0, failed: [] });
		expect(requests).toHaveLength(2);
		expect(requests[1]?.turns).toEqual([
			{ role: "user", blocks: ["<memory>\nprefers tabs\ndeploys on Fridays\n</memory>", step("prefers tabs\ndeploys on Fridays")] },
			{ role: "assistant", text: "tabs on Friday é ok" },
			{ role: "user", blocks: ["Too long: your line is 20 bytes, over the 16-byte limit. Write the whole line again for the same <input>, cutting just enough of the least valuable items to fit before this cut:\ntabs on Friday | ← LIMIT"] },
		]);
		expect(await store.getNodes([{ level: 1, startId: 0 }])).toEqual([{ level: 1, startId: 0, endId: 1, summary: "tabs, Fri deploy" }]);
	});

	it("keeps the shortest of five tries when none fits, without cutting it", async () => {
		const { summarizer, requests } = scripted(["a".repeat(30), "b".repeat(25), "c".repeat(28), "d".repeat(22), "e".repeat(26)]);
		const { memory, store } = await openFixture({ summarizer, limits: { summaryBytes: 16 } });
		await memory.note({ content: "prefers tabs", createdAt: 0 });
		await memory.note({ content: "deploys on Fridays", createdAt: 1 });
		expect(await memory.compact()).toEqual({ merged: 1, pending: 0, failed: [] });
		expect(requests.map((request) => request.turns.length)).toEqual([1, 3, 5, 7, 9]);
		expect(await store.getNodes([{ level: 1, startId: 0 }])).toEqual([{ level: 1, startId: 0, endId: 1, summary: "d".repeat(22) }]);
	});
});
