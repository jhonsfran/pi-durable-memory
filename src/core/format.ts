import type { MemoryContext, MemoryItem } from "./types.js";

function formatItem(item: MemoryItem): string {
	switch (item.type) {
		case "memory":
			return `#${item.id} ${item.content}`;
		case "summary":
			return `#${item.startId}-${item.endId} ${item.content}`;
		default: {
			const exhaustive: never = item;
			throw new Error(`Unknown memory item ${JSON.stringify(exhaustive)}`);
		}
	}
}

export function formatMemoryItems(items: readonly MemoryItem[]): string {
	return items.map(formatItem).join("\n");
}

export function formatMemoryContext(context: MemoryContext): string {
	return formatMemoryItems(context.items);
}
