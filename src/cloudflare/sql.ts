import { createSqlDatabase } from "../sqlite/adapter.js";
import type { SqlDatabase, SqlValue } from "../sqlite/database.js";

/** Values a Durable Object SQL binding accepts and returns. */
type DurableObjectSqlValue = ArrayBuffer | string | number | null;

/** The parts of a SQLite-backed Durable Object's `ctx.storage` the adapter uses, typed structurally so no Workers type is needed here. */
export interface DurableObjectSqlStorage {
	readonly sql: {
		exec(query: string, ...bindings: DurableObjectSqlValue[]): { toArray(): Record<string, DurableObjectSqlValue>[] };
	};
	transaction<T>(closure: () => Promise<T>): Promise<T>;
}

/** Durable Object SQL binds numbers as doubles: a `bigint` outside the safe integer range would lose precision. */
function bindValue(value: SqlValue): DurableObjectSqlValue {
	if (value instanceof Uint8Array) return value.slice().buffer as ArrayBuffer;
	if (typeof value !== "bigint") return value;
	if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new RangeError(`Durable Object SQL cannot bind ${value} without losing precision`);
	}
	return Number(value);
}

/** Rows with `BLOB` columns converted to `Uint8Array`. */
const toRows = (rows: Record<string, DurableObjectSqlValue>[]): Record<string, unknown>[] =>
	rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof ArrayBuffer ? new Uint8Array(value) : value])));

/** The `SqlDatabase` facade over a SQLite-backed Durable Object's `ctx.storage`. Integers are JavaScript numbers. */
export function durableObjectSql(storage: DurableObjectSqlStorage): SqlDatabase {
	return createSqlDatabase({
		execute: (sql, params) => toRows(storage.sql.exec(sql, ...params.map(bindValue)).toArray()),
		exec: (sql) => {
			storage.sql.exec(sql);
		},
		// `ctx.storage.transaction()` commits when the closure resolves and rolls back when it rejects.
		transaction: (body) => storage.transaction(body),
	});
}
