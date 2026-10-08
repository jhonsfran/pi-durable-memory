import { blockAt } from "./block.js";
import type { MemoryRange } from "./types.js";

export interface Part {
	readonly level: number;
	readonly startId: number;
	readonly bytes: number;
}

export interface FoldSource {
	readonly levelLengths: readonly number[];
	bytes(range: MemoryRange): Promise<number>;
}

/** How long ago a pair of sibling lines ended, in its own line size. Measuring from the pair's first message instead rewrites old lines that Taelin's push keeps. */
const due = (total: number, startId: number, level: number): number => {
	const last = startId + 2 ** (level + 1) - 1;
	return (total - last) / 2 ** level;
};

export async function foldView(parts: Part[], from: number, total: number, budget: number, source: FoldSource): Promise<void> {
	let size = parts.reduce((sum, part) => sum + part.bytes, 0);
	const width = Array.from({ length: source.levelLengths.length + 2 }, (_, level) => 2 ** level);
	const builtEnd = width.map((blockWidth, level) => (source.levelLengths[level] ?? 0) * blockWidth);
	const oldestPairFound = new Uint8Array(width.length);

	async function shrink(t: number): Promise<void> {
		while (size > budget) {
			let best: { index: number; due: number; bytes: number } | undefined;
			oldestPairFound.fill(0);
			for (let index = 0; index + 1 < parts.length; index++) {
				const a = parts[index];
				const b = parts[index + 1];
				if (a === undefined || b === undefined || a.level !== b.level || oldestPairFound[a.level] === 1) continue;
				const parentWidth = width[a.level + 1] ?? Number.POSITIVE_INFINITY;
				if (a.startId % parentWidth !== 0 || a.startId >= (builtEnd[a.level + 1] ?? 0)) continue;
				oldestPairFound[a.level] = 1;
				const pairDue = due(t, a.startId, a.level);
				if (best === undefined || pairDue > best.due) best = { index, due: pairDue, bytes: a.bytes + b.bytes };
			}
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
