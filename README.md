# pi-durable-memory

Long-term memory for [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) agents on Cloudflare. One Durable Object per memory scope. Inside it, an append-only log of one-line memories and a binary tree of summaries above it. Before every model request the agent's system prompt gets a bounded view of the whole history, coarse for old memories and verbatim for recent ones. The exact memories are always one `zoom` or `recall` away. The idea comes from [OptMem](https://github.com/VictorTaelin/OptMem).

Pi Durable's compaction manages the context of one conversation. This package manages knowledge that outlives conversations, sessions, and harnesses.

## Setup

Three pieces: the memory object, the extension in the agent, and the wrangler binding.

```ts
// memory.ts
import { defineMemoryObject } from "pi-durable-memory/cloudflare";
import { buildSummaryPrompt } from "pi-durable-memory";

export const MemoryObject = defineMemoryObject<Env>({
	summarizer: (env) => ({
		summarize: async (input) => completeWithYourModel(env, buildSummaryPrompt(input)),
	}),
});
```

```ts
// agent.ts, inside the Pi Durable harness setup
import { createPiMemoryExtension } from "pi-durable-memory";
import { createMemoryClient } from "pi-durable-memory/cloudflare";

registry.install(
	createPiMemoryExtension({
		memory: createMemoryClient(env.MEMORY),
		scopes: ({ conversationId }) => [`agent:${conversationId}`, "project:unprice"],
	}),
);
```

```jsonc
// wrangler.jsonc
{
	"durable_objects": { "bindings": [{ "name": "MEMORY", "class_name": "MemoryObject" }] },
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["MemoryObject"] }]
}
```

Install with `pnpm add pi-durable-memory`. Peer dependencies: `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@cloudflare/workers-types`.

## What the agent gets

Before each model request, the system prompt carries a `<memory>` section. It starts with the admission policy the model follows, then each scope's history:

```
<memory>
Long-term memory, kept across sessions, oldest first per scope. Remember with
memory_note: durable preferences, decisions, facts likely useful in future
sessions, outcomes, lessons. Do not remember greetings, transient execution
details, routine tool output, or anything already remembered. One line per
memory, under 280 bytes. A #a-b line summarizes memories a through b: use
memory_recall for exact old facts and memory_zoom on a #a-b line to open it.

[agent:7]
#0-511 Early architecture: Cloudflare, SQLite (#3); billing is usage-based (#201)
#512-767 Enterprise payment constraints: Acme cannot use Stripe (#532)
#768 User prefers concise answers.
#769 Deploys need approval.

[project:unprice]
#0-15 Budget is $500 a month (#2); tests run inside workerd (#9)
#16 Seb owns billing.
</memory>
```

The section changes only when a memory lands, so the provider prompt cache stays warm. The model reads it like any instruction. Three tools:

| Tool | What it does |
|---|---|
| `memory_note(content, scope?)` | Stores one line. Replay-safe: the tool task id is the idempotency key, so a crash and retry never duplicates. |
| `memory_recall(query, scope?, limit?)` | Full-text search over the raw memories, newest first. |
| `memory_zoom(startId, endId, scope?)` | Opens a `#a-b` line into its two halves, down to the raw memories. |

Nothing else is the model's job. Compaction runs from the object's alarm after every write.

## Scopes

A scope is any string: `agent:7`, `user:seb`, `project:unprice`, `company:acme`. Each is one Durable Object, named by the string. A conversation's `scopes` function lists what it reads and may write to, first entry being the default for `memory_note`. A shared scope such as `project:unprice` is one object that several agents call. The wake budget, 96 lines by default, is split equally across a conversation's scopes.

## Deciding what to remember

By default the model decides, guided by the policy paragraph above. The extension's `admission` hook can take that decision away from it:

```ts
import { createRetrievalAdmission } from "pi-durable-memory";

const admission = createRetrievalAdmission({
	judge: {
		async judge({ candidate, neighbors }) {
			// neighbors: the stored memories closest to the candidate, by words
			// return { verdict: "new" } | { verdict: "duplicate", of } | { verdict: "supersedes", id } | { verdict: "reject", reason }
		},
	},
});
```

