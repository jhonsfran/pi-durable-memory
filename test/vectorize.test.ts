import { describe, expect, it } from "vitest";
import { createVectorizeIndex } from "../src/cloudflare/vectorize-index.js";
import type { Embedder } from "../src/index.js";

/** `[length, 1]`, so every expected vector is a literal the reader can check against the text. */
const lengthEmbedder: Embedder = {
	async embed(texts) {
		return texts.map((text) => Float32Array.from([text.length, 1]));
	},
};

/** Records every call and answers queries with `matches`. */
function fakeVectorize(matches: VectorizeMatch[]) {
	const calls = { upsert: [] as VectorizeVector[][], query: [] as { vector: VectorFloatArray | number[]; options: VectorizeQueryOptions | undefined }[] };
	const binding: Pick<Vectorize, "upsert" | "query"> = {
		async upsert(vectors) {
			calls.upsert.push(vectors);
			return { mutationId: "mutation-1" };
		},
		async query(vector, options) {
			calls.query.push({ vector, options });
			return { matches, count: matches.length };
		},
	};
	return { calls, binding };
}

describe("createVectorizeIndex", () => {
	it("upserts one vector per entry with the encoded key as id and the scope as namespace", async () => {
		const { calls, binding } = fakeVectorize([]);
		const index = createVectorizeIndex(binding, { namespace: "agent:a", embedder: lengthEmbedder });
		await index.upsert([]);
		await index.upsert([
			{ key: { kind: "memory", id: 3 }, text: "car" },
			{ key: { kind: "node", level: 2, startId: 4 }, text: "[m4 m5 m6 m7]" },
		]);
		expect(calls.upsert).toEqual([
			[
				{ id: "m:3", values: Float32Array.from([3, 1]), namespace: "agent:a" },
				{ id: "n:2:4", values: Float32Array.from([13, 1]), namespace: "agent:a" },
			],
		]);
	});

	it("queries the namespace with topK = limit and decodes match ids back to keys", async () => {
		const { calls, binding } = fakeVectorize([
			{ id: "m:3", score: 0.9 },
			{ id: "n:1:2", score: 0.4 },
		]);
		const index = createVectorizeIndex(binding, { namespace: "agent:a", embedder: lengthEmbedder });
		expect(await index.query("automobile", 5)).toEqual([
			{ key: { kind: "memory", id: 3 }, score: 0.9 },
			{ key: { kind: "node", level: 1, startId: 2 }, score: 0.4 },
		]);
		expect(await index.query("automobile", 0)).toEqual([]);
		expect(calls.query).toEqual([{ vector: Float32Array.from([10, 1]), options: { topK: 5, namespace: "agent:a" } }]);
	});
});
