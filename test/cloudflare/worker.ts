import { defineMemoryObject } from "../../src/cloudflare/index.js";

/** The tests' short notes always merge without a model, so this summarizer only has to exist for the alarm to run. */
export const MemoryObject = defineMemoryObject<Cloudflare.Env>({
	summarizer: () => ({ complete: async () => "summary" }),
	mergesPerAlarm: 2,
});

/**
 * No summarizer: nothing schedules an alarm, and the test commits summaries itself. Two notes never
 * fit one summary, so every merge needs the client, and the view fits two of its summaries.
 */
export const ClientSummarizedObject = defineMemoryObject<Cloudflare.Env>({ limits: { summaryBytes: 4, viewBytes: 6 } });

/** Fails its first call and answers "ok" after that. Two notes never fit one summary, so every merge needs it. */
export const FlakyObject = defineMemoryObject<Cloudflare.Env>({
	summarizer: () => {
		let calls = 0;
		return {
			async complete() {
				calls++;
				if (calls === 1) throw new Error("model down");
				return "ok";
			},
		};
	},
	limits: { summaryBytes: 4 },
});
