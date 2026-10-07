# pi-durable-memory

Durable long-term memory for agents built on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable). One scope is an append-only log of one-line memories plus a binary tree of summaries over it. `wake()` returns a bounded view of the whole history, coarse for old memories and verbatim for recent ones. `recall()` and `zoom()` reach the exact original entries. The idea comes from [OptMem](https://github.com/VictorTaelin/OptMem).

Pi Durable's compaction manages the context of one conversation. This package manages knowledge that outlives conversations, sessions, and harnesses. They are different layers.

## The simple path

Five things, and the agent has a memory that survives every session:

1. A store. SQLite, one file holding every scope.
2. A summarizer. Any model, called with `buildSummaryPrompt(input)`.
3. `createMemory({ store, summarizer })`, one per scope.
4. `createPiMemoryExtension({ memory, scopes })`, installed in the registry.
5. A `scopes` function that names the scopes a conversation reads and writes.

```ts
import { createMemory, buildSummaryPrompt } from "pi-durable-memory";
import type { Memory } from "pi-durable-memory";
import { createSqliteMemoryStore } from "pi-durable-memory/sqlite";
import { openNodeSqlite } from "pi-durable-memory/sqlite/node";
import { createPiMemoryExtension } from "pi-durable-memory/pi";

const db = openNodeSqlite("memory.db");
const summarizer = { summarize: async (input) => completeWithYourModel(buildSummaryPrompt(input)) };
const memories = new Map<string, Promise<Memory>>();
const memoryFor = (scope: string) =>
	memories.get(scope) ?? memories.set(scope, createSqliteMemoryStore(db, { scope }).then((store) => createMemory({ store, summarizer }))).get(scope)!;

registry.install(
	createPiMemoryExtension({
		memory: memoryFor,
		scopes: ({ conversationId }) => [`agent:${conversationId}`, "project:unprice"],
	}),
);
```

From then on, before every model request, the system prompt carries a `<memory>` section: an instruction paragraph, then each scope's history as `#a-b` summary lines for old ranges and `#id` raw lines for recent ones. The model reads it like any other instruction. When a summary line matters, it calls `memory_recall` for exact words or `memory_zoom` on the `#a-b` line to open it. When it learns something durable, it calls `memory_note`. Compaction runs as a durable Pi task after each note.

That is the whole idea, and it is enough for most agents. Everything under [When you need more](#when-you-need-more) is optional and off by default.

## Install

```sh
pnpm add pi-durable-memory
```

Peer dependencies `@earendil-works/pi-durable` and `@earendil-works/pi-ai` are needed only for the `pi-durable-memory/pi` entry point. The Cloudflare entry point needs `@cloudflare/workers-types`.

## Core

```ts
import { createMemory, formatMemoryContext } from "pi-durable-memory";
import { createSqliteMemoryStore } from "pi-durable-memory/sqlite";
import { openNodeSqlite } from "pi-durable-memory/sqlite/node";

const db = openNodeSqlite("memory.db");
const store = await createSqliteMemoryStore(db, { scope: "agent:seb" });
const memory = createMemory({
	store,
	summarizer: {
		summarize: async ({ startId, endId, items, maxBytes }) => myLlm(items, maxBytes),
	},
});

await memory.note({ content: "User prefers concise technical explanations.", sourceId: "task-123" });
await memory.note({ content: "Project runs on Cloudflare.", sourceId: "task-124" });
await memory.compact();

const context = await memory.wake({ maxItems: 96 });
console.log(formatMemoryContext(context));
const hits = await memory.recall("Cloudflare");
```

| Method | What it does |
|---|---|
| `note({ content, sourceId?, supersedes? })` | Appends one memory. A second call with the same `sourceId` returns the first entry, so a replayed tool call never duplicates. `supersedes` retires an older memory by id. Rejects empty content and content over the byte cap. |
| `wake({ maxItems? })` | At most `maxItems` items tiling the whole log, oldest first. Old ranges arrive as summaries, recent ones verbatim. A block compaction has not summarized yet arrives as `pending`. |
| `recall(query, { limit?, summaries? })` | Memories and summaries matching the query, best first. Full-text always; semantic when an index is configured. Superseded memories are excluded. |
| `zoom({ startId, endId })` | The two halves of one `#a-b` block, each a summary, a raw memory, or `pending`. Repeating it reaches raw memories. |
| `compact({ maxMerges? })` | Builds missing summaries, smallest blocks first. Idempotent and safe to interrupt. |
| `pending()` | Merges `compact()` would perform now. |
| `forget({ startId, endId })` | Drops one summary and every summary built from it. The next `compact()` rebuilds them. Raw memories are never touched. |

`createMemory` takes `limits`: `maxEntryBytes` (280), `rawThreshold` (16), `maxItems` (96). Blocks of at most `rawThreshold` memories are summarized from the raw entries; larger blocks from their two child summaries. The summarizer is injected, so the package has no model dependency.

### Summaries that keep facts

A summary of 8,192 memories in 280 bytes keeps nothing if it is written as a story. `buildSummaryPrompt(input)` is the contract that makes it a map instead: keep standing facts that are still true (preferences, decisions in force, constraints, identities, numbers) with the id of the memory that states them, drop events, invent nothing.

```ts
import { buildSummaryPrompt } from "pi-durable-memory";

const summarizer = {
	summarize: async (input) => completeWithYourModel(buildSummaryPrompt(input)),
};
```

A summary then reads `Acme cannot use Stripe (#532); deploys need approval (#4120)`, and every citation is one `recall()` or `zoom()` from its source.

## Scopes

The core is one scope. A scope is any string the host chooses: `agent:abc`, `user:seb`, `project:unprice`, `company:acme`. Composition happens outside `createMemory()`.

| Deployment | How scopes map |
|---|---|
| Node or Bun, one SQLite file | `createSqliteMemoryStore(db, { scope })` once per scope. The file holds every scope. |
| Cloudflare | One Durable Object per scope, named by the scope string. See below. |

## Pi Durable extension

```ts
import { createRegistry } from "@earendil-works/pi-durable";
import { createPiMemoryExtension } from "pi-durable-memory/pi";

const registry = createRegistry();
registry.install(
	createPiMemoryExtension({
		memory: (scope) => memoryFor(scope),
		scopes: ({ conversationId }) => [`agent:${conversationId}`, "project:unprice"],
	}),
);
```

The extension adds:

- A `memory` section rendered before each request: an instruction paragraph, then each scope's `wake()` output under a `[scope]` header. The text changes only when memories change, which keeps the provider prompt cache warm.
- `memory_note(content, scope?)`, `memory_recall(query, scope?, limit?)`, `memory_zoom(startId, endId, scope?)`. All are `replay: "safe"`. A note's `sourceId` is the tool task id, so a replay after a crash returns the same entry.
- A `memory.compact` durable task.

Options: `maxItems` (96, split equally across scopes with a floor of 8), `compaction` (`"task"` runs the durable task after each note, `"inline"` awaits `compact()` in the tool, `"none"` leaves it to the host), `name`.

See [Admission](#admission) for what gets stored.

## Admission

Admission is the decision of what becomes a memory. In this version it is explicit: the model calls `memory_note` when it judges something durable, and nothing is stored otherwise. The instruction paragraph in the `memory` section is the whole policy the model sees. It says to remember durable preferences, decisions, facts likely useful in future sessions, outcomes, and lessons, and not to remember greetings, transient execution details, routine tool output, or anything already remembered. One line, under the byte cap.

The core never decides admission. `note()` stores what it is given. Host code that calls `note()` directly has already decided.

The extension takes an optional `admission` hook that runs on every `memory_note` call before anything is written:

```ts
import type { MemoryAdmission } from "pi-durable-memory/pi";

const admission: MemoryAdmission = {
	async evaluate({ content, scope, scopes, conversationId }) {
		if (/^(hi|hello|thanks)\b/i.test(content)) return { admit: false, reason: "greetings are not memories" };
		if (content.includes("company-wide")) return { admit: true, scope: "company:acme" };
		return { admit: true };
	},
};

createPiMemoryExtension({ memory, scopes, admission });
```

A decision is `{ admit: true, content?, scope? }` to store, with an optional rewrite of the text or the target scope, or `{ admit: false, reason }` to skip. A skipped note returns `Not saved: <reason>` to the model as a normal result, not an error, so the model can move on. A rewritten scope must still be one of the conversation's scopes.

What the hook is not: it does not run on host calls to `note()`, and it does not see the conversation. If an admission policy needs the transcript, build it from Pi Durable's hooks on the tool task and call `note()` yourself.

## Cloudflare

```ts
import { defineMemoryObject, createMemoryClient } from "pi-durable-memory/cloudflare";

export const MemoryObject = defineMemoryObject<Env>({
	summarizer: (env) => workersAiSummarizer(env.AI),
});

// In the agent:
const memoryFor = createMemoryClient(env.MEMORY);
registry.install(createPiMemoryExtension({ memory: memoryFor, scopes, compaction: "none" }));
```

```jsonc
// wrangler.jsonc
{
	"durable_objects": { "bindings": [{ "name": "MEMORY", "class_name": "MemoryObject" }] },
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["MemoryObject"] }]
}
```

Each object owns one scope's tables in its SQLite storage and exposes the `Memory` interface over RPC. Every `note()` and `forget()` sets an alarm; the handler compacts a bounded batch (`mergesPerAlarm`, 32) and reschedules while merges remain. Agents never compact Durable Object scopes themselves, hence `compaction: "none"` in the extension. A shared scope such as `company:acme` is one object several agents call. FTS5 is available inside Durable Object SQLite, so `recall()` uses it there.

## Storage

The SQLite store runs over a small async facade (`exec`, `run`, `get`, `all`, `transaction`) that is structurally the same as Pi Durable's, so its adapters work here too. Two adapters ship: `openNodeSqlite(path)` over `node:sqlite` (Node 22.18 or later) and `durableObjectSql(ctx.storage)`. Any other backend implements `MemoryStore` directly.

Schema, two tables:

```sql
CREATE TABLE memories (scope, id, created_at, content, source_id,
  PRIMARY KEY (scope, id), UNIQUE (scope, source_id));
CREATE TABLE memory_nodes (scope, level, start_id, end_id, summary,
  PRIMARY KEY (scope, level, start_id));
```

Plus an FTS5 table when the runtime has FTS5, with a `LIKE` fallback otherwise, and a `memory_vectors` table when the SQLite vector index is used. A `supersedes` column is added to existing databases on open.

## When you need more

Each piece below exists because a real log shows the pain it names. None is required, none runs unless configured, and the tests prove the simple path works without them.

### A preference changed: supersede

Pain: the user changes their mind, the model notes the new preference, and both versions sit in the log until a summary blends them.


The log is append-only, so a changed preference is a new memory that retires the old one:

```ts
await memory.note({ content: "User prefers detailed answers.", supersedes: 12 });
```

Memory 12 stays in the log with `supersededBy: 13` and disappears from `wake()`, `recall()`, and the summarizer's input. Summaries built before the change still mention the old fact until they are rebuilt; the citation leads to a memory marked superseded, and `recall()` finds the current one.

### The model does not know the words: semantic recall

Pain: `recall("payment provider constraints")` never finds "Acme cannot use Stripe". With cited ids in summaries this is the minority case, since `zoom` by id is exact, but it happens.


Full-text search finds "Stripe" but not "payment provider constraints". A `MemoryIndex` adds the semantic path: `note()` indexes each memory, `compact()` indexes each summary, and `recall()` fuses both lists with full-text matches by reciprocal rank. Indexing summaries is what makes old history reachable: a query lands on a `#512-1023` node, and `zoom()` walks down to the exact memory.

```ts
import { createSqliteMemoryStore, createSqliteVectorIndex } from "pi-durable-memory/sqlite";

const embedder = { embed: async (texts) => yourEmbeddingModel(texts) };
const index = await createSqliteVectorIndex(db, { scope: "agent:seb", embedder });
const memory = createMemory({ store, summarizer, index });
```

The SQLite index is brute-force cosine over the scope's vectors and is fine to roughly 20,000 entries at 384 dimensions. Larger scopes use an external index behind the same interface, such as Vectorize on Cloudflare (below). Without an index, `recall()` is full-text only.

`wake()` reads a bounded number of rows however large the log is. The cover is computed from the memory count alone, then at most `maxItems` rows are fetched. A test seeds 100,000 memories and asserts one `count`, one `getMemories`, and one `getNodes` call returning 96 rows in total.

### Semantic recall on Cloudflare


Durable Object SQLite has no vector extension and an object has 128 MB of memory, so brute force stops at small scopes. Vectorize is the index for the rest, one namespace per object:

```ts
import { createVectorizeIndex, defineMemoryObject } from "pi-durable-memory/cloudflare";

export const MemoryObject = defineMemoryObject<Env>({
	summarizer: (env) => workersAiSummarizer(env.AI),
	index: (env, ctx) =>
		createVectorizeIndex(env.VECTORS, {
			namespace: ctx.id.toString(), // an object cannot recover its name from its id
			embedder: workersAiEmbedder(env.AI),
		}),
});
```

Vectorize mutations are asynchronous: a vector is queryable seconds after `upsert` resolves. A recall right after a note may miss the newest memory on the semantic path until then; the full-text path still finds it. For a scope that stays small, `createSqliteVectorIndex(durableObjectSql(ctx.storage), { scope: "self", embedder })` works inside the object with no external service.

### The model repeats itself: retrieval-backed admission

Pain: the model notes the same fact twice, or appends a contradiction instead of replacing. It decides blind.


The model decides what to note, but it decides blind: it repeats itself, and when a preference changes it appends a contradiction. `createRetrievalAdmission` gives it eyes. Before every write it recalls the five nearest existing memories and asks a judge one question with four answers: new, duplicate of #n, supersedes #n, or reject.

```ts
import { createRetrievalAdmission } from "pi-durable-memory/pi";

const admission = createRetrievalAdmission({
	judge: {
		async judge({ candidate, neighbors }) {
			// Your model, your rules. Return one of:
			// { verdict: "new" } | { verdict: "duplicate", of } | { verdict: "supersedes", id } | { verdict: "reject", reason }
			return askYourModel(candidate, neighbors);
		},
	},
});
```

Duplicates are skipped with `Not saved: duplicate of #n`. Supersedes writes the new memory with `supersedes` set. A judge naming an id that is not among the neighbors is treated as new. The cost is one recall and one small judgment per note, and notes are rare.

### The judge without a generative model: Jev


[Jev](https://docs.typesafe.ai/) is TypeSafe AI's System One model: typed questions, calibrated probabilities, no generation. It fits the judge role exactly, because admission is a decision, not a text. `pi-durable-memory/jev` ships a judge that asks Jev three questions in one call: is the candidate durable (a yes/no), how it relates to the existing memories (new, duplicate, supersedes), and which memory it duplicates or replaces.

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createJevAdmission } from "pi-durable-memory/jev";

const admission = createJevAdmission({
	client: new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY }),
	minDurable: 0.5, // below this probability the note is rejected as not durable
	minRelation: 0.6, // below this confidence a duplicate or supersede call is treated as new
});

registry.install(createPiMemoryExtension({ memory, scopes, admission }));
```

A rejected note returns `Not saved: not durable (p=0.21)` to the model. Install `@typesafe-ai/sdk` yourself; it is an optional peer dependency. On Cloudflare Workers pass `apiKey` explicitly, since the client reads `TYPESAFE_API_KEY` only where `process.env` exists.

Jev can also stand alone as a cheap pre-filter without retrieval, when all you want is the durability gate:

```ts
import { createJevJudge } from "pi-durable-memory/jev";

const judge = createJevJudge({ client });
const admission = {
	async evaluate({ content, scope, scopes }) {
		const verdict = await judge.judge({ candidate: content, neighbors: [], scope, scopes });
		return verdict.verdict === "reject" ? { admit: false, reason: verdict.reason } : { admit: true };
	},
};
```

Jev does not write summaries. Summarization still needs a generative model behind `MemorySummarizer`.

## Invariants the tests hold

- Raw memories are never modified by compaction or `forget()`.
- One `sourceId` never creates two memories.
- Every summary covers an aligned power-of-two block and derives from raw memories or its two children.
- `wake()` never exceeds its budget and reads a bounded number of rows at 100,000 memories.
- `zoom()` reaches raw memories.
- Two scopes in one database never leak into each other.
- A replayed Pi tool call does not duplicate a memory.

## Development

```sh
pnpm install
pnpm check   # typecheck, Node tests, workers-runtime tests
```

The workers-runtime tests run inside workerd through `@cloudflare/vitest-pool-workers` and cover the alarm path and FTS5 inside a Durable Object.
