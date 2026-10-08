import { blockAt, blockLevel, blockSize, childrenOf, isAlignedBlock, label } from "./block.js";
import { InvalidRange, MemoryEntryEmpty, MemoryEntryTooLong } from "./errors.js";
import { summarize, summaryRequest } from "./summary.js";
import { byteLength, oneLine } from "./text.js";
import type { CompactResult, CreateMemoryOptions, Memory, MemoryEntry, MemoryItem, MemoryLimits, MemoryNode, MemoryRange, SummaryRequest } from "./types.js";
import { foldView } from "./view.js";
import type { FoldSource, Part } from "./view.js";

const DEFAULT_LIMITS: MemoryLimits = { maxEntryBytes: 280, summaryBytes: 512, viewBytes: 16_384 };
const DEFAULT_RECALL_LIMIT = 10;
const MAX_CONCURRENT_SUMMARIES = 8;

interface Job extends MemoryRange {
	readonly level: number;
	readonly children: readonly [string, string];
	readonly summary: string | undefined;
}

type Failure = CompactResult["failed"][number];

function normalizeEntry(text: string): string {
	const line = oneLine(text);
	if (line.length === 0) throw new MemoryEntryEmpty();
	return line;
}

const nodeKey = (level: number, startId: number): string => `${level}:${startId}`;

/** A memory nobody has superseded; only these reach the model and the summarizer. */
const live = (entry: MemoryEntry): boolean => entry.supersededBy === undefined;

const shown = (item: MemoryItem | undefined): item is MemoryItem => item !== undefined;

const startOf = (item: MemoryItem): number => (item.type === "memory" ? item.id : item.startId);

