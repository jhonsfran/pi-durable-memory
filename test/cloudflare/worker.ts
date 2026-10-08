import { defineMemoryObject } from "../../src/cloudflare/index.js";

export const MemoryObject = defineMemoryObject<Cloudflare.Env>({
	summarizer: () => ({ complete: async () => "summary" }),
	mergesPerAlarm: 2,
});

export const ClientSummarizedObject = defineMemoryObject<Cloudflare.Env>({ limits: { summaryBytes: 4, viewBytes: 6 } });

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
