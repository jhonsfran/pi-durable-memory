const encoder = new TextEncoder();

export const byteLength = (text: string): number => encoder.encode(text).length;

export const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

/** Longest prefix of at most `maxBytes` UTF-8 bytes that ends on a character boundary. */
export function truncateUtf8(text: string, maxBytes: number): string {
	if (byteLength(text) <= maxBytes) return text;
	// `encodeInto` never writes a partial code point, so `read` lands on a character boundary.
	const { read } = encoder.encodeInto(text, new Uint8Array(maxBytes));
	return text.slice(0, read);
}
