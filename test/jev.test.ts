import { APIPromise } from "@typesafe-ai/sdk";
import type { Questions, SystemOneRequest, SystemOneResult, TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { createJevJudge } from "../src/jev/index.js";
import type { JudgeInput } from "../src/index.js";

type Answers = Record<string, { type: "noul"; noul: number } | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }>;

/**
 * Records every request and answers from `answers`. The SDK types `answers` by the questions of each call, which a
 * canned fake cannot satisfy generically, so the one cast lives here.
 */
function fakeClient(answers: Answers) {
	const requests: SystemOneRequest[] = [];
	const client: Pick<TypeSafeClient, "systemOne"> = {
		systemOne<const Q extends Questions>(request: SystemOneRequest<Q>) {
			requests.push(request);
			const result = { model: "fake", usage: { input_tokens: 0, output_tokens: 0 }, answers } as unknown as SystemOneResult<Q>;
			return new APIPromise(Promise.resolve(new Response()), async () => result);
		},
	};
	return { client, requests };
}

const durable = (p: number) => ({ type: "noul" as const, noul: p });
const pick = (choice: string, confidence = 0.9) => ({ type: "choice" as const, choice, confidence, probabilities: { [choice]: confidence } });

const twoNeighbors: JudgeInput = {
	candidate: "prefers detail",
	neighbors: [
		{ id: 3, content: "prefers brevity" },
		{ id: 7, content: "uses pnpm" },
	],
	scope: "agent:a",
	scopes: ["agent:a"],
};

const alone: JudgeInput = { candidate: "prefers detail", neighbors: [], scope: "agent:a", scopes: ["agent:a"] };

describe("jev judge", () => {
	it("asks one systemOne question set about the candidate and its neighbors", async () => {
		const { client, requests } = fakeClient({ durable: durable(0.9), relation: pick("new"), target: pick("none") });
		await createJevJudge({ client, model: "jev-test" }).judge(twoNeighbors);
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request?.model).toBe("jev-test");
		expect(request?.state).toEqual({
			candidate: "prefers detail",
			existing: [
				{ id: "#3", text: "prefers brevity" },
				{ id: "#7", text: "uses pnpm" },
			],
		});
		expect(Object.keys(request?.questions ?? {}).sort()).toEqual(["durable", "relation", "target"]);
		expect(request?.questions.target?.criteria).toEqual({ none: null, m3: "prefers brevity", m7: "uses pnpm" });
	});

	it("asks only about durability when there are no neighbors", async () => {
		const { client, requests } = fakeClient({ durable: durable(0.9) });
		expect(await createJevJudge({ client }).judge(alone)).toEqual({ verdict: "new" });
		expect(requests.map((request) => Object.keys(request.questions))).toEqual([["durable"]]);
		expect(requests[0]?.model).toBeUndefined();
	});

	it("rejects a candidate below the durable threshold with its probability", async () => {
		const { client } = fakeClient({ durable: durable(0.2), relation: pick("supersedes"), target: pick("m3") });
		expect(await createJevJudge({ client }).judge(twoNeighbors)).toEqual({ verdict: "reject", reason: "not durable (p=0.20)" });
		expect(await createJevJudge({ client, minDurable: 0.1 }).judge(twoNeighbors)).toEqual({ verdict: "supersedes", id: 3 });
	});

	it("treats a low-confidence relation as new", async () => {
		const { client } = fakeClient({ durable: durable(0.9), relation: pick("duplicate", 0.4), target: pick("m3") });
		expect(await createJevJudge({ client }).judge(twoNeighbors)).toEqual({ verdict: "new" });
		expect(await createJevJudge({ client, minRelation: 0.3 }).judge(twoNeighbors)).toEqual({ verdict: "duplicate", of: 3 });
	});

	it("reports a duplicate of the chosen memory", async () => {
		const { client } = fakeClient({ durable: durable(0.9), relation: pick("duplicate"), target: pick("m3") });
		expect(await createJevJudge({ client }).judge(twoNeighbors)).toEqual({ verdict: "duplicate", of: 3 });
	});

	it("reports the memory the candidate supersedes", async () => {
		const { client } = fakeClient({ durable: durable(0.9), relation: pick("supersedes"), target: pick("m7") });
		expect(await createJevJudge({ client }).judge(twoNeighbors)).toEqual({ verdict: "supersedes", id: 7 });
	});

	it("treats a relation without a target as new", async () => {
		const { client } = fakeClient({ durable: durable(0.9), relation: pick("supersedes"), target: pick("none") });
		expect(await createJevJudge({ client }).judge(twoNeighbors)).toEqual({ verdict: "new" });
	});
});
