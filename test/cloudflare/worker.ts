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
