import { defineMemoryObject } from "../../src/cloudflare/index.js";

/** Bracket-joins the children's content, so every summary is a literal function of its inputs. */
export const MemoryObject = defineMemoryObject<Cloudflare.Env>({
	summarizer: () => ({
		async summarize({ items }) {
			return `[${items.map((item) => item.content).join(" ")}]`;
		},
	}),
	mergesPerAlarm: 2,
});

/**
 * No summarizer: nothing schedules an alarm, and the test commits summaries itself. Two notes never
 * fit one summary, so every merge needs the client, and the view fits two of its summaries.
 */
export const ClientSummarizedObject = defineMemoryObject<Cloudflare.Env>({ limits: { summaryBytes: 4, viewBytes: 6 } });
