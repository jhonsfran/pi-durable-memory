import type { MemoryEntry, MemoryNode, MemoryStore } from "../core/types.js";
import type { SqlDatabase, SqlExecutor } from "./database.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
	scope TEXT NOT NULL,
	id INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	content TEXT NOT NULL,
	source_id TEXT,
	supersedes INTEGER,
	PRIMARY KEY (scope, id),
	UNIQUE (scope, source_id)
);
CREATE TABLE IF NOT EXISTS memory_nodes (
	scope TEXT NOT NULL,
	level INTEGER NOT NULL,
	start_id INTEGER NOT NULL,
	end_id INTEGER NOT NULL,
	summary TEXT NOT NULL,
	PRIMARY KEY (scope, level, start_id)
);
`;

const SUPERSEDES_INDEX = "CREATE INDEX IF NOT EXISTS memories_supersedes ON memories(scope, supersedes)";

const FTS_SCHEMA = "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, scope UNINDEXED, id UNINDEXED)";

/**
 * Every memory read is `SELECT ${MEMORY_COLUMNS} FROM ${MEMORY_FROM} WHERE m.scope = ? ... GROUP BY m.id`:
 * `superseded_by` is the oldest memory that replaced this one. A correlated `MIN()` subquery is
 * planned through the primary key and scans the whole scope per row; the join uses `memories_supersedes`.
 */
const MEMORY_COLUMNS = "m.id, m.created_at, m.content, m.source_id, m.supersedes, MIN(n.id) AS superseded_by";
const SUPERSEDED_JOIN = "LEFT JOIN memories n ON n.scope = m.scope AND n.supersedes = m.id";
const MEMORY_FROM = `memories m ${SUPERSEDED_JOIN}`;
const NEXT_ID = "SELECT COALESCE(MAX(id) + 1, 0) AS id FROM memories WHERE scope = ?";

/** Durable Object SQL allows 100 bound parameters per statement; 48 keys plus the scope stay under it. */
const NODE_KEYS_PER_QUERY = 48;
const IDS_PER_QUERY = 96;

type MemoryRow = { id: number; created_at: number; content: string; source_id: string | null; supersedes: number | null; superseded_by: number | null };
type NodeRow = { level: number; start_id: number; end_id: number; summary: string };
type SearchMode = "fts" | "like";

function toEntry(row: MemoryRow): MemoryEntry {
	return {
		id: row.id,
		createdAt: row.created_at,
		content: row.content,
		...(row.source_id === null ? {} : { sourceId: row.source_id }),
		...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
		...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
	};
}

const toNode = (row: NodeRow): MemoryNode => ({ level: row.level, startId: row.start_id, endId: row.end_id, summary: row.summary });

const tokens = (query: string): string[] => query.split(/\s+/).filter((token) => token.length > 0);

/** Each token as a quoted FTS5 phrase, so user text is never read as FTS syntax. */
const ftsExpression = (words: readonly string[]): string => words.map((word) => `"${word.replaceAll('"', '""')}"`).join(" AND ");

