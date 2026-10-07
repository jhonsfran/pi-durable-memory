import { DurableObject } from "cloudflare:workers";
import { createMemory } from "../core/memory.js";
import type { CompactOptions, Memory, MemoryIndex, MemoryLimits, MemoryRange, MemorySummarizer, NoteInput, RecallOptions, WakeOptions } from "../core/types.js";
import { createSqliteMemoryStore } from "../sqlite/store.js";
import { durableObjectSql } from "./sql.js";

export interface MemoryObjectOptions<Env> {
	readonly summarizer: (env: Env) => MemorySummarizer;
	/**
	 * Semantic index for `recall()`, built once per object alongside its store. Without one, recall
	 * is full-text only. A Durable Object cannot recover its name from its id, so a per-scope
	 * Vectorize namespace is `ctx.id.toString()`:
	 * `createVectorizeIndex(env.VECTORS, { namespace: ctx.id.toString(), embedder })`. For small
	 * scopes the SQLite brute-force index works inside the object too:
	 * `createSqliteVectorIndex(durableObjectSql(ctx.storage), { scope: "self", embedder })`.
	 */
	readonly index?: ((env: Env, ctx: DurableObjectState) => MemoryIndex | Promise<MemoryIndex>) | undefined;
	readonly limits?: Partial<MemoryLimits> | undefined;
	/** Merges per alarm run before rescheduling. Default 32. */
	readonly mergesPerAlarm?: number | undefined;
}

/** What a stub of the Durable Object exposes over RPC: the `Memory` interface. */
export type MemoryObjectRpc = Memory & Rpc.DurableObjectBranded;

export type MemoryObjectClass<Env> = typeof DurableObject<Env> & (new (ctx: DurableObjectState, env: Env) => MemoryObjectRpc);

/** The Durable Object id is the scope; the store's scope column exists only so the Node deployment can multiplex scopes in one file. */
const SCOPE = "self";

/**
 * A Durable Object class holding one memory scope, named by the scope string. It compacts from an
 * alarm after every write, so callers never run `compact()` themselves.
 */
export function defineMemoryObject<Env>(options: MemoryObjectOptions<Env>): MemoryObjectClass<Env> {
	const mergesPerAlarm = options.mergesPerAlarm ?? 32;

	return class MemoryObject extends DurableObject<Env> implements Memory {
		private memory: Promise<Memory> | undefined;

		private open(): Promise<Memory> {
			this.memory ??= Promise.all([createSqliteMemoryStore(durableObjectSql(this.ctx.storage), { scope: SCOPE }), options.index?.(this.env, this.ctx)]).then(
				([store, index]) => createMemory({ store, summarizer: options.summarizer(this.env), index, limits: options.limits }),
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
		private scheduleCompaction(): Promise<void> {
			return this.ctx.storage.setAlarm(Date.now() + 1);
		}

		override async alarm(): Promise<void> {
			const memory = await this.open();
			await memory.compact({ maxMerges: mergesPerAlarm });
			// Re-read instead of trusting `compact()`'s count: a write that landed during the run is not in it.
			if ((await memory.pending()) > 0) await this.scheduleCompaction();
		}

		async note(input: NoteInput) {
			const entry = await (await this.open()).note(input);
			await this.scheduleCompaction();
			return entry;
		}

		async wake(options?: WakeOptions) {
			return (await this.open()).wake(options);
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

		async forget(range: MemoryRange) {
			const dropped = await (await this.open()).forget(range);
			if (dropped > 0) await this.scheduleCompaction();
			return dropped;
		}
	};
}
