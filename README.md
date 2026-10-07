# pi-durable-memory

Durable long-term memory for agents built on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable). One scope is an append-only log of one-line memories plus a binary tree of summaries over it. `wake()` returns a bounded view of the whole history, coarse for old memories and verbatim for recent ones. `recall()` and `zoom()` reach the exact original entries. The idea comes from [OptMem](https://github.com/VictorTaelin/OptMem).

Pi Durable's compaction manages the context of one conversation. This package manages knowledge that outlives conversations, sessions, and harnesses. They are different layers.

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
| `note({ content, sourceId? })` | Appends one memory. A second call with the same `sourceId` returns the first entry, so a replayed tool call never duplicates. Rejects empty content and content over the byte cap. |
| `wake({ maxItems? })` | At most `maxItems` items tiling the whole log, oldest first. Old ranges arrive as summaries, recent ones verbatim. A block compaction has not summarized yet arrives as `pending`. |
| `recall(query, { limit? })` | Full-text matches, newest first. |
| `zoom({ startId, endId })` | The two halves of one `#a-b` block, each a summary, a raw memory, or `pending`. Repeating it reaches raw memories. |
| `compact({ maxMerges? })` | Builds missing summaries, smallest blocks first. Idempotent and safe to interrupt. |
| `pending()` | Merges `compact()` would perform now. |
| `forget({ startId, endId })` | Drops one summary and every summary built from it. The next `compact()` rebuilds them. Raw memories are never touched. |

`createMemory` takes `limits`: `maxEntryBytes` (280), `rawThreshold` (16), `maxItems` (96). Blocks of at most `rawThreshold` memories are summarized from the raw entries; larger blocks from their two child summaries. The summarizer is injected, so the package has no model dependency.

`wake()` reads a bounded number of rows however large the log is. The cover is computed from the memory count alone, then at most `maxItems` rows are fetched. A test seeds 100,000 memories and asserts one `count`, one `getMemories`, and one `getNodes` call returning 96 rows in total.

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

What the hook is for, in order of ambition: filtering obvious non-memories, routing a note to a shared scope, de-duplicating against `recall()` before writing, and eventually an automatic classifier such as a small model that judges durability and importance. None of that changes the memory algorithm, and the default admits everything the model sends.

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

Plus an FTS5 table when the runtime has FTS5, with a `LIKE` fallback otherwise.

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
