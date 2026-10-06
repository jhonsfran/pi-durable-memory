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
		expect(await a.memory.recall("m1")).toEqual([{ id: 1, createdAt: 1_700_000_000_001, content: "m1" }]);
		expect(await b.store.getNodes([{ level: 1, startId: 0 }, { level: 2, startId: 0 }])).toEqual([]);
		expect(await b.store.levelLength(1)).toBe(0);
		expect(await a.store.levelLength(1)).toBe(2);
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
			expect((await memory.recall('"cloud first"')).map((entry) => entry.id)).toEqual([0]);
			expect((await memory.recall("alpha AND beta")).map((entry) => entry.id)).toEqual([1]);
			expect((await memory.recall("cloud")).map((entry) => entry.id)).toEqual([2, 1, 0]);
			expect((await memory.recall("cloud", { limit: 2 })).map((entry) => entry.id)).toEqual([2, 1]);
			expect(await memory.recall("cloud OR nothing")).toEqual([]);
			expect(await memory.recall("   ")).toEqual([]);
		});
	});
});
