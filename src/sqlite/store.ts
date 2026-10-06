import type { MemoryEntry, MemoryNode, MemoryStore } from "../core/types.js";
import type { SqlDatabase, SqlExecutor } from "./database.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
	scope TEXT NOT NULL,
	id INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	content TEXT NOT NULL,
	source_id TEXT,
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

const FTS_SCHEMA = "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, scope UNINDEXED, id UNINDEXED)";

const MEMORY_COLUMNS = "id, created_at, content, source_id";
const NEXT_ID = "SELECT COALESCE(MAX(id) + 1, 0) AS id FROM memories WHERE scope = ?";

/** Durable Object SQL allows 100 bound parameters per statement; 48 keys plus the scope stay under it. */
const NODE_KEYS_PER_QUERY = 48;

type MemoryRow = { id: number; created_at: number; content: string; source_id: string | null };
type NodeRow = { level: number; start_id: number; end_id: number; summary: string };
type SearchMode = "fts" | "like";

function toEntry(row: MemoryRow): MemoryEntry {
	const entry: MemoryEntry = { id: row.id, createdAt: row.created_at, content: row.content };
	return row.source_id === null ? entry : { ...entry, sourceId: row.source_id };
}

const toNode = (row: NodeRow): MemoryNode => ({ level: row.level, startId: row.start_id, endId: row.end_id, summary: row.summary });

const tokens = (query: string): string[] => query.split(/\s+/).filter((token) => token.length > 0);

/** Each token as a quoted FTS5 phrase, so user text is never read as FTS syntax. */
const ftsExpression = (words: readonly string[]): string => words.map((word) => `"${word.replaceAll('"', '""')}"`).join(" AND ");

const likePattern = (word: string): string => `%${word.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

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
	const searchMode = await detectSearchMode(db);

	const search: Record<SearchMode, (words: string[], limit: number) => Promise<MemoryRow[]>> = {
		fts: (words, limit) =>
			db.all<MemoryRow>(
				`SELECT m.id, m.created_at, m.content, m.source_id FROM memories_fts
				JOIN memories m ON m.scope = memories_fts.scope AND m.id = memories_fts.id
				WHERE memories_fts MATCH ? AND memories_fts.scope = ? ORDER BY m.id DESC LIMIT ?`,
				ftsExpression(words),
				scope,
				limit,
			),
		like: (words, limit) =>
			db.all<MemoryRow>(
				`SELECT ${MEMORY_COLUMNS} FROM memories WHERE scope = ?${" AND content LIKE ? ESCAPE '\\'".repeat(words.length)} ORDER BY id DESC LIMIT ?`,
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
					const existing = await tx.get<MemoryRow>(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE scope = ? AND source_id = ?`, scope, input.sourceId);
					if (existing !== undefined) return toEntry(existing);
				}
				const next = await tx.get<{ id: number }>(NEXT_ID, scope);
				const id = next?.id ?? 0;
				await tx.run(
					"INSERT INTO memories (scope, id, created_at, content, source_id) VALUES (?, ?, ?, ?, ?)",
					scope,
					id,
					input.createdAt,
					input.content,
					input.sourceId ?? null,
				);
				if (searchMode === "fts") await tx.run("INSERT INTO memories_fts (content, scope, id) VALUES (?, ?, ?)", input.content, scope, id);
				return toEntry({ id, created_at: input.createdAt, content: input.content, source_id: input.sourceId ?? null });
			});
		},

		async getMemories(range) {
			const rows = await db.all<MemoryRow>(
				`SELECT ${MEMORY_COLUMNS} FROM memories WHERE scope = ? AND id BETWEEN ? AND ? ORDER BY id`,
				scope,
				range.startId,
				range.endId,
			);
			return rows.map(toEntry);
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
