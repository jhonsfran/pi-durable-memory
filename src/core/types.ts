/**
 * The data shape of one memory scope.
 *
 * A scope is one append-only log of memories, identified by position, plus a binary tree of
 * summaries built over aligned power-of-two blocks of that log. The core knows nothing about
 * scopes beyond "this instance is one of them": multi-scope composition (one Durable Object per
 * scope) lives outside `createMemory()`.
 *
 * Ranges are inclusive at both ends everywhere in this public surface, matching how they are
 * shown to the model (`#0-7`). Internal block arithmetic may use half-open ranges, but nothing
 * half-open crosses this file.
 */

/** One raw memory. `id` is its 0-based position in the scope's log and never changes. */
export interface MemoryEntry {
	readonly id: number;
	readonly createdAt: number;
	readonly content: string;
	/** Idempotency key supplied by the writer, such as a Pi Durable tool task id. */
	readonly sourceId?: string;
	/** The older memory this one replaces. The older one stays in the log and is hidden from `wake()`, `recall()` and the summarizer. */
	readonly supersedes?: number;
	/** The newer memory that replaced this one, when one exists. */
	readonly supersededBy?: number;
}

/** An aligned power-of-two block of the log: `endId - startId + 1` is a power of two and `startId` is a multiple of it. */
export interface MemoryRange {
	readonly startId: number;
	readonly endId: number;
}

/** One node of the summary tree. `level` 1 covers 2 memories, level 2 covers 4, and so on. Raw memories are level 0 and are not stored as nodes. */
export interface MemoryNode extends MemoryRange {
	readonly level: number;
	readonly summary: string;
}

/**
 * What `wake()` and `zoom()` hand to the caller, oldest first.
 *
 * `pending` is a block whose summary compaction has not produced yet. It keeps the item budget
 * exact and tells the model the block exists so it can `zoom()` into it.
 */
export type MemoryItem =
	| { readonly type: "memory"; readonly id: number; readonly createdAt: number; readonly content: string }
	| { readonly type: "summary"; readonly startId: number; readonly endId: number; readonly content: string }
	| { readonly type: "pending"; readonly startId: number; readonly endId: number };

export interface MemoryContext {
	readonly items: readonly MemoryItem[];
	/** Memories in the scope when the context was computed. */
	readonly total: number;
}

export interface NoteInput {
	readonly content: string;
	/** When set, a second `note()` with the same `sourceId` returns the first entry instead of appending. */
	readonly sourceId?: string | undefined;
	/** Milliseconds since epoch. Defaults to now. */
	readonly createdAt?: number | undefined;
	/** Id of an existing memory this one replaces. Throws `InvalidRange` when it is not in the log. */
	readonly supersedes?: number | undefined;
}

export interface WakeOptions {
	/** Upper bound on `MemoryContext.items.length`. Defaults to `MemoryLimits.maxItems`. */
	readonly maxItems?: number | undefined;
}

/** `all`: every query word must match. `any`: one word is enough, best match first. */
export type RecallMatch = "all" | "any";

export interface RecallOptions {
	/** Defaults to 10. */
	readonly limit?: number | undefined;
	/** Defaults to `all`. */
	readonly match?: RecallMatch | undefined;
}

export interface CompactOptions {
	/** Stop after this many merges. Defaults to all pending merges. */
	readonly maxMerges?: number | undefined;
}

export interface CompactResult {
	readonly merged: number;
	/** Merges still missing after this call. */
	readonly pending: number;
}

export interface MemoryLimits {
	/** Longest memory or summary, in UTF-8 bytes. A summary over the cap is truncated to it. Default 280. */
	readonly maxEntryBytes: number;
	/** Blocks of at most this many memories are summarized from the raw memories; larger blocks from their two child summaries. Default 16. */
	readonly rawThreshold: number;
	/** Default `wake()` item budget. Default 96. */
	readonly maxItems: number;
}

/** What a summarizer sees: the block to compress and its children, which are raw memories or two child summaries. */
export interface SummarizeInput extends MemoryRange {
	/** Oldest first. A raw memory has `startId === endId`. */
	readonly items: ReadonlyArray<MemoryRange & { readonly content: string }>;
	readonly maxBytes: number;
}

export interface MemorySummarizer {
	summarize(input: SummarizeInput): Promise<string>;
}

/** One scope's memory. Every method is safe to call concurrently with the others and to retry after a crash. */
export interface Memory {
	note(input: NoteInput): Promise<MemoryEntry>;
	wake(options?: WakeOptions): Promise<MemoryContext>;
	/** Memories whose text contains every word of the query, newest first; with `match: "any"`, memories containing at least one word, best match first. Superseded memories are excluded. */
	recall(query: string, options?: RecallOptions): Promise<MemoryEntry[]>;
	/** The two halves of one block, each rendered as `wake()` renders it. Throws `InvalidRange` for a range that is not an aligned block inside the log. */
	zoom(range: MemoryRange): Promise<MemoryItem[]>;
	compact(options?: CompactOptions): Promise<CompactResult>;
	/** Merges that `compact()` would perform now. */
	pending(): Promise<number>;
	/**
	 * The next block compaction would summarize, with its children, or `undefined` when nothing is
	 * pending. Together with `commitMerge()` this lets a caller supply the summary itself; `compact()`
	 * is the same two steps with the injected summarizer in between.
	 */
	nextMerge(): Promise<SummarizeInput | undefined>;
	/** Store the summary for a block `nextMerge()` returned. False when that block is no longer pending. The summary is normalized and truncated like a note. */
	commitMerge(range: MemoryRange, summary: string): Promise<boolean>;
}

/**
 * Storage for one scope. The core algorithm runs against this interface; `createSqliteMemoryStore`
 * implements it over the Durable Object's SQLite.
 *
 * Nodes at one level form a dense prefix from `startId` 0: `compact()` builds them in order and
 * never deletes one. `levelLength()` relies on that invariant.
 */
export interface MemoryStore {
	count(): Promise<number>;
	/** Append at position `count()`, or return the existing entry with the same `sourceId`. Atomic. */
	appendMemory(input: {
		readonly content: string;
		readonly sourceId?: string | undefined;
		readonly createdAt: number;
		readonly supersedes?: number | undefined;
	}): Promise<MemoryEntry>;
	/** Entries with ids in the range, ascending. Ids beyond the log are simply absent. */
	getMemories(range: MemoryRange): Promise<MemoryEntry[]>;
	/** Full-text matches: every word, newest first, for `all`; at least one word, best match first, for `any`. Superseded memories are included; the core filters. */
	searchMemories(query: string, limit: number, match: RecallMatch): Promise<MemoryEntry[]>;
	getNodes(keys: ReadonlyArray<{ readonly level: number; readonly startId: number }>): Promise<MemoryNode[]>;
	/** False when a node with the same `(level, startId)` already exists; the existing node is kept. */
	putNode(node: MemoryNode): Promise<boolean>;
	/** Number of nodes at `level`, which by invariant are the blocks `0 .. n-1` of that level. */
	levelLength(level: number): Promise<number>;
}

export interface CreateMemoryOptions {
	readonly store: MemoryStore;
	/** Writes summaries in `compact()`. Without one, `compact()` performs no merges and callers summarize through `nextMerge()` and `commitMerge()`. */
	readonly summarizer?: MemorySummarizer | undefined;
	readonly limits?: Partial<MemoryLimits> | undefined;
}
