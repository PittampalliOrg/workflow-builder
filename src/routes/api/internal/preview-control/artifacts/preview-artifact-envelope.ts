import type { PreviewArtifactTransferEnvelope } from '$lib/server/application/ports';

export const MAX_ENVELOPE_BYTES = 16 * 1024;
const MAX_ENCODED_ENVELOPE_BYTES = Math.ceil((MAX_ENVELOPE_BYTES * 4) / 3);

export function decodePreviewArtifactEnvelope(encoded: string): PreviewArtifactTransferEnvelope {
	if (
		!encoded ||
		encoded.length > MAX_ENCODED_ENVELOPE_BYTES ||
		!/^[A-Za-z0-9_-]+$/.test(encoded)
	) {
		throw new Error('artifact envelope is missing or oversized');
	}
	const decoded = Buffer.from(encoded, 'base64url');
	if (decoded.byteLength > MAX_ENVELOPE_BYTES) {
		throw new Error('artifact envelope is missing or oversized');
	}
	return JSON.parse(decoded.toString('utf8')) as PreviewArtifactTransferEnvelope;
}
