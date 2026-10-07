/**
 * `MemoryIndex` over a Cloudflare Vectorize index, one namespace per scope.
 *
 * Vectorize mutations are asynchronous: `upsert()` resolves once the mutation is enqueued, and the
 * vector becomes queryable seconds later, not immediately. A `recall()` right after a `note()` may
 * therefore miss the newest memory until then; the full-text path still finds it.
 */
import { decodeIndexKey, encodeIndexKey } from "../core/index-key.js";
import type { Embedder, MemoryIndex } from "../core/types.js";

/** `index` is typed by the two methods used, so a test can pass a fake in place of the binding. */
export function createVectorizeIndex(index: Pick<Vectorize, "upsert" | "query">, options: { readonly namespace: string; readonly embedder: Embedder }): MemoryIndex {
	const { namespace, embedder } = options;

	return {
		async upsert(entries) {
			if (entries.length === 0) return;
			const vectors = await embedder.embed(entries.map((entry) => entry.text));
			if (vectors.length !== entries.length) throw new Error(`Embedder returned ${vectors.length} vectors for ${entries.length} texts`);
			await index.upsert(entries.map((entry, i) => ({ id: encodeIndexKey(entry.key), values: vectors[i] as Float32Array, namespace })));
		},

		async query(text, limit) {
			if (limit <= 0) return [];
			const [vector] = await embedder.embed([text]);
			if (vector === undefined) throw new Error("Embedder returned no vector for the query");
			const { matches } = await index.query(vector, { topK: limit, namespace });
			return matches.map((match) => ({ key: decodeIndexKey(match.id), score: match.score }));
		},
	};
}
