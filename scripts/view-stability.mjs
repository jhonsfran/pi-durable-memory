import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [repo, notesArg = "2000", viewArg = "24000"] = process.argv.slice(2);
const N = Number(notesArg);
const VIEW = Number(viewArg);
const load = (path) => import(pathToFileURL(join(repo, "dist", path)).href);
const { createMemory, formatMemoryContext } = await load("index.js");
const { createSqliteMemoryStore } = await load("sqlite/store.js");
const { createSqlDatabase } = await load("sqlite/adapter.js");

function openDb() {
	const database = new DatabaseSync(":memory:");
	const statements = new Map();
	const statement = (sql) => statements.get(sql) ?? statements.set(sql, database.prepare(sql)).get(sql);
	return createSqlDatabase({
		execute: (sql, params) => statement(sql).all(...params),
		exec: (sql) => database.exec(sql),
		async transaction(body) {
			database.exec("BEGIN");
			try {
				const result = await body();
				database.exec("COMMIT");
				return result;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	});
}

const WORDS = "billing deploy approval tabs pnpm workerd stripe invoice acme scope alarm summary zoom recall budget cache tree node view fold note user prefers decided failed because owner tests".split(" ");
function pseudo(seed, bytes) {
	const words = [];
	let digest = createHash("sha256").update(seed).digest();
	let i = 0;
	while (words.join(" ").length < bytes) {
		if (i === digest.length) {
			digest = createHash("sha256").update(digest).digest();
			i = 0;
		}
		words.push(WORDS[digest[i++] % WORDS.length]);
	}
	return words.join(" ").slice(0, bytes).trim();
}

const summarizer = {
	async summarize(input) {
		return pseudo(input.items.map((item) => item.content).join("|"), 250);
	},
	async complete(request) {
		const last = request.turns.at(-1);
		return pseudo(last.blocks.join("|"), 250);
	},
};

const memory = createMemory({ store: await createSqliteMemoryStore(openDb(), { scope: "s" }), summarizer, limits: { viewBytes: VIEW } });
const shared = (a, b) => {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i;
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

let previous = "";
const ratios = [];
const sizes = [];
const sharedChars = [];
for (let id = 0; id < N; id++) {
	await memory.note({ content: `note ${id}: ${pseudo(`n${id}`, 110)}`, createdAt: id });
	await memory.compact();
	const view = formatMemoryContext(await memory.wake());
	if (id >= N / 2 && previous.length > 0) {
		const s = shared(previous, view);
		ratios.push(s / previous.length);
		sharedChars.push(s);
		sizes.push(view.length);
	}
	previous = view;
}
const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
console.log(
	JSON.stringify({
		notes: N,
		measuredOver: `notes ${N / 2}..${N - 1}`,
		medianViewChars: median(sizes),
		medianSharedPrefixChars: median(sharedChars),
		meanSharedRatio: Number(mean.toFixed(3)),
		medianSharedRatio: Number(median(ratios).toFixed(3)),
		turnsBelowHalf: ratios.filter((r) => r < 0.5).length,
		turns: ratios.length,
	}),
);
