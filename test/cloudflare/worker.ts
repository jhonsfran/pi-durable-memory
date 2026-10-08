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
