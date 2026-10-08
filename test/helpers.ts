import { createMemory } from "../src/index.js";
import type { Memory, MemoryLimits, MemoryStore, MemorySummarizer, SummaryRequest } from "../src/index.js";
import type { SqlDatabase } from "../src/sqlite/database.js";
import { createSqliteMemoryStore } from "../src/sqlite/store.js";
import { openNodeSqlite } from "./node-sqlite.js";

export function mergedLines(request: SummaryRequest): string[] {
	const [first] = request.turns;
	const [, a, b] = (first?.role === "user" ? /\n<input>\n(.*)\n(.*)\n<\/input>$/.exec(first.blocks[1] ?? "") : null) ?? [];
	if (a === undefined || b === undefined) throw new Error("the step has no <input> holding two lines");
	return [a, b];
}

export const joinSummarizer: MemorySummarizer = {
	async complete(request) {
		return `[${mergedLines(request).join(" ")}]`;
	},
};

export const spanSummarizer: MemorySummarizer = {
	async complete(request) {
		const ids = mergedLines(request).join(" ").match(/m\d+/g) ?? [];
		return `${ids[0]}..${ids.at(-1)}`;
	},
};

export const refusingSummarizer: MemorySummarizer = {
	async complete() {
		throw new Error("the summarizer was called");
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

export async function seedNodesBySql(db: SqlDatabase, scope: string, count: number, summary: (level: number, startId: number) => string): Promise<void> {
	await db.transaction(async (tx) => {
		for (let level = 1; 2 ** level <= count; level++) {
			const size = 2 ** level;
			for (let startId = 0; startId + size <= count; startId += size) {
				await tx.run("INSERT INTO memory_nodes (scope, level, start_id, end_id, summary) VALUES (?, ?, ?, ?, ?)", scope, level, startId, startId + size - 1, summary(level, startId));
			}
		}
	});
}

/** Inserts `count` memories for `scope` straight into the table, bypassing the store and its FTS index. */
export async function seedMemoriesBySql(db: SqlDatabase, scope: string, count: number): Promise<void> {
	await db.transaction(async (tx) => {
		for (let id = 0; id < count; id++) {
			await tx.run("INSERT INTO memories (scope, id, created_at, content, source_id) VALUES (?, ?, ?, ?, NULL)", scope, id, id, `m${id}`);
		}
	});
}
