import type { IndexKey } from "./types.js";

/** `m:<id>` for a memory, `n:<level>:<startId>` for a node: the one string form shared by the core's fusion map and index storage. */
export function encodeIndexKey(key: IndexKey): string {
	return key.kind === "memory" ? `m:${key.id}` : `n:${key.level}:${key.startId}`;
}

export function decodeIndexKey(text: string): IndexKey {
	const parts = text.split(":").map(Number);
	if (text.startsWith("m:") && parts.length === 2 && Number.isInteger(parts[1])) return { kind: "memory", id: parts[1] as number };
	if (text.startsWith("n:") && parts.length === 3 && Number.isInteger(parts[1]) && Number.isInteger(parts[2])) {
		return { kind: "node", level: parts[1] as number, startId: parts[2] as number };
	}
	throw new Error(`Not an index key: ${JSON.stringify(text)}`);
}
