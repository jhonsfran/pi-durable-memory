import { DurableObject } from "cloudflare:workers";
import { label } from "../core/block.js";
import { createMemory } from "../core/memory.js";
import type { CompactOptions, Memory, MemoryLimits, MemoryRange, MemorySummarizer, NoteInput, RecallOptions } from "../core/types.js";
import { createSqliteMemoryStore } from "../sqlite/store.js";
import { durableObjectSql } from "./sql.js";

export interface MemoryObjectOptions<Env> {
	/**
	 * Writes summaries from the alarm scheduled after every write. Without one, no alarm is
	 * scheduled and clients summarize through `nextMerge()` and `commitMerge()`, as the MCP tools
	 * in `examples/mcp-demo` do.
	 */
	readonly summarizer?: ((env: Env) => MemorySummarizer) | undefined;
	readonly limits?: Partial<MemoryLimits> | undefined;
	/** Merges per alarm run before rescheduling. Default 32. */
	readonly mergesPerAlarm?: number | undefined;
}

/** What a stub of the Durable Object exposes over RPC: the `Memory` interface, and `destroy()` for the object itself. */
export type MemoryObjectRpc = Memory & { destroy(): Promise<void> } & Rpc.DurableObjectBranded;

export type MemoryObjectClass<Env> = typeof DurableObject<Env> & (new (ctx: DurableObjectState, env: Env) => MemoryObjectRpc);

/** The Durable Object id is the scope; the store's scope column exists only so the test suites can hold several scopes in one database. */
const SCOPE = "self";

const RETRY_MS = 10_000;

/**
 * A Durable Object class holding one memory scope, named by the scope string. With a summarizer it
 * compacts from an alarm after every write, so callers never run `compact()` themselves.
 */
export function defineMemoryObject<Env>(options: MemoryObjectOptions<Env>): MemoryObjectClass<Env> {
	const mergesPerAlarm = options.mergesPerAlarm ?? 32;
	const { summarizer } = options;

	return class MemoryObject extends DurableObject<Env> implements Memory {
		private memory: Promise<Memory> | undefined;
		private readonly loggedFailures = new Set<string>();

		private open(): Promise<Memory> {
			this.memory ??= createSqliteMemoryStore(durableObjectSql(this.ctx.storage), { scope: SCOPE }).then(
				(store) => createMemory({ store, summarizer: summarizer?.(this.env), limits: options.limits }),
				(error: unknown) => {
					this.memory = undefined;
					throw error;
				},
			);
			return this.memory;
		}

		/**
		 * Always set, and strictly later than any alarm that has already fired. `getAlarm()` can still
		 * report the alarm whose handler is running, so "set only if none" would skip a write that lands
		 * late in a run. Re-setting an alarm to the exact time of the one running is a no-op write in
		 * workerd (no reschedule request is sent) and that alarm never fires again; `+ 1` avoids it.
		 * `setAlarm()` replaces, so a burst of writes still collapses into one run.
		 */
		private async scheduleCompaction(): Promise<void> {
			if (summarizer !== undefined) await this.ctx.storage.setAlarm(Date.now() + 1);
		}

		/**
		 * A summarizer failure retries after `RETRY_MS` instead of throwing: the platform's alarm backoff
		 * grows and gives up after six retries, while the view waits on these summaries.
		 */
		override async alarm(): Promise<void> {
			if (summarizer === undefined) return;
			const memory = await this.open();
			const { failed } = await memory.compact({ maxMerges: mergesPerAlarm });
			for (const failure of failed) {
				if (this.loggedFailures.has(label(failure))) continue;
				this.loggedFailures.add(label(failure));
				console.error(`Summarizing ${label(failure)} failed, retrying every ${RETRY_MS / 1000} s: ${failure.message}`);
			}
			if (failed.length > 0) await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
			// Re-read instead of trusting `compact()`'s count: a write that landed during the run is not in it.
			else if ((await memory.pending()) > 0) await this.scheduleCompaction();
		}

		async note(input: NoteInput) {
			const entry = await (await this.open()).note(input);
			await this.scheduleCompaction();
			return entry;
		}

		async wake() {
			return (await this.open()).wake();
		}

		async recall(query: string, options?: RecallOptions) {
			return (await this.open()).recall(query, options);
		}

		async zoom(range: MemoryRange) {
			return (await this.open()).zoom(range);
		}

		async compact(options?: CompactOptions) {
			return (await this.open()).compact(options);
		}

		async pending() {
			return (await this.open()).pending();
		}

		async nextMerge() {
			return (await this.open()).nextMerge();
		}

		async commitMerge(range: MemoryRange, summary: string) {
			return (await this.open()).commitMerge(range, summary);
		}

		/**
		 * Delete the whole scope: every memory, summary, the view and any alarm. With nothing stored,
		 * the object ceases to exist once it shuts down; the next call under its name starts an empty
		 * memory. `deleteAll()` keeps the alarm on compatibility dates before 2026-02-24, hence `deleteAlarm()`.
		 */
		async destroy(): Promise<void> {
			this.memory = undefined;
			this.loggedFailures.clear();
			await this.ctx.storage.deleteAlarm();
			await this.ctx.storage.deleteAll();
		}
	};
}
