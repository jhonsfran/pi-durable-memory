import type { AdmissionDecision, MemoryAdmission } from "./extension.js";

/** A stored memory close to the candidate, as the judge sees it. */
export interface AdmissionNeighbor {
	readonly id: number;
	readonly content: string;
}

export interface JudgeInput {
	readonly candidate: string;
	/** The closest live memories of `scope`, best match first. */
	readonly neighbors: readonly AdmissionNeighbor[];
	readonly scope: string;
	readonly scopes: readonly string[];
}

export type JudgeVerdict =
	| { readonly verdict: "new" }
	| { readonly verdict: "duplicate"; readonly of: number }
	| { readonly verdict: "supersedes"; readonly id: number }
	| { readonly verdict: "reject"; readonly reason: string };

/** Decides what a candidate memory is, given the memories nearest to it. */
export interface AdmissionJudge {
	judge(input: JudgeInput): JudgeVerdict | Promise<JudgeVerdict>;
}

const DEFAULT_NEIGHBORS = 5;

/**
 * A judge may answer with an id it was never shown (a hallucinated id). Acting on it would hide
 * or discard a memory nobody compared the candidate against, so such a verdict counts as `new`.
 */
function decide(verdict: JudgeVerdict, neighbors: readonly AdmissionNeighbor[]): AdmissionDecision {
	const shown = (id: number): boolean => neighbors.some((neighbor) => neighbor.id === id);
	switch (verdict.verdict) {
		case "new":
			return { admit: true };
		case "duplicate":
			return shown(verdict.of) ? { admit: false, reason: `duplicate of #${verdict.of}` } : { admit: true };
		case "supersedes":
			return shown(verdict.id) ? { admit: true, supersedes: verdict.id } : { admit: true };
		case "reject":
			return { admit: false, reason: verdict.reason };
		default: {
			const exhaustive: never = verdict;
			throw new Error(`Unknown verdict ${String(exhaustive)}`);
		}
	}
}

/** Admission that recalls the memories nearest to the candidate and lets `judge` compare it against them. */
export function createRetrievalAdmission(options: { readonly judge: AdmissionJudge; readonly neighbors?: number | undefined }): MemoryAdmission {
	const limit = options.neighbors ?? DEFAULT_NEIGHBORS;
	return {
		async evaluate({ content, memory, scope, scopes }) {
			const hits = await memory.recall(content, { limit, match: "any" });
			const neighbors = hits.map((hit): AdmissionNeighbor => ({ id: hit.id, content: hit.content }));
			const verdict = await options.judge.judge({ candidate: content, neighbors, scope, scopes });
			return decide(verdict, neighbors);
		},
	};
}
