import { blockAt, blockLevel, blockSize, childrenOf, isAlignedBlock, label } from "./block.js";
import { InvalidRange, MemoryEntryEmpty, MemoryEntryTooLong } from "./errors.js";
import type { CreateMemoryOptions, Memory, MemoryEntry, MemoryItem, MemoryLimits, MemoryNode, MemoryRange, SummarizeInput } from "./types.js";
import { foldView } from "./view.js";
import type { FoldSource, Part } from "./view.js";

const DEFAULT_LIMITS: MemoryLimits = { maxEntryBytes: 280, summaryBytes: 512, viewBytes: 16_384 };
const DEFAULT_RECALL_LIMIT = 10;

const encoder = new TextEncoder();

const byteLength = (text: string): number => encoder.encode(text).length;

/** A memory is one line: whitespace runs containing a line break collapse to one space. */
function normalizeEntry(text: string): string {
	const line = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
	if (line.length === 0) throw new MemoryEntryEmpty();
	return line;
}

/** Longest prefix of at most `maxBytes` UTF-8 bytes that ends on a character boundary. */
function truncateUtf8(text: string, maxBytes: number): string {
	if (byteLength(text) <= maxBytes) return text;
	// `encodeInto` never writes a partial code point, so `read` lands on a character boundary.
	const { read } = encoder.encodeInto(text, new Uint8Array(maxBytes));
	return text.slice(0, read);
}

const nodeKey = (level: number, startId: number): string => `${level}:${startId}`;

/** A memory nobody has superseded; only these reach the model and the summarizer. */
const live = (entry: MemoryEntry): boolean => entry.supersededBy === undefined;

const shown = (item: MemoryItem | undefined): item is MemoryItem => item !== undefined;

/** The first memory id a view does not cover. */
const endOf = (view: readonly MemoryRange[]): number => (view.at(-1)?.endId ?? -1) + 1;

function assertBlock(range: MemoryRange): void {
	if (!isAlignedBlock(range) || blockSize(range) < 2) {
		throw new InvalidRange(`${label(range)} is not a block: use an aligned power-of-two range of at least 2 memories, like #16-31`);
	}
}

/** Groups single-memory blocks into maximal contiguous id ranges, so each run is one store read. */
function contiguousRuns(blocks: readonly MemoryRange[]): MemoryRange[] {
	const runs: MemoryRange[] = [];
	for (const block of blocks) {
		const last = runs[runs.length - 1];
		if (last !== undefined && last.endId + 1 === block.startId) runs[runs.length - 1] = { startId: last.startId, endId: block.endId };
		else runs.push(block);
	}
	return runs;
}