const likePattern = (word: string): string => `%${word.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/** Databases created before `supersedes` existed gain the column; `CREATE TABLE IF NOT EXISTS` leaves them untouched. */
async function migrateSupersedes(db: SqlDatabase): Promise<void> {
	const columns = await db.all<{ name: string }>("PRAGMA table_info(memories)");
	if (!columns.some((column) => column.name === "supersedes")) await db.exec("ALTER TABLE memories ADD COLUMN supersedes INTEGER");
	await db.exec(SUPERSEDES_INDEX);
}

async function detectSearchMode(db: SqlDatabase): Promise<SearchMode> {
	try {
		await db.exec(FTS_SCHEMA);
		return "fts";
	} catch {
		return "like";
	}
}

async function changes(tx: SqlExecutor): Promise<number> {
	const row = await tx.get<{ n: number }>("SELECT changes() AS n");
	return row?.n ?? 0;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

/** One scope's `MemoryStore` inside a database that may hold many scopes. Runs the migration on open. */
export async function createSqliteMemoryStore(db: SqlDatabase, options: { readonly scope: string }): Promise<MemoryStore> {
	const { scope } = options;
	await db.exec(SCHEMA);
	await migrateSupersedes(db);
	const searchMode = await detectSearchMode(db);

	const search: Record<SearchMode, (words: string[], limit: number) => Promise<MemoryRow[]>> = {
		fts: (words, limit) =>
			db.all<MemoryRow>(
				`SELECT ${MEMORY_COLUMNS} FROM memories_fts
				JOIN memories m ON m.scope = memories_fts.scope AND m.id = memories_fts.id ${SUPERSEDED_JOIN}
				WHERE memories_fts MATCH ? AND memories_fts.scope = ? GROUP BY m.id ORDER BY m.id DESC LIMIT ?`,
				ftsExpression(words),
				scope,
				limit,
			),
		like: (words, limit) =>
			db.all<MemoryRow>(
				`SELECT ${MEMORY_COLUMNS} FROM ${MEMORY_FROM} WHERE m.scope = ?${" AND m.content LIKE ? ESCAPE '\\'".repeat(words.length)} GROUP BY m.id ORDER BY m.id DESC LIMIT ?`,
				scope,
				...words.map(likePattern),
				limit,
			),
	};

	return {
		async count() {
			const row = await db.get<{ id: number }>(NEXT_ID, scope);
			return row?.id ?? 0;
		},

		appendMemory(input) {
			return db.transaction(async (tx) => {
				if (input.sourceId !== undefined) {
					const existing = await tx.get<MemoryRow>(`SELECT ${MEMORY_COLUMNS} FROM ${MEMORY_FROM} WHERE m.scope = ? AND m.source_id = ? GROUP BY m.id`, scope, input.sourceId);
					if (existing !== undefined) return toEntry(existing);
				}
				const next = await tx.get<{ id: number }>(NEXT_ID, scope);
				const id = next?.id ?? 0;
				await tx.run(
					"INSERT INTO memories (scope, id, created_at, content, source_id, supersedes) VALUES (?, ?, ?, ?, ?, ?)",
					scope,
					id,
					input.createdAt,
					input.content,
					input.sourceId ?? null,
					input.supersedes ?? null,
				);
				if (searchMode === "fts") await tx.run("INSERT INTO memories_fts (content, scope, id) VALUES (?, ?, ?)", input.content, scope, id);
				// Nothing can point at the newest id yet, so `superseded_by` is null without a read.
				return toEntry({
					id,
					created_at: input.createdAt,
					content: input.content,
					source_id: input.sourceId ?? null,
					supersedes: input.supersedes ?? null,
					superseded_by: null,
				});
			});
		},

		async getMemories(range) {
			const rows = await db.all<MemoryRow>(
				`SELECT ${MEMORY_COLUMNS} FROM ${MEMORY_FROM} WHERE m.scope = ? AND m.id BETWEEN ? AND ? GROUP BY m.id ORDER BY m.id`,
				scope,
				range.startId,
				range.endId,
			);
			return rows.map(toEntry);
		},

		async getMemoriesByIds(ids) {
			const found: MemoryEntry[] = [];
			for (const part of chunk(ids, IDS_PER_QUERY)) {
				const rows = await db.all<MemoryRow>(
					`SELECT ${MEMORY_COLUMNS} FROM ${MEMORY_FROM} WHERE m.scope = ? AND m.id IN (${part.map(() => "?").join(", ")}) GROUP BY m.id`,
					scope,
					...part,
				);
				found.push(...rows.map(toEntry));
			}
			return found;
		},

		async searchMemories(query, limit) {
			const words = tokens(query);
			if (words.length === 0) return [];
			const rows = await search[searchMode](words, limit);
			return rows.map(toEntry);
		},

		async getNodes(keys) {
			const found: MemoryNode[] = [];
			for (const part of chunk(keys, NODE_KEYS_PER_QUERY)) {
				const rows = await db.all<NodeRow>(
					`SELECT level, start_id, end_id, summary FROM memory_nodes WHERE scope = ? AND (${part.map(() => "(level = ? AND start_id = ?)").join(" OR ")})`,
					scope,
					...part.flatMap((key) => [key.level, key.startId]),
				);
				found.push(...rows.map(toNode));
			}
			return found;
		},

		putNode(node) {
			return db.transaction(async (tx) => {
				await tx.run(
					"INSERT OR IGNORE INTO memory_nodes (scope, level, start_id, end_id, summary) VALUES (?, ?, ?, ?, ?)",
					scope,
					node.level,
					node.startId,
					node.endId,
					node.summary,
				);
				return (await changes(tx)) === 1;
			});
		},

		async levelLength(level) {
			// Durable Object SQL binds numbers as doubles, so the division stays in JavaScript.
			const row = await db.get<{ last: number | null }>("SELECT MAX(start_id) AS last FROM memory_nodes WHERE scope = ? AND level = ?", scope, level);
			return row?.last == null ? 0 : Math.floor(row.last / 2 ** level) + 1;
		},

		truncateLevel(level, fromStartId) {
			return db.transaction(async (tx) => {
				await tx.run("DELETE FROM memory_nodes WHERE scope = ? AND level = ? AND start_id >= ?", scope, level, fromStartId);
				return changes(tx);
			});
		},
	};
}
