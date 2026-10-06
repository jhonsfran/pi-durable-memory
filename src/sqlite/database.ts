/** Values the SQL facade binds and returns. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/**
 * Asynchronous SQL operations shared by a database and its transaction handles. `exec` runs SQL
 * text without bindings and may contain several statements; the others run one statement with
 * positional bindings. Structurally identical to Pi Durable's `SqliteExecutor`.
 */
export interface SqlExecutor {
	exec(sql: string): Promise<void>;
	run(sql: string, ...params: SqlValue[]): Promise<void>;
	get<T extends object>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
	all<T extends object>(sql: string, ...params: SqlValue[]): Promise<T[]>;
}

/**
 * The database facade the SQLite store needs. `transaction` hands the callback a handle that is
 * valid until the callback settles; the adapter commits on resolve, rolls back on reject, and
 * queues every other operation until the transaction finishes. Pi Durable's `SqliteDatabase`
 * satisfies it without any import.
 */
export interface SqlDatabase extends SqlExecutor {
	transaction<T>(callback: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