Before every `memory_note`, the hook recalls the five nearest existing memories and asks the judge what the candidate is. A duplicate is skipped with `Not saved: duplicate of #12`. A supersede stores the new memory and retires the old one: it stays in the log but leaves `wake`, `recall`, and the summarizer's input. A reject is skipped with the reason. A judge naming an id it was never shown is treated as new.

### With Jev

[Jev](https://docs.typesafe.ai/) is TypeSafe AI's System One model: typed questions, calibrated probabilities, no generation. It fits the judge role exactly because admission is a decision, not a text.

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createJevAdmission } from "pi-durable-memory/jev";

const admission = createJevAdmission({
	client: new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY }),
	minDurable: 0.5, // below this probability the note is rejected as not durable
	minRelation: 0.6, // below this confidence a duplicate or supersede is treated as new
});

registry.install(createPiMemoryExtension({ memory, scopes, admission }));
```

One `systemOne` call per note asks three things: is the candidate durable, how it relates to the nearest memories (new, duplicate, supersedes), and which one it duplicates or replaces. A rejection returns `Not saved: not durable (p=0.21)` to the model. `@typesafe-ai/sdk` is an optional peer dependency; pass `apiKey` explicitly on Workers.

Jev does not write summaries. Summarization needs a generative model behind `summarizer`.

## How it works inside the object

```
note #7      #0 #1 #2 #3 #4 #5 #6 #7      ← the log, never edited
              └─┘  └─┘  └─┘  └─┘
             #0-1 #2-3 #4-5 #6-7          ← level 1, one summarizer call each
               └────┘    └────┘
               #0-3      #4-7             ← level 2
                  └────────┘
                    #0-7                  ← level 3
```

- **Log.** `memories(scope, id, created_at, content, source_id, supersedes)`. Ids are positions. Rows are never updated or deleted.
- **Tree.** `memory_nodes(scope, level, start_id, end_id, summary)`. A node covers an aligned power-of-two block and is built the moment its block fills. Blocks of up to 16 memories are summarized from the raw lines; larger ones from their two children. Every node is one summarizer call, so compaction costs about one call per memory over the life of the log.
- **Wake.** The cover is computed from the memory count alone, then at most 96 rows are read. At 100,000 memories that is three queries and 96 rows, measured in the tests. A block whose summary is not built yet shows as `#a-b (not summarized yet)` so the budget stays exact.
- **Compaction.** Every `note` and `forget` sets an alarm. The handler builds up to `mergesPerAlarm` nodes (32) and reschedules while merges remain. Summarizer errors propagate so the platform retries with backoff.
- **Summaries.** `buildSummaryPrompt(input)` asks for one line of at most 280 bytes that keeps standing facts with the id of the memory stating them and drops events. A summary of 8,192 memories is then a map with pointers, not a story.
- **Search.** FTS5 inside Durable Object SQLite, with `LIKE` as a fallback.
- **Forget.** `forget(range)` on the object drops one summary and every summary built from it; the next alarm rebuilds them. Raw memories are untouched. An operator tool, not a model tool.

`defineMemoryObject` options: `summarizer(env)`, `limits` (`maxEntryBytes` 280, `rawThreshold` 16, `maxItems` 96), `mergesPerAlarm` (32).

## Invariants the tests hold

- Raw memories are never modified by compaction, `forget`, or supersede.
- One `sourceId` never creates two memories.
- Every summary covers an aligned block and derives from raw memories or its two children.
- `wake()` never exceeds its budget and reads a bounded number of rows at 100,000 memories.
- `zoom()` reaches raw memories.
- Two scopes never leak into each other.
- A replayed Pi tool call does not duplicate a memory.
- The alarm reschedules until nothing is pending, inside workerd.

## Development

```sh
pnpm install
pnpm check   # typecheck, Node tests (core and extension on node:sqlite), workers-runtime tests (the object, inside workerd)
```
