import type { MemoryRange } from "./types.js";

/** Half-open `[lo, hi)`; only this module works with half-open ranges. */
type Span = readonly [lo: number, hi: number];

const toRange = ([lo, hi]: Span): MemoryRange => ({ startId: lo, endId: hi - 1 });

export const blockSize = (range: MemoryRange): number => range.endId - range.startId + 1;

/** `log2` of the block size: level 0 is one memory, level 1 two, and so on. Meaningful only for aligned blocks. */
export const blockLevel = (range: MemoryRange): number => Math.round(Math.log2(blockSize(range)));

/** True when the range is a non-empty power-of-two block whose `startId` is a multiple of its size. */
export function isAlignedBlock(range: MemoryRange): boolean {
	const size = blockSize(range);
	return range.startId >= 0 && size >= 1 && 2 ** blockLevel(range) === size && range.startId % size === 0;
}

export function blockAt(level: number, startId: number): MemoryRange {
	return { startId, endId: startId + 2 ** level - 1 };
}

/** The two halves of a block of size at least 2. */
export function childrenOf(range: MemoryRange): readonly [MemoryRange, MemoryRange] {
	const half = blockSize(range) / 2;
	return [
		{ startId: range.startId, endId: range.startId + half - 1 },
		{ startId: range.startId + half, endId: range.endId },
	];
}

/**
 * Tiles `[0, total)` with aligned power-of-two blocks, keeping a block whole only when its size is
 * at most `alpha` times its age. A larger alpha gives a coarser tiling with fewer blocks.
 */
function tile(total: number, alpha: number): Span[] {
	let root = 1;
	while (root < total) root *= 2;
	const out: Span[] = [];
	// Right child is pushed first so the left is popped first, which keeps `out` sorted.
	const stack: Span[] = [[0, root]];
	for (let span = stack.pop(); span !== undefined; span = stack.pop()) {
		const [lo, hi] = span;
		if (lo >= total) continue;
		const size = hi - lo;
		if (size > 1 && (hi > total || size > alpha * (total - lo))) {
			const mid = (lo + hi) / 2;
			stack.push([mid, hi], [lo, mid]);
		} else {
			out.push(span);
		}
	}
	return out;
}

/**
 * The blocks `wake()` shows: at most `budget` of them, oldest first, finest near the newest memory.
 * When everything fits, every memory is its own block.
 */
export function cover(total: number, budget: number): MemoryRange[] {
	if (total <= 0 || budget <= 0) return [];
	if (total <= budget) return Array.from({ length: total }, (_, id) => ({ startId: id, endId: id }));
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (tile(total, mid).length > budget) lo = mid;
		else hi = mid;
	}
	const out = tile(total, hi);
	// Block sizes jump in powers of two, so alpha alone can undershoot the budget. The remainder
	// is spent on the newest blocks, where detail is worth most.
	while (out.length < budget) {
		let i = out.length - 1;
		// biome-ignore lint/style/noNonNullAssertion: `i` is bounds-checked by the loop condition
		while (i >= 0 && out[i]![1] - out[i]![0] === 1) i--;
		if (i < 0) break;
		// biome-ignore lint/style/noNonNullAssertion: `i >= 0` was checked on the previous line
		const [blockLo, blockHi] = out[i]!;
		const mid = (blockLo + blockHi) / 2;
		out.splice(i, 1, [blockLo, mid], [mid, blockHi]);
	}
	return out.map(toRange);
}
