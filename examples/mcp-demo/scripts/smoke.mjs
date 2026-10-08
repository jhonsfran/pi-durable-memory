// Usage: node scripts/smoke.mjs [base URL, default http://localhost:8787]
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] ?? "http://localhost:8787";
const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const url = `${base}/m/${id}`;
console.log(`memory ${url}`);

// Every pair of these notes is over the 512-byte summary limit, so each pair needs a line from the agent instead of a free merge.
const notes = [
	"User prefers concise answers in English with code before prose and tables for comparisons; when unsure, ask one direct question instead of guessing, and name the file and line when pointing at a bug so the change can be found without searching the repository.",
	"Deploys go through CI and need Ana's approval; never deploy on Fridays or during the Monday billing run, and roll back first and debug second when an error alarm fires, because the June 3 incident got worse while the team tried a forward fix in production.",
	"Billing is usage-based on Stripe, but Acme pays by invoice because its procurement cannot use cards; Seb owns the invoice job, which runs on the first of each month and must finish before nine in the morning Berlin time so finance can send the payment reminders.",
	"The Postgres move to Neon failed on a missing pg_cron extension and was rolled back the same day; retry once the vendor confirms support, and keep the nightly cleanup jobs on the old cluster until then, since the dashboard reads from both databases during the move.",
	"Tests run inside workerd with pnpm check on Node 22; the workers suite is slow and flaky on cold caches, so run it twice before calling a failure real, and never mock the Durable Object storage, because the SQLite behavior is exactly what the tests must cover.",
	"Model spend is capped at 500 USD a month and was half used by the 12th; prefer the cheapest summarizer that keeps lines under the byte limit, log every model call with its cost and latency, and alert Seb in the billing channel once spend passes 80 percent of the budget.",
];

const client = new Client({ name: "smoke", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

async function call(name, args = {}) {
	const result = await client.callTool({ name, arguments: args });
	return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError === true };
}

async function ok(name, args) {
	const { text, isError } = await call(name, args);
	assert.equal(isError, false, `${name} returned an error: ${text}`);
	return text;
}

async function refused(name, args) {
	const { text, isError } = await call(name, args);
	assert.equal(isError, true, `${name} should be a tool error, got: ${text}`);
	return text;
}

const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
assert.deepEqual(tools, ["memory_commit", "memory_note", "memory_pending", "memory_recall", "memory_wake", "memory_zoom"]);
assert.match(client.getInstructions() ?? "", /Call memory_wake at the start of every session/);
console.log(`ok tools: ${tools.join(", ")}`);

assert.equal(await ok("memory_wake"), "No memories yet.");
console.log("ok empty wake");

for (const [index, content] of notes.entries()) assert.equal(await ok("memory_note", { content }), `Saved as #${index}.`);
console.log(`ok noted ${notes.length}`);

const firstWords = (line) => line.split(" ").slice(0, 4).join(" ");
const lines = new Map();
for (;;) {
	const prompt = await ok("memory_pending");
	if (prompt === "Nothing to summarize.") break;
	const [, startId, endId] = /^Call memory_commit with startId (\d+), endId (\d+), and your line as summary\.$/m.exec(prompt).map(Number);
	assert.match(prompt, /^You write the long-term memory of an AI agent\./);
	assert.match(prompt, /^Merge these two adjacent lines into one line of at most 512 bytes \(about 70 words\), the length of this ruler:\n-{512}\n/m);
	const [, left, right] = /^<input>\n(.+)\n(.+)\n<\/input>$/m.exec(prompt);
	const summary = `${firstWords(left)} / ${firstWords(right)}`;
	if (lines.size === 0) {
		assert.equal(await refused("memory_commit", { startId, endId, summary: " " }), "A memory is one line of text; this one is empty");
		assert.match(await refused("memory_commit", { startId, endId, summary: "x".repeat(600) }), /^Too long: 600 bytes, limit 512\./);
	}
	assert.equal(await ok("memory_commit", { startId, endId, summary }), `Stored #${startId}-${endId}. Call memory_pending for the next block.`);
	assert.match(await ok("memory_commit", { startId, endId, summary }), /^Not stored: #\d+-\d+ is summarized already/);
	lines.set(`${startId}-${endId}`, summary);
	console.log(`ok committed #${startId}-${endId}: ${summary}`);
}
assert.deepEqual([...lines.keys()], ["0-1", "2-3", "4-5"]);
console.log("ok nothing left to summarize");

assert.equal(await ok("memory_wake"), notes.map((note, index) => `#${index} ${note}`).join("\n"));
console.log("ok wake shows the 6 notes");

assert.equal(await ok("memory_zoom", { startId: 0, endId: 3 }), `#0-1 ${lines.get("0-1")}\n#2-3 ${lines.get("2-3")}`);
assert.equal(await ok("memory_zoom", { startId: 0, endId: 1 }), `#0 ${notes[0]}\n#1 ${notes[1]}`);
assert.match(await refused("memory_zoom", { startId: 0, endId: 2 }), /^#0-2 is not a summary you can open/);
console.log("ok zoom #0-3 into two lines, #0-1 into two notes, #0-2 refused");

assert.equal(await ok("memory_recall", { query: "pg_cron" }), `#3 ${notes[3]}`);
console.log("ok recall");
await client.close();

async function get(path, accept = "*/*") {
	const response = await fetch(`${url}${path}`, { headers: { accept } });
	return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
}

const wake = await get("/wake.json");
assert.equal(wake.status, 200);
const { items, total } = JSON.parse(wake.body);
assert.equal(total, 6);
assert.deepEqual(
	items.map(({ createdAt, ...item }) => item),
	notes.map((content, id) => ({ type: "memory", id, content })),
);
const zoom = await get("/zoom.json?startId=0&endId=3");
assert.deepEqual(JSON.parse(zoom.body), [
	{ type: "summary", startId: 0, endId: 1, content: lines.get("0-1") },
	{ type: "summary", startId: 2, endId: 3, content: lines.get("2-3") },
]);
const badZoom = await get("/zoom.json?startId=0&endId=2");
assert.equal(badZoom.status, 400);
assert.match(badZoom.body, /^#0-2 is not a summary you can open/);
console.log("ok wake.json, zoom.json, and a 400 for #0-2");

const page = await get("", "text/html,application/xhtml+xml");
assert.equal(page.status, 200);
assert.match(page.type, /^text\/html/);
assert.match(page.body, /claude mcp add --transport http memory/);
assert.match(page.body, /pi mcp add memory --url/);
assert.match(page.body, /pi mcp remove memory/);
const landing = await fetch(`${base}/`);
assert.match(await landing.text(), /Create a memory/);
assert.equal((await fetch(`${base}/m/not-an-id`)).status, 404);
console.log("ok memory page, landing page, 404 for a bad id");

const destroy = () => fetch(`${url}/destroy`, { method: "POST" });
assert.equal((await fetch(`${url}/destroy`)).status, 405);
assert.equal((await destroy()).status, 204);
assert.deepEqual(JSON.parse((await get("/wake.json")).body), { items: [], total: 0 });
// Reading the view started a new, empty memory at the URL; destroy it too so the run leaves nothing stored.
assert.equal((await destroy()).status, 204);
console.log("ok destroy empties the memory and refuses GET");

console.log("smoke passed");
