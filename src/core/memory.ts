import { blockAt, blockLevel, blockSize, childrenOf, cover, isAlignedBlock, label } from "./cover.js";
import { InvalidRange, MemoryEntryEmpty, MemoryEntryTooLong } from "./errors.js";
import { encodeIndexKey } from "./index-key.js";
import type {
	CreateMemoryOptions,
	IndexKey,
	Memory,
	MemoryEntry,
	MemoryItem,
	MemoryLimits,
	MemoryNode,
	MemoryRange,
	RecallItem,
	SummarizeInput,
} from "./types.js";

const DEFAULT_LIMITS: MemoryLimits = { maxEntryBytes: 280, rawThreshold: 16, maxItems: 96 };
const DEFAULT_RECALL_LIMIT = 10;
/** Reciprocal rank fusion constant: `score = sum of 1 / (RRF_K + rank)` over the lists a key appears in. */
const RRF_K = 60;
/** Stored as the summary of a block whose every memory was superseded, so the summarizer never sees an empty block. */
const SUPERSEDED_BLOCK_SUMMARY = "(every memory in this block was superseded)";

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

/** Keys of several ranked lists merged by reciprocal rank, best first; ties keep list order. */
function fuseByReciprocalRank(lists: ReadonlyArray<readonly IndexKey[]>): IndexKey[] {
	const fused = new Map<string, { key: IndexKey; score: number }>();
	for (const list of lists) {
		list.forEach((key, i) => {
			const encoded = encodeIndexKey(key);
			const hit = fused.get(encoded) ?? { key, score: 0 };
			hit.score += 1 / (RRF_K + i + 1);
			fused.set(encoded, hit);
		});
	}
	return [...fused.values()].sort((a, b) => b.score - a.score).map((hit) => hit.key);
}

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

