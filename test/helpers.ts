import { createMemory } from "../src/index.js";
import type { Memory, MemoryLimits, MemoryStore, MemorySummarizer } from "../src/index.js";
import { createSqliteMemoryStore } from "../src/sqlite/index.js";
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

export interface Fixture {
	db: SqlDatabase;
	store: MemoryStore;
	memory: Memory;
}

export async function openFixture(
	options: { scope?: string; db?: SqlDatabase; store?: (store: MemoryStore) => MemoryStore; summarizer?: MemorySummarizer; limits?: Partial<MemoryLimits> } = {},
): Promise<Fixture> {
	const db = options.db ?? openNodeSqlite(":memory:");
	const base = await createSqliteMemoryStore(db, { scope: options.scope ?? "test" });
	const store = options.store ? options.store(base) : base;
	const memory = createMemory({ store, summarizer: options.summarizer ?? joinSummarizer, ...(options.limits ? { limits: options.limits } : {}) });
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
