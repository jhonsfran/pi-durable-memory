export class MemoryEntryEmpty extends Error {
	override readonly name = "MemoryEntryEmpty";

	constructor() {
		super("A memory is one line of text; this one is empty");
	}
}

export class MemoryEntryTooLong extends Error {
	override readonly name = "MemoryEntryTooLong";
	readonly bytes: number;
	readonly maxBytes: number;

	constructor(bytes: number, maxBytes: number) {
		super(`Too long: ${bytes} bytes, limit ${maxBytes}. Accented characters cost 2 bytes or more`);
		this.bytes = bytes;
		this.maxBytes = maxBytes;
	}
}

export class InvalidRange extends Error {
	override readonly name = "InvalidRange";

	constructor(message: string) {
		super(message);
	}
}
