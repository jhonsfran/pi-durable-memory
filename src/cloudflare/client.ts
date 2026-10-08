import type { Memory } from "../core/types.js";
import type { MemoryObjectRpc } from "./memory-object.js";

/** Maps a scope string to its Durable Object and exposes it as `Memory`. RPC results are structured clones, so entries arrive as plain objects. */
export function createMemoryClient(namespace: DurableObjectNamespace<MemoryObjectRpc>): (scope: string) => Memory {
	return (scope) => {
		const stub = namespace.get(namespace.idFromName(scope));
		return {
			note: (input) => stub.note(input),
			wake: () => stub.wake(),
			recall: (query, options) => stub.recall(query, options),
			zoom: (range) => stub.zoom(range),
			compact: (options) => stub.compact(options),
			pending: () => stub.pending(),
			nextMerge: () => stub.nextMerge(),
			commitMerge: (range, summary) => stub.commitMerge(range, summary),
		};
	};
}
