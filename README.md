# pi-durable-memory

Long-term memory for [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) agents on Cloudflare. Each memory scope is one Durable Object. The object keeps an append-only log of one-line memories, a binary tree of summaries over the log, and a stored view of the whole history that fits a byte budget. The view shows recent memories verbatim and old ones as summaries. The agent's system prompt carries the view at the start of each run, and the `memory_zoom` and `memory_recall` tools return the exact memories behind it.

Pi Durable's compaction manages the context of one conversation. This package keeps what an agent learns across conversations, sessions, and harnesses.

The memory model is [OptMem](https://github.com/VictorTaelin/OptMem) by Victor Taelin. The view and the summarizer follow his [UniiChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) spec, reimplemented for this runtime. See [Credits](#credits).

## How it works, in two minutes

https://github.com/user-attachments/assets/3854d0ab-8864-431e-9a1f-5f7b0322a751

The video (2:21, with narration) covers the log, the binary tree and its free merges, and the view. The view grows at its end, and past 16 KB it merges in one batch down to 8 KB, so the prompt cache keeps it. The video ends with zoom back to the exact memory and the two things that go wrong at scale.

## Set it up

Install the package with `pnpm add pi-durable-memory`. The root entry imports `@earendil-works/pi-durable` and `@earendil-works/pi-ai`, and `pi-durable-memory/jev` imports `@typesafe-ai/sdk`. All three are optional peer dependencies.

You need three pieces: the memory object, the extension in the agent, and the wrangler binding.

Define the memory object with your summarizer:

```ts
// memory.ts
import { defineMemoryObject } from "pi-durable-memory/cloudflare";

export const MemoryObject = defineMemoryObject<Env>({
	summarizer: (env) => ({
		complete: (request) => completeWithYourModel(env, request),
	}),
});
```

`request.system` is a constant system prompt, and `request.turns` is a short conversation. Send the turns to your model as messages, in order. A user turn's `blocks` are text blocks, and an assistant turn's `text` is the model's earlier reply. Return the model's text. The first block of the first turn is the context, and consecutive requests share it. If your provider supports cache breakpoints, put one after that block.

Install the extension in the Pi Durable harness setup:

```ts
// agent.ts
import { createPiMemoryExtension } from "pi-durable-memory";
import { createMemoryClient } from "pi-durable-memory/cloudflare";

registry.install(
	createPiMemoryExtension({
		memory: createMemoryClient(env.MEMORY),
		scopes: () => [`agent:${agentName}`, "project:unprice"],
	}),
);
```

Bind the object:

```jsonc
// wrangler.jsonc
{
	"durable_objects": { "bindings": [{ "name": "MEMORY", "class_name": "MemoryObject" }] },
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["MemoryObject"] }]
}
```

## What the agent sees

At the start of each run, the system prompt carries a `<memory>` section. It opens with the policy the model follows when it saves a memory, then shows each scope's view:

```
<memory>
Long-term memory, kept across sessions, oldest first per scope. Remember with
memory_note: durable preferences, decisions, facts likely useful in future
sessions, outcomes, lessons. Do not remember greetings, transient execution
details, routine tool output, or anything already remembered. One line per
memory, under 280 bytes. A #a-b line summarizes memories a through b: use
memory_recall for exact old facts and memory_zoom on a #a-b line to open it.
Zoom whenever a line only mentions something you need, before you act, guess
or ask. Notes you save appear here from the next message on.

[agent:support]
#0-511 Early architecture: Workers and Durable Object SQLite, chosen for per-scope isolation; billing is usage-based on Stripe
#512-767 Acme cannot use Stripe and pays by invoice; deploys need approval, never on Fridays
#768-775 User prefers concise answers and tables; staging lives in eu-west
#776 Deploys need approval.

[project:unprice]
#0-15 Budget is $500 a month for models; tests run inside workerd
#16 Seb owns billing.
</memory>
```

The extension renders this section once per run and reuses it for every tool step of that run. A note saved mid-run appears from the next message on. Between runs, each scope's view only gains memories at its end, until it passes `viewBytes` and one batch merges old lines down to half of that. Most of the section stays byte-identical from one run to the next, so the provider's prompt cache keeps it.

The model gets three tools:

| Tool | What it does |
|---|---|
| `memory_note(content, scope?)` | Stores one line. The tool task id is the idempotency key, so a crash and a retry never store the line twice. |
| `memory_recall(query, scope?, limit?)` | Searches the raw memories by words, newest first. |
| `memory_zoom(startId, endId, scope?)` | Opens a `#a-b` line into its two halves, down to the raw memories. |

The model does nothing else. The object's alarm runs compaction after every write.

## Choose scopes

A scope is any string, such as `agent:support`, `user:seb`, `project:unprice`, or `company:acme`. Each scope is one Durable Object, named by the string. The extension's `scopes` function lists the scopes a conversation reads and may write to. The first entry is the default for `memory_note`. A shared scope such as `project:unprice` is one object that several agents call. Each scope's view has its own byte budget, `viewBytes`.

Name an agent's scope by something the host knows, such as the agent's name. The `scopes` function also receives the Pi `conversationId`, but every harness numbers its root conversation 1. So `agent:${conversationId}` puts every agent in the same scope.

## Decide what to remember

By default the model decides, guided by the policy at the top of the `<memory>` section. To take that decision away from the model, pass an `admission` hook:

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

Before every `memory_note`, the hook recalls the five nearest memories and asks the judge what the candidate is:

- `new` stores the candidate.
- `duplicate` skips it, and the model reads `Not saved: duplicate of #12`.
- `supersedes` stores it and retires the old memory. The old memory stays in the log but leaves `wake`, `recall`, and the summarizer's input. Summaries built before the supersede keep its text. See [the limitation on forgetting](#limitation-you-cannot-forget-one-memory).
- `reject` skips it, and the model reads the reason.

If the judge names an id it was never shown, the hook treats the candidate as new.

### Use Jev as the judge

[Jev](https://docs.typesafe.ai/) is TypeSafe AI's System One model. It answers typed questions with calibrated probabilities and generates no text. Admission is a decision, so a model that answers typed questions fits the judge role.

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

One `systemOne` call per note asks whether the candidate is durable, how it relates to the nearest memories (new, duplicate, or supersedes), and which memory it duplicates or replaces. A rejection returns `Not saved: not durable (p=0.21)` to the model. On Workers, pass `apiKey` explicitly.

Jev does not write summaries. The `summarizer` needs a generative model.

## Inside the object

```
note #7      #0 #1 #2 #3 #4 #5 #6 #7      ← the log, never edited
              └─┘  └─┘  └─┘  └─┘
             #0-1 #2-3 #4-5 #6-7          ← level 1, two memories each
               └────┘    └────┘
               #0-3      #4-7             ← level 2, two level-1 nodes each
                  └────────┘
                    #0-7                  ← level 3
```

- **Log.** `memories(scope, id, created_at, content, source_id, supersedes)`. Ids are positions. Rows are never updated or deleted.
- **Tree.** `memory_nodes(scope, level, start_id, end_id, summary)`. The tree is strictly binary. A level-1 node merges two memories, and a node at level l merges its two children at level l-1. The store accepts a node only when it is the next one at its level and both children exist, so each level is a dense prefix. Nodes are never deleted.
- **Free merges.** If the two children joined by ` / ` fit in `summaryBytes` (512), that text is the node and no model runs. A superseded memory counts as empty, so a block whose memories were all superseded becomes an empty node, and the view leaves it out. Short notes climb a few levels verbatim before the first model call.
- **View.** `memory_view(scope, start_id, level)` holds the lines `wake()` returns. They are aligned blocks that tile the log, oldest first. The view changes in two ways only. Each new memory goes at its end. When the text passes the high mark, `viewBytes` (16,384), one batch merges pairs of sibling lines into their built parents, most due pair first. The batch stops when the text is at most the low mark, half of `viewBytes`, or when no pair has a built parent.

  With T memories in the log, a pair of level-l lines whose last memory is m is due by (T - m) / 2^l. That is how long ago the pair ended, measured in its own line size. Old lines merge first, and each level keeps about as many lines. If you set both marks to the length of Victor Taelin's rollback `push` list, in lines, each batch is one merge and the view makes exactly the merges `push` makes. Larger batches keep that order and change only when the merges happen.

  Between batches, each wake's view is a prefix of the next one, and a batch rewrites the view once instead of a little at every note. The text moves between half of `viewBytes` and `viewBytes`. No line is split. A parent enters the view only once it is built, so the view never shows a placeholder. Until compaction builds the parents, the view shows every memory, even over `viewBytes`. A scope with memories but no stored view, such as one written before the view existed, folds from memory 0 in one pass on its next wake, note, or compaction.
- **Compaction.** With a `summarizer`, every `note` sets an alarm. A round takes up to 8 blocks whose children are built, by level and then position. It stores the free merges, runs the summarizer for the rest concurrently, stores the results in order, and folds the view. If the view is still over `viewBytes` because parents were missing, that fold runs the next batch. The alarm runs rounds until it has stored `mergesPerAlarm` (32) nodes, and reschedules while nodes are missing. A summarizer failure comes back in the `failed` list of `compact()`, not as a throw. The alarm logs each failing block once and tries again 10 s later. It never throws to the platform, whose alarm backoff gives up after six retries.
- **Summaries.** The summarizer gets a constant system prompt and one user turn of two blocks. The first block is the view up to the end of the block, as bare lines inside `<memory>`. The second asks for one line of at most `summaryBytes`, shows a ruler of that many dashes, and puts the two lines to merge inside `<input>`. Models cannot count bytes, so the ruler shows the length. The UniiChat spec reports that a real sample line in the ruler's place gets its content copied into the summary. No id appears anywhere, because models copy ids into their output. If the reply is over `summaryBytes`, the conversation continues. The model gets the line's size and the limit, and sees its line cut where the limit falls. The loop stops at the first line that fits or after five tries, and keeps the shortest line. It never truncates a line.
- **Your own summarizer loop.** Without a `summarizer`, no alarm runs. `nextMerge()` stores the free merges and returns the next block with the request the core would send. `commitMerge(range, summary)` stores your model's answer, and rejects an empty one or one over `summaryBytes`.
- **Search.** FTS5 inside Durable Object SQLite, with `LIKE` as a fallback.
- **Destroy.** `destroy()` on the object's stub deletes the alarm and all of the object's storage. It is not part of `Memory`. With nothing stored, the object ceases to exist once it shuts down. The next call under its name starts an empty memory at `#0`.

`defineMemoryObject` takes these options:

| Option | Default | Meaning |
|---|---|---|
| `summarizer(env)` | none | Writes summaries from the alarm. Without one, call `nextMerge()` and `commitMerge()` yourself. |
| `limits.maxEntryBytes` | 280 | Longest memory, in UTF-8 bytes. |
| `limits.summaryBytes` | 512 | Longest summary, in UTF-8 bytes. |
| `limits.viewBytes` | 16,384 | The view's high mark, in UTF-8 bytes. Half of it is the low mark. |
| `mergesPerAlarm` | 32 | Nodes one alarm run stores before it reschedules. |

`scripts/view-stability.mjs` replays 2,000 notes, compacts after each, and measures how much of each wake the next one keeps byte for byte. With `viewBytes` at 24,000, consecutive wakes share 99.1% of the previous view on average and all of it at the median, and 10 of 1,000 wakes keep less than half. At 16,384 they share 98.8% on average, and 13 keep less than half. Before batches, when the view merged one pair per note, consecutive wakes shared 90.8% at 24,000 and 91.2% at 16,384, with 86 and 67 wakes below half. The cover this package used before that shared 61% on average and 70.5% at the median.

## Limitation: you cannot forget one memory

There is no way to remove a single memory. To remove memories, destroy the whole scope with `destroy()`, or with **Destroy this memory** in the [MCP demo](#try-it-over-mcp).

Hiding a raw memory is easy, and supersede already does it. The hard part is the summaries above the memory. A node's text is fixed once it is built, and every built ancestor of the memory may repeat it. Supersede has the same gap today: a summary built before the supersede keeps the replaced fact.

Neither spec covers forgetting a memory. UniiChat builds each node once ("Each node is built once and logged, and never built again"), so the view stays byte-identical and the prompt cache keeps it. OptMem treats summaries as "a cache, rebuildable from the log alone", and its `memo forget <lo>-<hi>` drops one bad summary for the next nap to rebuild. Neither removes a raw memory.

### How forgetting could work

A memory has one ancestor per level, so forgetting it touches at most log2(T) nodes, rounded down, for T memories. That is 19 nodes at a million memories, however old the memory is. This design keeps the tree's rules:

1. Record the forget in an append-only table, so the log stays unedited. Hide the memory the way supersede does.
2. In the same transaction, mark the memory's built ancestors stale. Do not delete them, because `appendNode()` needs each level to stay a dense prefix.
3. Rebuild the stale nodes bottom-up from their children, with the normal merge request. Each rebuild waits for the level below it. Low levels are often free merges, so most model calls happen higher in the tree. The alarm runs the rebuild, or `nextMerge()` hands out stale nodes before new blocks.
4. Keep the view's shape. Exactly one view line covers the memory. That line keeps its old text until its rebuild is stored, then changes in place. Lines before it stay byte-identical. For an old memory the line is near the top, so the prompt cache misses once.
5. Run the same rebuild after a supersede.

Two gaps remain after the rebuild. First, the summarizer sees the view as context, so a summary written later for other memories may have copied the fact. Rebuilding the ancestors does not reach that summary. A full-text search of the node summaries for the memory's words finds most of them. Second, the agent may have saved the same fact again in a later memory. `recall` finds it, and it needs its own forget.

A cheaper design asks the model to delete the fact from each ancestor's text, in parallel. It is faster, but a node is then no longer built from its two children, and every later merge builds on edited text. That is why the rebuild is the recommended design.

## What the tests guarantee

- Compaction and supersede never modify a raw memory.
- One `sourceId` never creates two memories.
- Every node covers an aligned block and is built from exactly its two children.
- A node is stored only as the next one at its level with both children present, whatever order `commitMerge()` is called in.
- Between two wakes, the view only gains memories at its end, or one batch merges lines into their parents until the view is at most half of `viewBytes`. It never splits a line or shows a placeholder, and it fits `viewBytes` once the parents it needs are built.
- A log of 100,000 memories with no stored view folds in under 5 seconds.
- A summarizer request contains no `#` id. A reply over the limit is asked again with the cut shown, and the shortest of five tries is kept.
- At most 8 summarizer conversations run at once, and one failing block does not stop the others.
- `zoom()` opens only built summaries and reaches raw memories.
- Two scopes never leak into each other.
- A replayed Pi tool call does not duplicate a memory.
- The memory section stays the same across the tool steps of one run and refreshes on the next.
- Inside workerd, the alarm reschedules until nothing is pending, and 10 s after a summarizer failure.
- Inside workerd, `destroy()` deletes the alarm and every memory, and the scope starts over at `#0`.

## Try it over MCP

`examples/mcp-demo` is one Worker that gives Claude Code, Codex, or Pi a memory over MCP. `memory_note`, `memory_recall`, and `memory_zoom` work as in the Pi extension, and `memory_wake` reads the view. The memory object has no summarizer, so the agent writes each summary line itself through `memory_pending` and `memory_commit`. The demo sets `viewBytes` to 1,024 instead of 16,384, so about 20 short notes are enough to see old notes fold into summary lines.

The demo has no login. Each memory lives at a URL with an unguessable id, and anyone who has the URL can read and write the memory. Each client IP gets 300 memory requests a minute.

A hosted copy runs at https://pi-durable-memory.jhonsfran.workers.dev.

To connect an agent:

1. Start the dev server. The script builds this package first.

   ```sh
   pnpm install
   pnpm --filter mcp-demo dev   # http://localhost:8787
   ```

2. Open http://localhost:8787 and click **Create a memory**.
3. Copy the command for your agent from the memory's page, and run it:

   ```sh
   claude mcp add --transport http memory http://localhost:8787/m/<id>
   codex mcp add memory --url http://localhost:8787/m/<id>
   pi mcp add memory --url http://localhost:8787/m/<id>
   ```

4. Start a new agent session and ask the agent to remember something. To see the note, click **Refresh** on the page.

The page lists the view, oldest first. Only the top-level lines are in the agent's context, because they are what `memory_wake` returns. To see the two halves of a `#a-b` line, click it. The page then shows what `memory_zoom` returns, and the agent sees those lines only when it calls `memory_zoom` itself.

When you finish testing:

1. Click **Destroy this memory** on the page. It deletes every note and summary.
2. Remove the server from your agent. Claude Code adds a server to the current project by default, so run its command in the directory where you ran `add`.

   ```sh
   claude mcp remove memory
   codex mcp remove memory
   pi mcp remove memory
   ```

The URL still works after a destroy. If an agent or the page uses it again, a new, empty memory starts there.

With the dev server running, `pnpm --filter mcp-demo smoke` calls every tool through an MCP client, checks the replies, and destroys the memory it used.

## Develop

```sh
pnpm install
pnpm check   # typecheck, Node tests (core and extension on node:sqlite), workers-runtime tests (the object, inside workerd)
pnpm build && node scripts/view-stability.mjs . 2000 24000   # how much of each wake the next one keeps
```

## Credits

The memory model is [OptMem](https://github.com/VictorTaelin/OptMem) by [Victor Taelin](https://github.com/VictorTaelin). It has an append-only log of one-line memories, a binary tree of summaries over aligned power-of-two blocks, and zoom and recall back to the raw entries. The view fold, the summarizer conversation, and the structure of the summarizer prompt follow his spec, first published as OptChat and now called [UniiChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449). From that spec come the strictly binary tree, the stored view that only appends and merges its most due pairs in batches, the summarizer that sees that view as context, and the ruler with cut-at-limit retries that keeps summaries near their size.

The spec puts ids in the summarizer's request so that compactions share the agent's prompt cache. This summarizer has no such cache to share, so its requests carry no ids. UniiChat logs every chat message. This package keeps OptMem's curated notes and builds UniiChat's structure above them. Taelin wrote his tools for a shell agent. This package is a TypeScript implementation of the same design for Pi Durable agents on Cloudflare Durable Objects, with an injected summarizer, scopes, idempotent notes, and an admission hook. No code is shared.

If you build on this, credit OptMem and UniiChat too.
