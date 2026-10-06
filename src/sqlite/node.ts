import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqlDatabase, SqlExecutor, SqlValue } from "./database.js";

/** Runs operations one at a time in call order, so a transaction excludes every other operation. */
class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(operation: () => T | Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.catch(() => {});
		return result;
	}
}

/** Synchronous `node:sqlite` calls behind the async facade. `guard` runs before every call. */
function executor(database: DatabaseSync, statements: Map<string, StatementSync>, guard: () => void): SqlExecutor {
	const statement = (sql: string): StatementSync => {
		let prepared = statements.get(sql);
		if (prepared === undefined) {
			prepared = database.prepare(sql);
			statements.set(sql, prepared);
		}
		return prepared;
	};
	return {
		async exec(sql) {
			guard();
			database.exec(sql);
		},
		async run(sql, ...params) {
			guard();
			statement(sql).run(...params);
		},
		async get<T extends object>(sql: string, ...params: SqlValue[]) {
			guard();
			return statement(sql).get(...params) as T | undefined;
		},
		async all<T extends object>(sql: string, ...params: SqlValue[]) {
			guard();
			return statement(sql).all(...params) as T[];
		},
	};
}

/** Opens a `node:sqlite` database behind the `SqlDatabase` facade. `:memory:` works; file databases use WAL. */
export function openNodeSqlite(path: string): SqlDatabase {
	const database = new DatabaseSync(path);
	if (path !== ":memory:") database.exec("PRAGMA journal_mode = WAL");
	const queue = new SerialQueue();
	// Prepared statements are cached by SQL text on the connection, so transaction handles share them.
	const statements = new Map<string, StatementSync>();
	const direct = executor(database, statements, () => {});
	return {
		exec: (sql) => queue.run(() => direct.exec(sql)),
		run: (sql, ...params) => queue.run(() => direct.run(sql, ...params)),
		get: (sql, ...params) => queue.run(() => direct.get(sql, ...params)),
		all: (sql, ...params) => queue.run(() => direct.all(sql, ...params)),
		transaction: (callback) =>
			queue.run(async () => {
				const scope = { active: true };
				const handle = executor(database, statements, () => {
					if (!scope.active) throw new Error("SQLite transaction handle is no longer active");
				});
				database.exec("BEGIN");
				try {
					const result = await callback(handle);
					scope.active = false;
					database.exec("COMMIT");
					return result;
				} catch (error) {
					scope.active = false;
					try {
						database.exec("ROLLBACK");
					} catch (rollbackError) {
						throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
					}
					throw error;
				}
			}),
	};
}
