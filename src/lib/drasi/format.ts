/**
 * Defensive text helpers for the Drasi dashboard. Everything rendered from a
 * wire payload is clipped and control-character-stripped so a malformed or
 * hostile response cannot blow up the layout or inject control sequences.
 * Keep these client-safe (no server imports).
 */

const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/** Strip control characters, collapse whitespace, and hard-clip length. */
export function clipText(value: unknown, max = 140): string {
	if (typeof value !== "string") return "";
	const clean = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

/** Clip an id-ish value, keeping it mono-safe. */
export function clipId(value: unknown, max = 80): string {
	return clipText(value, max);
}

/** Shorten an id for compact display while preserving the full value for titles. */
export function shortenId(value: string, head = 8): string {
	if (value.length <= head + 1) return value;
	return `${value.slice(0, head)}…`;
}
