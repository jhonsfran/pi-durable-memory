import { describe, expect, it } from "vitest";
import { buildSummaryPrompt } from "../src/index.js";

describe("buildSummaryPrompt", () => {
	it("states the contract and lists the items, citing memory ids for raw input and ranges for two children", () => {
		expect(
			buildSummaryPrompt({
				startId: 0,
				endId: 1,
				maxBytes: 280,
				items: [
					{ startId: 0, endId: 0, content: "prefers brevity" },
					{ startId: 1, endId: 1, content: "deploys on friday" },
				],
			}),
		).toBe(
			"Compress memories #0-1 into one line of at most 280 bytes.\n" +
				"Keep standing facts that are still true (preferences, decisions in force, constraints, identities, numbers), verbatim where possible, each followed by the id of the memory that states it in parentheses, like (#0).\n" +
				"Drop events, greetings, and transient details. Invent nothing. Output the line only.\n" +
				"\n" +
				"#0 prefers brevity\n" +
				"#1 deploys on friday",
		);
		expect(
			buildSummaryPrompt({
				startId: 512,
				endId: 1023,
				maxBytes: 280,
				items: [
					{ startId: 512, endId: 767, content: "likes tabs (#532)" },
					{ startId: 768, endId: 1023, content: "deploys on friday (#900)" },
				],
			}),
		).toBe(
			"Compress memories #512-1023 into one line of at most 280 bytes.\n" +
				"Keep standing facts that are still true (preferences, decisions in force, constraints, identities, numbers), verbatim where possible, each followed by the range of the child summary that states it in parentheses, like (#512-767).\n" +
				"Drop events, greetings, and transient details. Invent nothing. Output the line only.\n" +
				"\n" +
				"#512-767 likes tabs (#532)\n" +
				"#768-1023 deploys on friday (#900)",
		);
	});
});
