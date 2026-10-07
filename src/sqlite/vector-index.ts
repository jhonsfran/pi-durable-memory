/**
 * Brute-force cosine index over one scope's vectors in SQLite.
 *
 * Every query loads every vector of the scope and scores it in one `Float32Array` loop, so cost is
 * linear in entries times dimensions: fine to roughly 20k entries at 384 dimensions (about 30 MB
 * read and a few tens of milliseconds per query). A scope beyond that needs an external index such
 * as Vectorize on Cloudflare behind the same `MemoryIndex` interface.
 */
import { decodeIndexKey, encodeIndexKey } from "../core/index-key.js";
import type { Embedder, MemoryIndex } from "../core/types.js";
import type { SqlDatabase } from "./database.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_vectors (
	scope TEXT NOT NULL,
	key TEXT NOT NULL,
	vector BLOB NOT NULL,
	PRIMARY KEY (scope, key)
);
`;

type VectorRow = { key: string; vector: Uint8Array };

const toBytes = (vector: Float32Array): Uint8Array => new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);

/** A driver may hand back bytes at an offset `Float32Array` cannot view; those are copied once. */
function toVector(bytes: Uint8Array): Float32Array {
	if (bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return new Float32Array(copy.buffer);
}

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] as number;
		const y = b[i] as number;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/** One scope's `MemoryIndex` inside a database that may hold many scopes. Creates the table on open. */
export async function createSqliteVectorIndex(db: SqlDatabase, options: { readonly scope: string; readonly embedder: Embedder }): Promise<MemoryIndex> {
	const { scope, embedder } = options;
	await db.exec(SCHEMA);

	return {
		async upsert(entries) {
			if (entries.length === 0) return;
			const vectors = await embedder.embed(entries.map((entry) => entry.text));
			if (vectors.length !== entries.length) throw new Error(`Embedder returned ${vectors.length} vectors for ${entries.length} texts`);
			await db.transaction(async (tx) => {
				for (const [i, entry] of entries.entries()) {
					await tx.run("INSERT OR REPLACE INTO memory_vectors (scope, key, vector) VALUES (?, ?, ?)", scope, encodeIndexKey(entry.key), toBytes(vectors[i] as Float32Array));
				}
			});
		},

		async query(text, limit) {
			if (limit <= 0) return [];
			const [query] = await embedder.embed([text]);
			if (query === undefined) throw new Error("Embedder returned no vector for the query");
			const rows = await db.all<VectorRow>("SELECT key, vector FROM memory_vectors WHERE scope = ? ORDER BY key", scope);
			const scored: { key: string; score: number }[] = [];
			for (const row of rows) {
				const vector = toVector(row.vector);
				if (vector.length !== query.length) throw new Error(`Vector ${row.key} has ${vector.length} dimensions, the embedder produces ${query.length}`);
				const score = cosine(query, vector);
				if (score > 0) scored.push({ key: row.key, score });
			}
			scored.sort((a, b) => b.score - a.score);
			return scored.slice(0, limit).map((hit) => ({ key: decodeIndexKey(hit.key), score: hit.score }));
		},
	};
}
