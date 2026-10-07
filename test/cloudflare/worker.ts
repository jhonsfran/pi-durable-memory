import { defineMemoryObject, durableObjectSql } from "../../src/cloudflare/index.js";
import type { Embedder } from "../../src/index.js";
import { createSqliteVectorIndex } from "../../src/sqlite/index.js";

/**
 * Each concept group owns one dimension, so "automobile" lands where "car" does without sharing a
 * token. Words outside the table contribute nothing, so a text without a concept is the zero
 * vector and never matches: the lexical-only expectations of the other tests still hold.
 */
const CONCEPTS: readonly (readonly string[])[] = [["car", "automobile"], ["pnpm"], ["berlin"], ["rust"]];

const conceptEmbedder: Embedder = {
	async embed(texts) {
		return texts.map((text) => {
			const vector = new Float32Array(CONCEPTS.length);
			for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
				const concept = CONCEPTS.findIndex((group) => group.includes(word));
				if (concept !== -1) vector[concept] = 1;
			}
			return vector;
		});
	},
};

/** Bracket-joins the children's content, so every summary is a literal function of its inputs. */
export const MemoryObject = defineMemoryObject<Cloudflare.Env>({
	summarizer: () => ({
		async summarize({ items }) {
			return `[${items.map((item) => item.content).join(" ")}]`;
		},
	}),
	index: (_env, ctx) => createSqliteVectorIndex(durableObjectSql(ctx.storage), { scope: "self", embedder: conceptEmbedder }),
	mergesPerAlarm: 2,
});
