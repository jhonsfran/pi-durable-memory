import { choice, noul } from "@typesafe-ai/sdk";
import type { EntryType, Questions, TypeSafeClient } from "@typesafe-ai/sdk";
import { createRetrievalAdmission } from "../pi/admission.js";
import type { AdmissionJudge, AdmissionNeighbor, JudgeVerdict } from "../pi/admission.js";
import type { MemoryAdmission } from "../pi/extension.js";

export interface JevJudgeOptions {
	/** A TypeSafe client, or anything with its `systemOne` method. */
	readonly client: Pick<TypeSafeClient, "systemOne">;
	/** Below this probability of "durable" the note is rejected. Default 0.5. */
	readonly minDurable?: number | undefined;
	/** Below this confidence a duplicate/supersedes relation is treated as new. Default 0.6. */
	readonly minRelation?: number | undefined;
	readonly model?: string | undefined;
}

const DEFAULT_MIN_DURABLE = 0.5;
const DEFAULT_MIN_RELATION = 0.6;

const DURABLE = noul(
	"Is the candidate a durable fact worth remembering across future sessions: a preference, decision, constraint, identity, outcome or lesson, rather than a greeting, a transient step, routine tool output or a status update?",
);

const RELATION = choice("How does the candidate relate to the existing memories?", {
	new: "States something none of the existing memories state",
	duplicate: "Restates an existing memory with no new information",
	supersedes: "Replaces or contradicts an existing memory with newer information",
});

/** Neighbors are offered to the model as labels `m<id>`; `targetId` reads the id back out of the chosen label. */
const targetLabel = (neighbor: AdmissionNeighbor): string => `m${neighbor.id}`;

function targetId(label: string): number | undefined {
	const match = /^m(\d+)$/.exec(label);
	return match?.[1] === undefined ? undefined : Number(match[1]);
}

const targetQuestion = (neighbors: readonly AdmissionNeighbor[]) =>
	choice("Which existing memory does the candidate duplicate or replace?", {
		none: null,
		...Object.fromEntries(neighbors.map((neighbor) => [targetLabel(neighbor), neighbor.content])),
	});

export function createJevJudge(options: JevJudgeOptions): AdmissionJudge {
	const { client, model } = options;
	const minDurable = options.minDurable ?? DEFAULT_MIN_DURABLE;
	const minRelation = options.minRelation ?? DEFAULT_MIN_RELATION;
	const ask = <const Q extends Questions>(state: EntryType, questions: Q) =>
		client.systemOne(model === undefined ? { state, questions } : { state, questions, model });

	return {
		async judge({ candidate, neighbors }): Promise<JudgeVerdict> {
			const state = { candidate, existing: neighbors.map((neighbor) => ({ id: `#${neighbor.id}`, text: neighbor.content })) };
			if (neighbors.length === 0) {
				const { answers } = await ask(state, { durable: DURABLE });
				return durability(answers.durable.noul, minDurable) ?? { verdict: "new" };
			}
			const { answers } = await ask(state, { durable: DURABLE, relation: RELATION, target: targetQuestion(neighbors) });
			const rejected = durability(answers.durable.noul, minDurable);
			if (rejected !== undefined) return rejected;
			const { relation, target } = answers;
			if (relation.choice === "new" || relation.confidence < minRelation || target.choice === "none") return { verdict: "new" };
			const id = targetId(target.choice);
			if (id === undefined) return { verdict: "new" };
			return relation.choice === "duplicate" ? { verdict: "duplicate", of: id } : { verdict: "supersedes", id };
		},
	};
}

function durability(probability: number, minDurable: number): JudgeVerdict | undefined {
	return probability < minDurable ? { verdict: "reject", reason: `not durable (p=${probability.toFixed(2)})` } : undefined;
}

export function createJevAdmission(options: JevJudgeOptions & { readonly neighbors?: number | undefined }): MemoryAdmission {
	return createRetrievalAdmission({ judge: createJevJudge(options), neighbors: options.neighbors });
}
