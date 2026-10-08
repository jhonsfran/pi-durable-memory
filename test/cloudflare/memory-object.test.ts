import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
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

	it("destroy deletes every memory and the alarm, and the scope starts over at #0", async () => {
		const stub = stubFor("destroy");
		await noteMany(stub, 4);
		await compacted(stub);
		await runInDurableObject(stub, (_, state) => state.storage.setAlarm(Date.now() + 60_000));
		await stub.destroy();
		expect(await runInDurableObject(stub, (_, state) => state.storage.getAlarm())).toBeNull();
		expect(await stub.wake()).toEqual({ total: 0, items: [] });
		expect(await stub.note({ content: "fresh", createdAt: T0 })).toEqual({ id: 0, createdAt: T0, content: "fresh" });
	});

	it("without a summarizer schedules no alarm and stores the summaries the client commits", async () => {
		const stub = env.MEMORY_CLIENT.get(env.MEMORY_CLIENT.idFromName("client"));
		await noteMany(stub, 4);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await stub.pending()).toBe(3);
		expect(await stub.nextMerge()).toEqual({
			startId: 0,
			endId: 1,
			request: {
				system: expect.any(String),
				turns: [{ role: "user", blocks: ["<memory>\nm0\nm1\n</memory>", expect.stringMatching(/at most 4 bytes[^]*\n<input>\nm0\nm1\n<\/input>$/)] }],
			},
		});
		for (let job = await stub.nextMerge(); job !== undefined; job = await stub.nextMerge()) {
			expect(await stub.commitMerge(job, `c${job.startId}${job.endId}`)).toBe(true);
		}
		expect(await stub.pending()).toBe(0);
		expect((await stub.wake()).items).toEqual([
			{ type: "summary", startId: 0, endId: 1, content: "c01" },
			{ type: "summary", startId: 2, endId: 3, content: "c23" },
		]);
	});

	it("retries a failed summary about 10 s later instead of throwing, and stores it on a later alarm", async () => {
		const stub = env.MEMORY_FLAKY.get(env.MEMORY_FLAKY.idFromName("flaky"));
		const alarm = () => runInDurableObject(stub, (_, state) => state.storage.getAlarm());
		const noted = Date.now();
		await noteMany(stub, 2);
		let retryAt = await alarm();
		while (retryAt === null || retryAt < noted + 5_000) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			retryAt = await alarm();
		}
		expect(Math.round((retryAt - noted) / 1000)).toBe(10);
		expect(await stub.pending()).toBe(1);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await stub.pending()).toBe(0);
		expect(await alarm()).toBeNull();
		expect(await stub.zoom({ startId: 0, endId: 1 })).toEqual([
			{ type: "memory", id: 0, createdAt: T0, content: "m0" },
			{ type: "memory", id: 1, createdAt: T0 + 1, content: "m1" },
		]);
	});
});
