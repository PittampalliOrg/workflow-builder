import { createHash } from 'node:crypto';

const MAX_CURSOR_CHARACTERS = 512;
const MAX_PAGE_OFFSET = 10_000;

export function pageCursorScope(kind: string, filters: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify({ kind, filters }))
		.digest('base64url')
		.slice(0, 24);
}

export function decodePageCursor(value: string | null, expectedScope: string): number | null {
	if (!value) return 0;
	if (value.length > MAX_CURSOR_CHARACTERS) return null;
	try {
		const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
			version?: unknown;
			offset?: unknown;
			scope?: unknown;
		};
		return parsed.version === 1 &&
			parsed.scope === expectedScope &&
			Number.isInteger(parsed.offset) &&
			Number(parsed.offset) >= 0 &&
			Number(parsed.offset) <= MAX_PAGE_OFFSET
			? Number(parsed.offset)
			: null;
	} catch {
		return null;
	}
}

export function encodePageCursor(offset: number, scope: string): string | null {
	if (!Number.isInteger(offset) || offset < 0 || offset > MAX_PAGE_OFFSET) return null;
	return Buffer.from(JSON.stringify({ version: 1, offset, scope }), 'utf8').toString(
		'base64url'
	);
}