const firstUncovered = (view: readonly MemoryRange[]): number => (view.at(-1)?.endId ?? -1) + 1;

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

	async function viewItems(stored: readonly MemoryRange[], total: number): Promise<MemoryItem[]> {
		const end = firstUncovered(stored);
		const parts = [...stored, ...Array.from({ length: Math.max(0, total - end) }, (_, i) => blockAt(0, end + i))];
		return (await read(parts)).filter(shown);
	}

	const currentView = async (): Promise<MemoryItem[]> => viewItems(await store.readView(), await store.count());

	function requestFor(view: readonly MemoryItem[], job: Job): SummaryRequest {
		const context = view.filter((item) => startOf(item) <= job.endId).map((item) => item.content);
		return summaryRequest(context, job.children, summaryBytes);
	}

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

	async function foldOnce(): Promise<void> {
		const total = await store.count();
		const stored = await store.readView();
		const end = firstUncovered(stored);
		const levels = Array.from({ length: total < 2 ? 1 : Math.floor(Math.log2(total)) + 1 }, (_, level) => level);
		let source: FoldSource;
		if (stored.length === 0 && total > 0) {
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
		await foldView(parts, end, total, { high: viewBytes, low: viewBytes / 2 }, source);
		const before = new Map(stored.map((range) => [range.startId, blockLevel(range)]));
		const after = new Set(parts.map((part) => part.startId));
		const put = parts.filter((part) => before.get(part.startId) !== part.level).map((part) => blockAt(part.level, part.startId));
		const drop = stored.filter((range) => !after.has(range.startId)).map((range) => range.startId);
		if (put.length > 0 || drop.length > 0) await store.writeView({ put, drop });
	}

	let folding: Promise<void> = Promise.resolve();
	function fold(): Promise<void> {
		const run = folding.then(foldOnce);
		folding = run.catch(() => {});
		return run;
	}

	async function childTexts(level: number, block: MemoryRange): Promise<readonly [string, string]> {
		const [left, right] = childrenOf(block);
		const texts = new Map<number, string>();
		if (level === 1) for (const entry of await store.getMemories(block)) texts.set(entry.id, live(entry) ? entry.content : "");
		else for (const node of await store.getNodes([left, right].map((half) => ({ level: level - 1, startId: half.startId })))) texts.set(node.startId, node.summary);
		const [a, b] = [texts.get(left.startId), texts.get(right.startId)];
		if (a === undefined || b === undefined) throw new Error(`Cannot merge ${label(block)}: a child is missing`);
		return [a, b];
	}

	function freeMerge(children: readonly string[]): string | undefined {
		const texts = children.filter((text) => text.length > 0);
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

	async function readyJobs(limit: number, models: boolean, skip: ReadonlySet<string>): Promise<Job[]> {
		const total = await store.count();
		const jobs: Job[] = [];
		let below = total;
		for (let level = 1; 2 ** level <= total && jobs.length < limit; level++) {
			const built = await store.levelLength(level);
			for (let index = built; index < Math.floor(below / 2) && jobs.length < limit; index++) {
				const block = blockAt(level, index * 2 ** level);
				if (skip.has(nodeKey(level, block.startId))) break;
				const children = await childTexts(level, block);
				const summary = freeMerge(children);
				if (summary === undefined && !models) break;
				jobs.push({ ...block, level, children, summary });
			}
			below = built;
		}
		return jobs;
	}

	async function round(limit: number, models: boolean, skip: Set<string>, failed: Failure[]): Promise<number> {
		const jobs = await readyJobs(limit, models, skip);
		const view = jobs.some((job) => job.summary === undefined) ? await currentView() : [];
		const outcomes = await Promise.all(
			jobs.map(async (job) => {
				try {
					if (job.summary !== undefined) return { job, summary: job.summary };
					if (summarizer === undefined) throw new Error(`${label(job)} needs a model and this memory has no summarizer`);
					return { job, summary: await summarize(summarizer, requestFor(view, job), summaryBytes) };
				} catch (error) {
					return { job, error: error instanceof Error ? error.message : String(error) };
				}
			}),
		);
		let stored = 0;
		for (const outcome of outcomes) {
			const { job } = outcome;
			if ("error" in outcome) {
				skip.add(nodeKey(job.level, job.startId));
				failed.push({ startId: job.startId, endId: job.endId, message: outcome.error });
			} else if (await store.appendNode({ level: job.level, startId: job.startId, endId: job.endId, summary: outcome.summary })) {
				stored++;
			}
		}
		return stored;
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
			let [stored, total] = await Promise.all([store.readView(), store.count()]);
			if (firstUncovered(stored) < total) {
				await fold();
				[stored, total] = await Promise.all([store.readView(), store.count()]);
			}
			return { items: await viewItems(stored, total), total };
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
			const skip = new Set<string>();
			const failed: Failure[] = [];
			let merged = 0;
			for (;;) {
				const stored = await round(Math.min(MAX_CONCURRENT_SUMMARIES, maxMerges - merged), summarizer !== undefined, skip, failed);
				merged += stored;
				await fold();
				if (stored === 0 || merged >= maxMerges) break;
			}
			return { merged, pending: await pendingCount(await store.count()), failed };
		},

		async pending() {
			return pendingCount(await store.count());
		},

		async nextMerge() {
			let free = 0;
			for (;;) {
				const stored = await round(MAX_CONCURRENT_SUMMARIES, false, new Set(), []);
				if (stored === 0) break;
				free += stored;
			}
			if (free > 0) await fold();
			const [job] = await readyJobs(1, true, new Set());
			return job === undefined ? undefined : { startId: job.startId, endId: job.endId, request: requestFor(await currentView(), job) };
		},

		async commitMerge(range, summary) {
			assertBlock(range);
			const line = normalizeEntry(summary);
			const bytes = byteLength(line);
			if (bytes > summaryBytes) throw new MemoryEntryTooLong(bytes, summaryBytes);
			const stored = await store.appendNode({ level: blockLevel(range), startId: range.startId, endId: range.endId, summary: line });
			if (stored) await fold();
			return stored;
		},
	};
}
