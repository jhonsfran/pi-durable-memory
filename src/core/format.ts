import type { MemoryContext, MemoryItem } from "./types.js";

function formatItem(item: MemoryItem): string {
	switch (item.type) {
		case "memory":
			return `#${item.id} ${item.content}`;
		case "summary":
			return `#${item.startId}-${item.endId} ${item.content}`;
		case "pending":
			return `#${item.startId}-${item.endId} (not summarized yet)`;
		default: {
			const exhaustive: never = item;
			throw new Error(`Unknown memory item ${JSON.stringify(exhaustive)}`);
		}
	}
}

/** One line per item, as the model reads them: `#12 text`, `#8-15 text`, `#8-15 (not summarized yet)`. */
export function formatMemoryItems(items: readonly MemoryItem[]): string {
	return items.map(formatItem).join("\n");
}

export function formatMemoryContext(context: MemoryContext): string {
	return formatMemoryItems(context.items);
}
