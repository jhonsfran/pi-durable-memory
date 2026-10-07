import { label } from "./cover.js";
import type { SummarizeInput } from "./types.js";

/**
 * The prompt a model summarizer sends for one block, pure in its input. Items are raw memories
 * (`#id text`) or the block's two child summaries (`#a-b text`); the citation form follows suit so
 * every kept fact points back to the memory or child that states it.
 */
export function buildSummaryPrompt(input: SummarizeInput): string {
	const first = input.items[0];
	const children = first !== undefined && first.startId !== first.endId;
	const cite = children ? `the range of the child summary that states it in parentheses, like (${label(first)})` : `the id of the memory that states it in parentheses, like (#${first?.startId ?? input.startId})`;
	return [
		`Compress memories ${label(input)} into one line of at most ${input.maxBytes} bytes.`,
		`Keep standing facts that are still true (preferences, decisions in force, constraints, identities, numbers), verbatim where possible, each followed by ${cite}.`,
		"Drop events, greetings, and transient details. Invent nothing. Output the line only.",
		"",
		...input.items.map((item) => `${label(item)} ${item.content}`),
	].join("\n");
}
