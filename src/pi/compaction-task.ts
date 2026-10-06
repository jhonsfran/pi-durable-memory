import { defineTask } from "@earendil-works/pi-durable";
import type { Memory } from "../core/types.js";

export type MemoryResolver = (scope: string) => Memory | Promise<Memory>;

const BATCH = 8;

/**
 * Compacts one scope in batches of `BATCH` merges, one batch per invocation. Tasks are looked up by name from the
 * registry, so the definition is built per extension to close over the host's memory resolver.
 */
export function createMemoryCompactionTask(memory: MemoryResolver) {
	return defineTask<{ scope: string }, { phase: "run"; merged: number }, { merged: number }>({
		name: "memory.compact",
		version: 1,
		initial: () => ({ phase: "run", merged: 0 }),
		phases: {
			run: async (task, runtime, context) => {
				const scoped = await memory(task.input.scope);
				const batch = await scoped.compact({ maxMerges: BATCH });
				const merged = task.state.checkpoint.merged + batch.merged;
				await runtime.commit(
					() =>
						batch.pending > 0
							? { status: "running", checkpoint: { phase: "run", merged } }
							: { status: "terminal", outcome: { status: "completed", result: { merged } } },
					context,
				);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
}
