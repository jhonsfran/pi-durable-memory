import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../src/sqlite/index.js";
import { openNodeSqlite } from "../src/sqlite/node.js";
import { noteMany, openFixture } from "./helpers.js";

/** A database whose FTS5 table creation fails, forcing the LIKE fallback. */
function withoutFts(db: SqlDatabase): SqlDatabase {
	return {
		...db,
		exec: (sql) => (sql.includes("fts5") ? Promise.reject(new Error("no such module: fts5")) : db.exec(sql)),
	};
}

describe("node sqlite adapter", () => {
	it("opens a file database in WAL mode", async () => {
		const db = openNodeSqlite(join(mkdtempSync(join(tmpdir(), "optmem-")), "memory.db"));
		expect(await db.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
	});

	it("rejects a transaction handle used after the transaction settled", async () => {
		const db = openNodeSqlite(":memory:");
		const leaked = await db.transaction(async (tx) => {
			expect(await tx.get("SELECT 1 AS one")).toEqual({ one: 1 });
			return tx;
		});
		await expect(leaked.get("SELECT 1 AS one")).rejects.toThrow("SQLite transaction handle is no longer active");
	});

	it("rolls back a transaction that throws, so the next append still takes id 0", async () => {
		const { db, store } = await openFixture();
		await expect(
			db.transaction(async (tx) => {
				await tx.run("INSERT INTO memories (scope, id, created_at, content, source_id) VALUES ('test', 0, 1, 'lost', NULL)");
				throw new Error("abort");
			}),
		).rejects.toThrow("abort");
		expect(await store.count()).toBe(0);
		expect(await store.appendMemory({ content: "kept", createdAt: 2 })).toEqual({ id: 0, createdAt: 2, content: "kept" });
	});
});

describe("sqlite store", () => {
	it("keeps two scopes in one database apart", async () => {
		const db = openNodeSqlite(":memory:");
		const a = await openFixture({ db, scope: "a" });
		const b = await openFixture({ db, scope: "b" });
		await noteMany(a.memory, 4);
		await b.memory.note({ content: "only in b", createdAt: 1 });
		expect(await a.memory.compact()).toEqual({ merged: 3, pending: 0 });
		expect(await b.store.count()).toBe(1);
		expect(await b.memory.wake()).toEqual({ total: 1, items: [{ type: "memory", id: 0, createdAt: 1, content: "only in b" }] });
		expect(await b.memory.recall("m1")).toEqual([]);
		expect(await a.memory.recall("m1")).toEqual([{ type: "memory", id: 1, createdAt: 1_700_000_000_001, content: "m1" }]);
		expect(await b.store.getNodes([{ level: 1, startId: 0 }, { level: 2, startId: 0 }])).toEqual([]);
		expect(await b.store.levelLength(1)).toBe(0);
		expect(await a.store.levelLength(1)).toBe(2);
	});

	it("adds the supersedes column to a database created before it existed and reopens without change", async () => {
		const db = openNodeSqlite(":memory:");
		await db.exec(
			"CREATE TABLE memories (scope TEXT NOT NULL, id INTEGER NOT NULL, created_at INTEGER NOT NULL, content TEXT NOT NULL, source_id TEXT, PRIMARY KEY (scope, id), UNIQUE (scope, source_id))",
		);
		await db.run("INSERT INTO memories (scope, id, created_at, content, source_id) VALUES ('test', 0, 1, 'old', NULL)");
		const { store } = await openFixture({ db });
		expect(await store.appendMemory({ content: "new", createdAt: 2, supersedes: 0 })).toEqual({ id: 1, createdAt: 2, content: "new", supersedes: 0 });
		expect(await store.getMemories({ startId: 0, endId: 1 })).toEqual([
			{ id: 0, createdAt: 1, content: "old", supersededBy: 1 },
			{ id: 1, createdAt: 2, content: "new", supersedes: 0 },
		]);
		const reopened = await openFixture({ db });
		expect(await reopened.store.getMemoriesByIds([1, 0, 9])).toEqual([
			{ id: 0, createdAt: 1, content: "old", supersededBy: 1 },
			{ id: 1, createdAt: 2, content: "new", supersedes: 0 },
		]);
	});

	it("keeps the first node when putNode sees the same key twice", async () => {
		const { store } = await openFixture();
		expect(await store.putNode({ level: 1, startId: 0, endId: 1, summary: "first" })).toBe(true);
		expect(await store.putNode({ level: 1, startId: 0, endId: 1, summary: "second" })).toBe(false);
		expect(await store.getNodes([{ level: 1, startId: 0 }])).toEqual([{ level: 1, startId: 0, endId: 1, summary: "first" }]);
	});

	describe.each([
		["fts5", (db: SqlDatabase) => db],
		["like fallback", withoutFts],
	])("recall via %s", (_, wrap) => {
		it("matches quotes and AND literally, newest first, within the limit", async () => {
			const { memory } = await openFixture({ db: wrap(openNodeSqlite(":memory:")) });
			await memory.note({ content: 'He said "cloud first" and left', createdAt: 1 });
			await memory.note({ content: "Alpha AND beta on the cloud", createdAt: 2 });
			await memory.note({ content: "cloud native from day one", createdAt: 3 });
			await memory.note({ content: "nothing relevant here", createdAt: 4 });
			const ids = async (query: string, limit?: number) => (await memory.recall(query, { limit })).map((item) => (item.type === "memory" ? item.id : item));
			expect(await ids('"cloud first"')).toEqual([0]);
			expect(await ids("alpha AND beta")).toEqual([1]);
			expect(await ids("cloud")).toEqual([2, 1, 0]);
			expect(await ids("cloud", 2)).toEqual([2, 1]);
			expect(await memory.recall("cloud OR nothing")).toEqual([]);
			expect(await memory.recall("   ")).toEqual([]);
		});
	});
});
