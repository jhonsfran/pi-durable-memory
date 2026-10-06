import type { SqlDatabase, SqlExecutor, SqlValue } from "../sqlite/database.js";

/** Values a Durable Object SQL binding accepts and returns. */
type DurableObjectSqlValue = ArrayBuffer | string | number | null;

/** The parts of a SQLite-backed Durable Object's `ctx.storage` the adapter uses, typed structurally so no Workers type is needed here. */
export interface DurableObjectSqlStorage {
	readonly sql: {
		exec(query: string, ...bindings: DurableObjectSqlValue[]): { toArray(): Record<string, DurableObjectSqlValue>[] };
	};
	transaction<T>(closure: () => Promise<T>): Promise<T>;
}

/** Runs operations one at a time in call order, so a transaction excludes every other operation. */
class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(operation: () => T | Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.catch(() => {});
		return result;
	}
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

/** Rows as returned, with `BLOB` columns converted to `Uint8Array` in place. */
function toRows<T>(rows: Record<string, DurableObjectSqlValue>[]): T[] {
	for (const row of rows) {
		for (const key in row) {
			const value = row[key];
			if (value instanceof ArrayBuffer) (row as Record<string, unknown>)[key] = new Uint8Array(value);
		}
	}
	return rows as T[];
}

/** `ctx.storage.sql` has no prepare step, so every call goes straight to `exec`. `guard` runs before each one. */
function executor(storage: DurableObjectSqlStorage, guard: () => void): SqlExecutor {
	const exec = (sql: string, params: readonly SqlValue[]) => {
		guard();
		return storage.sql.exec(sql, ...params.map(bindValue));
	};
	return {
		async exec(sql) {
			exec(sql, []);
		},
		async run(sql, ...params) {
			exec(sql, params);
		},
		async get<T extends object>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
			return toRows<T>(exec(sql, params).toArray())[0];
		},
		async all<T extends object>(sql: string, ...params: SqlValue[]): Promise<T[]> {
			return toRows<T>(exec(sql, params).toArray());
		},
	};
}

/** The `SqlDatabase` facade over a SQLite-backed Durable Object's `ctx.storage`. Integers are JavaScript numbers. */
export function durableObjectSql(storage: DurableObjectSqlStorage): SqlDatabase {
	const queue = new SerialQueue();
	const direct = executor(storage, () => {});
	return {
		exec: (sql) => queue.run(() => direct.exec(sql)),
		run: (sql, ...params) => queue.run(() => direct.run(sql, ...params)),
		get: (sql, ...params) => queue.run(() => direct.get(sql, ...params)),
		all: (sql, ...params) => queue.run(() => direct.all(sql, ...params)),
		// `ctx.storage.transaction()` commits when the closure resolves and rolls back when it rejects.
		transaction: (callback) =>
			queue.run(() =>
				storage.transaction(async () => {
					const scope = { active: true };
					const handle = executor(storage, () => {
						if (!scope.active) throw new Error("SQLite transaction handle is no longer active");
					});
					try {
						return await callback(handle);
					} finally {
						scope.active = false;
					}
				}),
			),
	};
}
