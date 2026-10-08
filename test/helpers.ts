import { createMemory } from "../src/index.js";
import type { Memory, MemoryLimits, MemoryStore, MemorySummarizer } from "../src/index.js";
import type { SqlDatabase } from "../src/sqlite/database.js";
import { createSqliteMemoryStore } from "../src/sqlite/store.js";
import { openNodeSqlite } from "./node-sqlite.js";

/** Bracket-joins the children's content, so every summary is a literal function of its inputs. */
export const joinSummarizer: MemorySummarizer = {
	async summarize({ items }) {
		return `[${items.map((item) => item.content).join(" ")}]`;
	},
};

/** Fails the test that reaches it: for paths that must not call a model. */
export const refusingSummarizer: MemorySummarizer = {
	async summarize() {
		throw new Error("the summarizer was called");
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
	options: {
		scope?: string;
		db?: SqlDatabase;
		store?: (store: MemoryStore) => MemoryStore;
		/** Defaults to `joinSummarizer`; `null` opens the memory without one. */
		summarizer?: MemorySummarizer | null;
		limits?: Partial<MemoryLimits>;
	} = {},
): Promise<Fixture> {
	const db = options.db ?? openNodeSqlite(":memory:");
	const scope = options.scope ?? "test";
	const base = await createSqliteMemoryStore(db, { scope });
	const store = options.store ? options.store(base) : base;
	const summarizer = options.summarizer === null ? undefined : (options.summarizer ?? joinSummarizer);
	const memory = createMemory({ store, summarizer, limits: options.limits });
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
