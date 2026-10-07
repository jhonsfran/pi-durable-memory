import { createMemory } from "../src/index.js";
import type { Embedder, Memory, MemoryLimits, MemoryStore, MemorySummarizer } from "../src/index.js";
import { createSqliteMemoryStore, createSqliteVectorIndex } from "../src/sqlite/index.js";
import type { SqlDatabase } from "../src/sqlite/index.js";
import { openNodeSqlite } from "../src/sqlite/node.js";

/** Bracket-joins the children's content, so every summary is a literal function of its inputs. */
export const joinSummarizer: MemorySummarizer = {
	async summarize({ items }) {
		return `[${items.map((item) => item.content).join(" ")}]`;
	},
};

export const constantSummarizer: MemorySummarizer = {
	async summarize() {
		return "x";
	},
};

/**
 * Set of words over 16 dimensions. Each concept group owns one dimension, so "automobile" lands
 * where "car" does without sharing a token; every word outside the table lands in the last one.
 * Cosine similarity is then a function of the distinct words alone, so every ranking is deterministic.
 */
const CONCEPTS: readonly (readonly string[])[] = [["car", "automobile"], ["pnpm"], ["nightly"], ["berlin"], ["rust"], ["tea"], ["tabs"], ["friday"]];
const DIMENSIONS = 16;

export const conceptEmbedder: Embedder = {
	async embed(texts) {
		return texts.map((text) => {
			const vector = new Float32Array(DIMENSIONS);
			for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
				const concept = CONCEPTS.findIndex((group) => group.includes(word));
				vector[concept === -1 ? DIMENSIONS - 1 : concept] = 1;
			}
			return vector;
		});
	},
};

export interface Fixture {
	db: SqlDatabase;
	store: MemoryStore;
	memory: Memory;
}

export async function openFixture(
	options: {
		scope?: string;
		db?: SqlDatabase;
		store?: (store: MemoryStore) => MemoryStore;
		summarizer?: MemorySummarizer;
		limits?: Partial<MemoryLimits>;
		/** Adds a SQLite vector index over this embedder. */
		embedder?: Embedder;
	} = {},
): Promise<Fixture> {
	const db = options.db ?? openNodeSqlite(":memory:");
	const scope = options.scope ?? "test";
	const base = await createSqliteMemoryStore(db, { scope });
	const store = options.store ? options.store(base) : base;
	const index = options.embedder === undefined ? undefined : await createSqliteVectorIndex(db, { scope, embedder: options.embedder });
	const memory = createMemory({ store, summarizer: options.summarizer ?? joinSummarizer, index, limits: options.limits });
	return { db, store, memory };
}

export async function noteMany(memory: Memory, count: number): Promise<void> {
	for (let id = 0; id < count; id++) await memory.note({ content: `m${id}`, createdAt: 1_700_000_000_000 + id });
}

/** Inserts `count` memories for `scope` straight into the table, bypassing the store and its FTS index. */
export async function seedMemoriesBySql(db: SqlDatabase, scope: string, count: number): Promise<void> {
	await db.transaction(async (tx) => {
		for (let id = 0; id < count; id++) {
			await tx.run("INSERT INTO memories (scope, id, created_at, content, source_id) VALUES (?, ?, ?, ?, NULL)", scope, id, id, `m${id}`);
		}
	});
}
