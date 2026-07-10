import { describe, expect, it } from 'vitest';
import {
	decodePreviewArtifactEnvelope,
	MAX_ENVELOPE_BYTES
} from './preview-artifact-envelope';

describe('preview artifact envelope boundary', () => {
	it('rejects decoded envelopes above 16 KiB before JSON parsing', () => {
		const encoded = Buffer.alloc(MAX_ENVELOPE_BYTES + 1, 0x20).toString('base64url');
		expect(() => decodePreviewArtifactEnvelope(encoded)).toThrow(
			'artifact envelope is missing or oversized'
		);
	});

	it('accepts a small base64url JSON envelope', () => {
		const value = { identity: { previewName: 'preview-one' } };
		expect(
			decodePreviewArtifactEnvelope(
				Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
			)
		).toEqual(value);
	});
});
