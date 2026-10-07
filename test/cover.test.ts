import { describe, expect, it } from "vitest";
import { cover } from "../src/core/cover.js";

const size = (block: { startId: number; endId: number }): number => block.endId - block.startId + 1;

describe("cover", () => {
	it("returns one single per memory when everything fits", () => {
		expect(cover(8, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((id) => ({ startId: id, endId: id })));
	});

	it("returns no blocks for an empty log", () => {
		expect(cover(0, 96)).toEqual([]);
	});

	it("tiles 1000 memories with at most 96 aligned blocks, coarse to fine, ending in a single", () => {
		const blocks = cover(1000, 96);
		expect(blocks.length).toBe(96);
		expect(blocks[0]).toEqual({ startId: 0, endId: 63 });
		expect(blocks[1]).toEqual({ startId: 64, endId: 127 });
		expect(blocks[blocks.length - 1]).toEqual({ startId: 999, endId: 999 });
		let next = 0;
		let previousSize = Number.POSITIVE_INFINITY;
		for (const block of blocks) {
			expect(block.startId).toBe(next);
			expect(2 ** Math.round(Math.log2(size(block)))).toBe(size(block));
			expect(block.startId % size(block)).toBe(0);
			expect(size(block)).toBeLessThanOrEqual(previousSize);
			previousSize = size(block);
			next = block.endId + 1;
		}
		expect(next).toBe(1000);
	});
});
