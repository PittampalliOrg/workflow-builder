import { describe, expect, it } from 'vitest';
import { boundDiagnosticEvidence, redactDiagnosticEvidence } from './diagnostic-redaction';

describe('redactDiagnosticEvidence', () => {
	it('redacts nested secret keys and credentials embedded in free text', () => {
		const value = redactDiagnosticEvidence({
			headers: { Authorization: 'Bearer header-secret', 'X-Connection-External-Id': 'conn-1' },
			message: 'request failed: Authorization: Bearer eyJhbGci.abc.def api_key=sk-live-123',
			turns: [{ content: 'password: hunter2' }]
		});

		expect(value.headers.Authorization).toBe('[REDACTED]');
		expect(value.headers['X-Connection-External-Id']).toBe('conn-1');
		expect(value.message).toContain('Authorization: [REDACTED]');
		expect(value.message).toContain('api_key=[REDACTED]');
		expect(value.turns[0].content).toBe('password=[REDACTED]');
	});

	it('redacts basic auth, cookies, and URL userinfo from free text', () => {
		const value = redactDiagnosticEvidence({
			body: [
				'Authorization: Basic dXNlcjpwYXNz',
				'Proxy-Authorization: Digest opaque-response',
				'Cookie: sid=supersecret; theme=dark',
				'Set-Cookie: refresh=secret; HttpOnly',
				'GET https://alice:password@example.test/private'
			].join('\n')
		});

		expect(value.body).not.toContain('dXNlcjpwYXNz');
		expect(value.body).not.toContain('opaque-response');
		expect(value.body).not.toContain('supersecret');
		expect(value.body).not.toContain('refresh=secret');
		expect(value.body).not.toContain('alice:password');
		expect(value.body).toContain('Authorization: [REDACTED]');
		expect(value.body).toContain('Cookie: [REDACTED]');
		expect(value.body).toContain('https://[REDACTED]@example.test/private');
	});

	it('redacts structured and serialized screenshot pixels, including truncated JSON', () => {
		const pixels = 'iVBORw0KGgo-sensitive-pixels';
		const value = redactDiagnosticEvidence({
			structured: { payloadBase64: pixels, contentType: 'image/png' },
			serialized: JSON.stringify({
				storageRef: 'screenshots/frame.png',
				payloadBase64: pixels
			}),
			doublySerialized: JSON.stringify(
				JSON.stringify({ payload_base64: pixels })
			),
			truncated: `{"payloadBase64":"${pixels}`,
			dataUri: `data:image/png;base64,${pixels}`
		});

		expect(value.structured).toEqual({
			payloadBase64: '[REDACTED]',
			contentType: 'image/png'
		});
		expect(value.serialized).toContain('screenshots/frame.png');
		expect(value.serialized).toContain('"payloadBase64":"[REDACTED]"');
		expect(value.doublySerialized).toContain('payload_base64\\\":\\\"[REDACTED]');
		expect(value.truncated).toBe('{"payloadBase64":"[REDACTED]');
		expect(value.dataUri).toBe('[REDACTED image data URI]');
		expect(JSON.stringify(value)).not.toContain(pixels);
	});

	it('caps nested evidence without losing the surrounding shape', () => {
		const bounded = boundDiagnosticEvidence(
			{ input: 'a'.repeat(20), output: 'b'.repeat(20) },
			40
		);
		expect(bounded.truncated).toBe(true);
		expect(bounded.value).toMatchObject({ input: 'a'.repeat(20) });
		expect(bounded.value).not.toHaveProperty('output');
		expect(Buffer.byteLength(JSON.stringify(bounded.value), 'utf8')).toBeLessThanOrEqual(40);
	});

	it('counts numeric entries and object keys toward the byte ceiling', () => {
		for (const value of [
			Array.from({ length: 10_000 }, (_, index) => index),
			Object.fromEntries(
				Array.from({ length: 100 }, (_, index) => [`${'k'.repeat(200)}-${index}`, index])
			)
		]) {
			const bounded = boundDiagnosticEvidence(value, 1_024);
			expect(bounded.truncated).toBe(true);
			expect(Buffer.byteLength(JSON.stringify(bounded.value), 'utf8')).toBeLessThanOrEqual(1_024);
		}
	});
});