export function createMemory({ store, summarizer, limits }: CreateMemoryOptions): Memory {
	const { maxEntryBytes, summaryBytes, viewBytes } = { ...DEFAULT_LIMITS, ...limits };

	/** Each block as `wake()` shows it, in the given order, with one read per kind; `undefined` for a superseded memory or an empty summary. */
	async function read(blocks: readonly MemoryRange[]): Promise<(MemoryItem | undefined)[]> {
		const singles = blocks.filter((block) => blockSize(block) === 1);
		const wide = blocks.filter((block) => blockSize(block) > 1);
		const [memoryRuns, nodes] = await Promise.all([
			Promise.all(contiguousRuns(singles).map((run) => store.getMemories(run))),
			wide.length === 0 ? [] : store.getNodes(wide.map((block) => ({ level: blockLevel(block), startId: block.startId }))),
		]);
		const memories = new Map<number, MemoryEntry>(memoryRuns.flat().map((entry) => [entry.id, entry]));
		const summaries = new Map<string, MemoryNode>(nodes.map((node) => [nodeKey(node.level, node.startId), node]));
		return blocks.map((block): MemoryItem | undefined => {
			if (blockSize(block) === 1) {
				const entry = memories.get(block.startId);
				if (entry === undefined) throw new Error(`Memory ${label(block)} is inside the log but the store has no entry for it`);
				return live(entry) ? { type: "memory", id: entry.id, createdAt: entry.createdAt, content: entry.content } : undefined;
			}
			const node = summaries.get(nodeKey(blockLevel(block), block.startId));
			if (node === undefined) throw new Error(`${label(block)} is shown but has no node`);
			return node.summary.length > 0 ? { type: "summary", startId: block.startId, endId: block.endId, content: node.summary } : undefined;
		});
	}

	/** The stored view, then one part per memory no fold has reached yet. */
	async function currentView(total: number): Promise<MemoryRange[]> {
		const stored = await store.readView();
		const end = endOf(stored);
		return [...stored, ...Array.from({ length: Math.max(0, total - end) }, (_, i) => blockAt(0, end + i))];
	}

	/** Sizes for one fold: the memories and nodes given are known, any other built node is read on first use. */
	function foldSource(levelLengths: readonly number[], memories: readonly MemoryEntry[], nodes: readonly MemoryNode[]): FoldSource {
		const sizes = new Map<string, number>();
		for (const entry of memories) sizes.set(nodeKey(0, entry.id), live(entry) ? byteLength(entry.content) : 0);
		for (const node of nodes) sizes.set(nodeKey(node.level, node.startId), byteLength(node.summary));
		return {
			levelLengths,
			async bytes(range) {
				const level = blockLevel(range);
				const known = sizes.get(nodeKey(level, range.startId));
				if (known !== undefined) return known;
				const [node] = await store.getNodes([{ level, startId: range.startId }]);
				if (node === undefined) throw new Error(`The fold needs ${label(range)}, which its level's length counts as built, but the store has no such node`);
				return byteLength(node.summary);
			},
		};
	}

	/** Brings the stored view up to the log and the built nodes, then writes only what changed. Idempotent: a fold after a crash appends what the last one missed. */
	async function foldOnce(): Promise<void> {
		const total = await store.count();
		const stored = await store.readView();
		const end = endOf(stored);
		const levels = Array.from({ length: total < 2 ? 1 : Math.floor(Math.log2(total)) + 1 }, (_, level) => level);
		let source: FoldSource;
		if (stored.length === 0 && total > 0) {
			// No stored view: a new scope, or one written before the view existed. One read of the whole log and tree replaces a read per memory.
			const [entries, nodes] = await Promise.all([store.getMemories({ startId: 0, endId: total - 1 }), store.listNodes()]);
			const levelLengths = levels.map(() => 0);
			for (const node of nodes) levelLengths[node.level] = Math.max(levelLengths[node.level] ?? 0, node.startId / 2 ** node.level + 1);
			source = foldSource(levelLengths, entries, nodes);
		} else {
			const [entries, levelLengths] = await Promise.all([
				end < total ? store.getMemories({ startId: end, endId: total - 1 }) : [],
				Promise.all(levels.map((level) => (level === 0 ? 0 : store.levelLength(level)))),
			]);
			source = foldSource(levelLengths, entries, []);
		}
		const items = await read(stored);
		const parts: Part[] = stored.map((range, index) => {
			const item = items[index];
			return { level: blockLevel(range), startId: range.startId, bytes: item === undefined ? 0 : byteLength(item.content) };
		});
		await foldView(parts, end, total, viewBytes, source);
		const before = new Map(stored.map((range) => [range.startId, blockLevel(range)]));
		const after = new Set(parts.map((part) => part.startId));
		const put = parts.filter((part) => before.get(part.startId) !== part.level).map((part) => blockAt(part.level, part.startId));
		const drop = stored.filter((range) => !after.has(range.startId)).map((range) => range.startId);
		if (put.length > 0 || drop.length > 0) await store.writeView({ put, drop });
	}

	let folding: Promise<void> = Promise.resolve();
	/** One fold at a time, so no fold writes a change computed from a view another fold has moved since. */
	function fold(): Promise<void> {
		const run = folding.then(foldOnce);
		folding = run.catch(() => {});
		return run;
	}

	/** The two children of a block, oldest first: two memories at level 1, two nodes one level down above it. A superseded memory reads as "". */
	async function children(level: number, block: MemoryRange): Promise<SummarizeInput["items"]> {
		if (level === 1) {
			const entries = await store.getMemories(block);
			return entries.map((entry) => ({ startId: entry.id, endId: entry.id, content: live(entry) ? entry.content : "" }));
		}
		const halves = childrenOf(block);
		const nodes = await store.getNodes(halves.map((half) => ({ level: level - 1, startId: half.startId })));
		return halves.map((half) => {
			const node = nodes.find((candidate) => candidate.startId === half.startId);
			if (node === undefined) {
				throw new Error(`Cannot summarize ${label(block)}: its half ${label(half)} has no summary at level ${level - 1}`);
			}
			return { startId: half.startId, endId: half.endId, content: node.summary };
		});
	}

	/** The node text when no model is needed: the non-empty children joined, if that fits `summaryBytes` or at most one is non-empty. */
	function freeMerge(items: SummarizeInput["items"]): string | undefined {
		const texts = items.map((item) => item.content).filter((text) => text.length > 0);
		const joined = texts.join(" / ");
		return texts.length < 2 || byteLength(joined) <= summaryBytes ? joined : undefined;
	}

	async function pendingCount(total: number): Promise<number> {
		let count = 0;
		for (let level = 1; 2 ** level <= total; level++) {
			count += Math.max(0, Math.floor(total / 2 ** level) - (await store.levelLength(level)));
		}
		return count;
	}

	/** The first block compaction would build now: levels ascending, then position. Nodes form a dense prefix per level, so `levelLength` is the cursor. */
	async function nextPendingBlock(total: number): Promise<MemoryRange | undefined> {
		for (let level = 1; 2 ** level <= total; level++) {
			const size = 2 ** level;
			const have = await store.levelLength(level);
			if (have < Math.floor(total / size)) return blockAt(level, have * size);
		}
		return undefined;
	}

	/**
	 * `nextMerge()` plus the number of free merges it stored on the way: a block that needs no model
	 * is stored here instead of being returned. `budget` caps those so `compact()` honors
	 * `maxMerges`. A lost `appendNode` race is left for the next read of the cursor to see.
	 */
	async function nextPending(budget: number): Promise<{ input: SummarizeInput | undefined; free: number }> {
		const total = await store.count();
		let free = 0;
		let lost: string | undefined;
		while (free < budget) {
			const block = await nextPendingBlock(total);
			if (block === undefined) break;
			const level = blockLevel(block);
			const key = nodeKey(level, block.startId);
			// A lost race leaves the node present, so the cursor moves on. If it did not, the store broke its contract; stop rather than spin.
			if (key === lost) break;
			const items = await children(level, block);
			const summary = freeMerge(items);
			if (summary === undefined) return { input: { ...block, items, maxBytes: summaryBytes }, free };
			if (await store.appendNode({ level, ...block, summary })) free++;
			else lost = key;
		}
		return { input: undefined, free };
	}

	async function appendSummary(range: MemoryRange, summary: string): Promise<boolean> {
		assertBlock(range);
		return store.appendNode({ level: blockLevel(range), startId: range.startId, endId: range.endId, summary: truncateUtf8(normalizeEntry(summary), summaryBytes) });
	}

	return {
		async note(input) {
			const content = normalizeEntry(input.content);
			const bytes = byteLength(content);
			if (bytes > maxEntryBytes) throw new MemoryEntryTooLong(bytes, maxEntryBytes);
			const { supersedes } = input;
			if (supersedes !== undefined) {
				const total = await store.count();
				if (!Number.isInteger(supersedes) || supersedes < 0 || supersedes >= total) {
					throw new InvalidRange(`#${supersedes} is not in the memory: it holds ${total} memories`);
				}
			}
			const entry = await store.appendMemory({ content, createdAt: input.createdAt ?? Date.now(), sourceId: input.sourceId, supersedes });
			await fold();
			return entry;
		},

		async wake() {
			const total = await store.count();
			const items = (await read(await currentView(total))).filter(shown);
			return { items, total };
		},

		async recall(query, options) {
			const entries = await store.searchMemories(query, options?.limit ?? DEFAULT_RECALL_LIMIT, options?.match ?? "all");
			// Superseded memories are dropped after the search, so the result can hold fewer than `limit` entries.
			return entries.filter(live);
		},

		async zoom(range) {
			const built = isAlignedBlock(range) && blockSize(range) >= 2 && (await store.getNodes([{ level: blockLevel(range), startId: range.startId }])).length > 0;
			if (!built) throw new InvalidRange(`${label(range)} is not a summary you can open: zoom a #a-b line you saw in memory or in an earlier zoom`);
			return (await read(childrenOf(range))).filter(shown);
		},

		async compact(options) {
			const maxMerges = options?.maxMerges ?? Number.POSITIVE_INFINITY;
			let merged = 0;
			let lost: string | undefined;
			while (merged < maxMerges) {
				const { input, free } = await nextPending(maxMerges - merged);
				merged += free;
				if (input === undefined || summarizer === undefined || merged >= maxMerges) break;
				const key = nodeKey(blockLevel(input), input.startId);
				// Same guard as `nextPending`: a lost commit must have left the node present, or the store broke its contract.
				if (key === lost) break;
				if (await appendSummary(input, await summarizer.summarize(input))) merged++;
				else lost = key;
			}
			await fold();
			return { merged, pending: await pendingCount(await store.count()) };
		},

		async pending() {
			return pendingCount(await store.count());
		},

		async nextMerge() {
			const { input, free } = await nextPending(Number.POSITIVE_INFINITY);
			if (free > 0) await fold();
			return input;
		},

		async commitMerge(range, summary) {
			const stored = await appendSummary(range, summary);
			if (stored) await fold();
			return stored;
		},
	};
}