export function createMemory({ store, summarizer, index, limits }: CreateMemoryOptions): Memory {
	const { maxEntryBytes, rawThreshold, maxItems } = { ...DEFAULT_LIMITS, ...limits };

	/** Each block rendered as `wake()` shows it, in the given order, with one read per kind. */
	async function render(blocks: readonly MemoryRange[]): Promise<MemoryItem[]> {
		const singles = blocks.filter((block) => blockSize(block) === 1);
		const wide = blocks.filter((block) => blockSize(block) > 1);
		const [memoryRuns, nodes] = await Promise.all([
			Promise.all(contiguousRuns(singles).map((run) => store.getMemories(run))),
			wide.length === 0 ? [] : store.getNodes(wide.map((block) => ({ level: blockLevel(block), startId: block.startId }))),
		]);
		const memories = new Map<number, MemoryEntry>(memoryRuns.flat().map((entry) => [entry.id, entry]));
		const summaries = new Map<string, MemoryNode>(nodes.map((node) => [nodeKey(node.level, node.startId), node]));
		return blocks.flatMap((block): MemoryItem[] => {
			if (blockSize(block) === 1) {
				const entry = memories.get(block.startId);
				if (entry === undefined) throw new Error(`Memory ${label(block)} is inside the log but the store has no entry for it`);
				return live(entry) ? [{ type: "memory", id: entry.id, createdAt: entry.createdAt, content: entry.content }] : [];
			}
			const node = summaries.get(nodeKey(blockLevel(block), block.startId));
			return [
				node === undefined
					? { type: "pending", startId: block.startId, endId: block.endId }
					: { type: "summary", startId: block.startId, endId: block.endId, content: node.summary },
			];
		});
	}

	async function summarizeInputs(level: number, block: MemoryRange): Promise<SummarizeInput["items"]> {
		if (blockSize(block) <= rawThreshold) {
			const entries = await store.getMemories(block);
			return entries.filter(live).map((entry) => ({ startId: entry.id, endId: entry.id, content: entry.content }));
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

	async function pendingCount(total: number): Promise<number> {
		let count = 0;
		for (let level = 1; 2 ** level <= total; level++) {
			count += Math.max(0, Math.floor(total / 2 ** level) - (await store.levelLength(level)));
		}
		return count;
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
			await index?.upsert([{ key: { kind: "memory", id: entry.id }, text: entry.content }]);
			return entry;
		},

		async wake(options) {
			const total = await store.count();
			const items = await render(cover(total, options?.maxItems ?? maxItems));
			return { items, total };
		},

		async recall(query, options) {
			const limit = options?.limit ?? DEFAULT_RECALL_LIMIT;
			const summaries = options?.summaries ?? true;
			const [lexical, semantic] = await Promise.all([
				store.searchMemories(query, limit),
				index === undefined || query.trim().length === 0 ? [] : index.query(query, limit),
			]);
			const fused = fuseByReciprocalRank([lexical.map((entry) => ({ kind: "memory", id: entry.id })), semantic.map((hit) => hit.key)]);
			const memories = new Map<number, MemoryEntry>(lexical.map((entry) => [entry.id, entry]));
			const missingIds = fused.flatMap((key) => (key.kind === "memory" && !memories.has(key.id) ? [key.id] : []));
			const nodeKeys = summaries ? fused.flatMap((key) => (key.kind === "node" ? [key] : [])) : [];
			const [resolved, nodes] = await Promise.all([
				missingIds.length === 0 ? [] : store.getMemoriesByIds(missingIds),
				nodeKeys.length === 0 ? [] : store.getNodes(nodeKeys),
			]);
			for (const entry of resolved) memories.set(entry.id, entry);
			const summariesByKey = new Map<string, MemoryNode>(nodes.map((node) => [nodeKey(node.level, node.startId), node]));
			// Superseded memories and forgotten nodes are dropped after fusion, so the result can hold fewer than `limit` items.
			return fused
				.flatMap((key): RecallItem[] => {
					if (key.kind === "memory") {
						const entry = memories.get(key.id);
						return entry !== undefined && live(entry) ? [{ type: "memory", id: entry.id, createdAt: entry.createdAt, content: entry.content }] : [];
					}
					const node = summariesByKey.get(nodeKey(key.level, key.startId));
					return node === undefined ? [] : [{ type: "summary", startId: node.startId, endId: node.endId, content: node.summary }];
				})
				.slice(0, limit);
		},

		async zoom(range) {
			assertBlock(range);
			const total = await store.count();
			if (range.startId >= total) throw new InvalidRange(`${label(range)} is beyond the memory: it holds ${total} memories`);
			return render(childrenOf(range).filter((half) => half.startId < total));
		},

		async compact(options) {
			const maxMerges = options?.maxMerges ?? Number.POSITIVE_INFINITY;
			const total = await store.count();
			let merged = 0;
			for (let level = 1; 2 ** level <= total && merged < maxMerges; level++) {
				const size = 2 ** level;
				const needed = Math.floor(total / size);
				for (let have = await store.levelLength(level); have < needed && merged < maxMerges; have++) {
					const block = blockAt(level, have * size);
					const items = await summarizeInputs(level, block);
					const raw = items.length === 0 ? SUPERSEDED_BLOCK_SUMMARY : await summarizer.summarize({ ...block, items, maxBytes: maxEntryBytes });
					const summary = truncateUtf8(normalizeEntry(raw), maxEntryBytes);
					// Indexed before `putNode` so a failed upsert leaves the node unbuilt and the host's retry redoes both.
					await index?.upsert([{ key: { kind: "node", level, startId: block.startId }, text: summary }]);
					if (await store.putNode({ level, ...block, summary })) merged++;
				}
			}
			return { merged, pending: await pendingCount(total) };
		},

		async pending() {
			return pendingCount(await store.count());
		},

		async forget(range) {
			assertBlock(range);
			const total = await store.count();
			let dropped = 0;
			for (let level = blockLevel(range); 2 ** level <= total; level++) {
				const size = 2 ** level;
				dropped += await store.truncateLevel(level, Math.floor(range.startId / size) * size);
			}
			return dropped;
		},
	};
}
