import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createMemoryClient } from "../../src/cloudflare/index.js";
import type { Memory } from "../../src/index.js";

const T0 = 1_700_000_000_000;

const stubFor = (scope: string) => env.MEMORY.get(env.MEMORY.idFromName(scope));

async function noteMany(memory: Memory, count: number): Promise<void> {
	for (let id = 0; id < count; id++) await memory.note({ content: `m${id}`, createdAt: T0 + id });
}

/** The alarm fires on its own inside the runtime; compaction is done once nothing is pending. */
async function compacted(memory: Memory): Promise<void> {
	while ((await memory.pending()) > 0) await new Promise((resolve) => setTimeout(resolve, 10));
}

const summaries = [
	{ type: "summary", startId: 0, endId: 3, content: "m0 / m1 / m2 / m3" },
	{ type: "summary", startId: 4, endId: 7, content: "m4 / m5 / m6 / m7" },
];

describe("memory Durable Object", () => {
	it("note is idempotent per sourceId", async () => {
		const stub = stubFor("idempotent");
		const first = await stub.note({ content: "hello", sourceId: "task-1", createdAt: T0 });
		const second = await stub.note({ content: "hello again", sourceId: "task-1", createdAt: T0 + 1 });
		expect(first).toEqual({ id: 0, createdAt: T0, content: "hello", sourceId: "task-1" });
		expect(second).toEqual(first);
		expect((await stub.wake()).total).toBe(1);
	});

	it("compacts from the alarm scheduled by note", async () => {
		const stub = stubFor("compact");
		await noteMany(stub, 8);
		await compacted(stub);
		expect(await stub.wake()).toEqual({
			total: 8,
			items: Array.from({ length: 8 }, (_, id) => ({ type: "memory", id, createdAt: T0 + id, content: `m${id}` })),
		});
		expect(await stub.zoom({ startId: 0, endId: 7 })).toEqual(summaries);
	});

	it("keeps scopes apart through the client", async () => {
		const memoryFor = createMemoryClient(env.MEMORY);
		await memoryFor("agent:a").note({ content: "only in a", createdAt: T0 });
		expect((await memoryFor("agent:a").wake()).total).toBe(1);
		expect((await memoryFor("agent:b").wake()).total).toBe(0);
		expect(await memoryFor("agent:b").recall("only")).toEqual([]);
	});

	it("recalls matches newest first", async () => {
		const stub = stubFor("recall");
		await stub.note({ content: "Cloudflare runs the Durable Object", createdAt: T0 });
		await stub.note({ content: "the alarm compacts it", createdAt: T0 + 1 });
		await stub.note({ content: "Cloudflare again", createdAt: T0 + 2 });
		expect(await stub.recall("Cloudflare")).toEqual([
			{ id: 2, createdAt: T0 + 2, content: "Cloudflare again" },
			{ id: 0, createdAt: T0, content: "Cloudflare runs the Durable Object" },
		]);
	});

	it("without a summarizer schedules no alarm and stores the summaries the client commits", async () => {
		const stub = env.MEMORY_CLIENT.get(env.MEMORY_CLIENT.idFromName("client"));
		await noteMany(stub, 4);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await stub.pending()).toBe(3);
		expect(await stub.nextMerge()).toEqual({
			startId: 0,
			endId: 1,
			items: [
				{ startId: 0, endId: 0, content: "m0" },
				{ startId: 1, endId: 1, content: "m1" },
			],
			maxBytes: 4,
		});
		for (let input = await stub.nextMerge(); input !== undefined; input = await stub.nextMerge()) {
			expect(await stub.commitMerge(input, `c${input.startId}${input.endId}`)).toBe(true);
		}
		expect(await stub.pending()).toBe(0);
		expect((await stub.wake({ maxItems: 2 })).items).toEqual([
			{ type: "summary", startId: 0, endId: 1, content: "c01" },
			{ type: "summary", startId: 2, endId: 3, content: "c23" },
		]);
	});
});
