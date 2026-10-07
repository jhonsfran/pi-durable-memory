import type { SqlDatabase, SqlExecutor, SqlValue } from "./database.js";

/** What a SQLite engine must provide for `createSqlDatabase` to build the `SqlDatabase` facade over it. */
export interface SqlDriver {
	/** Run one statement; `params` are already bound values the driver accepts. Returns rows for a query, an empty array otherwise. */
	execute(sql: string, params: readonly SqlValue[]): Record<string, unknown>[];
	/** Run several statements with no bindings. */
	exec(sql: string): void;
	/** Bracket `body` in a transaction: commit when it resolves, roll back when it rejects, then rethrow. */
	transaction<T>(body: () => Promise<T>): Promise<T>;
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

/** The synchronous driver behind the async facade. `guard` runs before every call. */
function executor(driver: SqlDriver, guard: () => void): SqlExecutor {
	return {
		async exec(sql) {
			guard();
			driver.exec(sql);
		},
		async run(sql, ...params) {
			guard();
			driver.execute(sql, params);
		},
		async get<T extends object>(sql: string, ...params: SqlValue[]) {
			guard();
			return driver.execute(sql, params)[0] as T | undefined;
		},
		async all<T extends object>(sql: string, ...params: SqlValue[]) {
			guard();
			return driver.execute(sql, params) as T[];
		},
	};
}

/** The `SqlDatabase` facade over a driver: serialized calls, and a transaction handle that stops working once the transaction settles. */
export function createSqlDatabase(driver: SqlDriver): SqlDatabase {
	const queue = new SerialQueue();
	const direct = executor(driver, () => {});
	return {
		exec: (sql) => queue.run(() => direct.exec(sql)),
		run: (sql, ...params) => queue.run(() => direct.run(sql, ...params)),
		get: (sql, ...params) => queue.run(() => direct.get(sql, ...params)),
		all: (sql, ...params) => queue.run(() => direct.all(sql, ...params)),
		transaction: (callback) =>
			queue.run(() =>
				driver.transaction(async () => {
					let active = true;
					const handle = executor(driver, () => {
						if (!active) throw new Error("SQLite transaction handle is no longer active");
					});
					try {
						return await callback(handle);
					} finally {
						active = false;
					}
				}),
			),
	};
}
