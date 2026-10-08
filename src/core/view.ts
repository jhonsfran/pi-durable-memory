import { blockAt } from "./block.js";
import type { MemoryRange } from "./types.js";

/** One line of the view: an aligned block and the UTF-8 size of the text it shows. */
export interface Part {
	readonly level: number;
	readonly startId: number;
	readonly bytes: number;
}

/** What a fold reads: which nodes are built, and the size of any memory or built node. */
export interface FoldSource {
	/** Nodes at a level form a dense prefix from 0, so the node at index `k` of `level` is built when `k < levelLengths[level]`. */
	readonly levelLengths: readonly number[];
	bytes(range: MemoryRange): Promise<number>;
}

/**
 * OptChat's fold (spec 5.2). Appends the memories `from .. total - 1` to `parts` one at a time, and
 * after each one, while the view is over `budget`, replaces the most due pair of sibling parts whose
 * parent is built by that parent. A pair at level `l` starting at `start` is due by
 * `(T - start) / 2^(l + 2)`: the oldest relative to its size goes first, so detail fades with age
 * and each level keeps about as many lines. Nothing is ever split, so the view only grows at its end
 * and coarsens, and its start stays byte-identical for the provider's prompt cache. Changes `parts`
 * in place.
 */
export async function foldView(parts: Part[], from: number, total: number, budget: number, source: FoldSource): Promise<void> {
	let size = parts.reduce((sum, part) => sum + part.bytes, 0);
	const width = Array.from({ length: source.levelLengths.length + 2 }, (_, level) => 2 ** level);
	/** A block at `level` starting before `builtEnd[level]` is built: the dense prefix ends there. */
	const builtEnd = width.map((blockWidth, level) => (source.levelLengths[level] ?? 0) * blockWidth);
	const settled = new Uint8Array(width.length);

	async function shrink(t: number): Promise<void> {
		while (size > budget) {
			let best: { index: number; due: number; bytes: number } | undefined;
			// Within one level the oldest pair is the most due, so a level is settled by its first candidate.
			settled.fill(0);
			for (let index = 0; index + 1 < parts.length; index++) {
				const a = parts[index];
				const b = parts[index + 1];
				if (a === undefined || b === undefined || a.level !== b.level || settled[a.level] === 1) continue;
				const parentWidth = width[a.level + 1] ?? Number.POSITIVE_INFINITY;
				if (a.startId % parentWidth !== 0 || a.startId >= (builtEnd[a.level + 1] ?? 0)) continue;
				settled[a.level] = 1;
				const due = (t - a.startId) / (2 * parentWidth);
				if (best === undefined || due > best.due) best = { index, due, bytes: a.bytes + b.bytes };
			}
			// No pair has a built parent: the view waits over budget until compaction builds one.
			if (best === undefined) return;
			const first = parts[best.index];
			if (first === undefined) return;
			const parent = { level: first.level + 1, startId: first.startId, bytes: await source.bytes(blockAt(first.level + 1, first.startId)) };
			parts.splice(best.index, 2, parent);
			size += parent.bytes - best.bytes;
		}
	}

	for (let id = from; id < total; id++) {
		const bytes = await source.bytes({ startId: id, endId: id });
		parts.push({ level: 0, startId: id, bytes });
		size += bytes;
		await shrink(id + 1);
	}
	if (from >= total) await shrink(total);
}
