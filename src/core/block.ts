import type { MemoryRange } from "./types.js";

export const blockSize = (range: MemoryRange): number => range.endId - range.startId + 1;

/** `log2` of the block size: level 0 is one memory, level 1 two, and so on. Meaningful only for aligned blocks. */
export const blockLevel = (range: MemoryRange): number => Math.round(Math.log2(blockSize(range)));

/** True when the range is a non-empty power-of-two block whose `startId` is a multiple of its size. */
export function isAlignedBlock(range: MemoryRange): boolean {
	const size = blockSize(range);
	return range.startId >= 0 && size >= 1 && 2 ** blockLevel(range) === size && range.startId % size === 0;
}

/** How the model reads a range: `#5` for one memory, `#0-7` for a block. */
export const label = (range: MemoryRange): string => (blockSize(range) === 1 ? `#${range.startId}` : `#${range.startId}-${range.endId}`);

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
