import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createSqlDatabase } from "./adapter.js";
import type { SqlDatabase } from "./database.js";

/** Opens a `node:sqlite` database behind the `SqlDatabase` facade. `:memory:` works; file databases use WAL. */
export function openNodeSqlite(path: string): SqlDatabase {
	const database = new DatabaseSync(path);
	if (path !== ":memory:") database.exec("PRAGMA journal_mode = WAL");
	// Prepared statements are cached by SQL text on the connection, so transaction handles share them.
	const statements = new Map<string, StatementSync>();
	const statement = (sql: string): StatementSync => {
		let prepared = statements.get(sql);
		if (prepared === undefined) {
			prepared = database.prepare(sql);
			statements.set(sql, prepared);
		}
		return prepared;
	};
	return createSqlDatabase({
		execute: (sql, params) => statement(sql).all(...params),
		exec: (sql) => database.exec(sql),
		async transaction(body) {
			database.exec("BEGIN");
			try {
				const result = await body();
				database.exec("COMMIT");
				return result;
			} catch (error) {
				try {
					database.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
				}
				throw error;
			}
		},
	});
}
