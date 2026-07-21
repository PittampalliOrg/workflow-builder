import { describe, expect, it } from 'vitest';
import { boundDiagnosticEvidence, redactDiagnosticEvidence } from './diagnostic-redaction';

describe('redactDiagnosticEvidence', () => {
	it('redacts nested secret keys and credentials embedded in free text', () => {
		const value = redactDiagnosticEvidence({
			headers: {
				Authorization: 'Bearer header-secret',
				'X-Api-Key': 'api-key-secret',
				'X-Internal-Token': 'internal-token-secret',
				'X-Connection-External-Id': 'conn-1'
			},
			message:
				'request failed: Authorization: Bearer eyJhbGci.abc.def api_key=sk-live-123 KIMI_API_KEY=kimi-live-456',
			turns: [{ content: 'password: hunter2' }]
		});

		expect(value.headers.Authorization).toBe('[REDACTED]');
		expect(value.headers['X-Api-Key']).toBe('[REDACTED]');
		expect(value.headers['X-Internal-Token']).toBe('[REDACTED]');
		expect(value.headers['X-Connection-External-Id']).toBe('conn-1');
		expect(value.message).toContain('Authorization: [REDACTED]');
		expect(value.message).toContain('api_key=[REDACTED]');
		expect(value.message).toContain('KIMI_API_KEY=[REDACTED]');
		expect(value.message).not.toContain('kimi-live-456');
		expect(value.turns[0].content).toBe('password=[REDACTED]');
	});

	it('preserves token usage metrics while redacting singular credential tokens', () => {
		const value = redactDiagnosticEvidence({
			tokens: 42,
			promptTokens: 12,
			completion_tokens: 20,
			totalTokens: 32,
			reasoningTokens: 7,
			cacheReadInputTokens: 100,
			tokenBudget: 1_000_000,
			token_count: 32,
			max_tokens: 4096,
			token: 'opaque-secret',
			apiToken: 'api-secret',
			access_token: 'access-secret',
			sessionToken: 'session-secret'
		});

		expect(value).toMatchObject({
			tokens: 42,
			promptTokens: 12,
			completion_tokens: 20,
			totalTokens: 32,
			reasoningTokens: 7,
			cacheReadInputTokens: 100,
			tokenBudget: 1_000_000,
			token_count: 32,
			max_tokens: 4096,
			token: '[REDACTED]',
			apiToken: '[REDACTED]',
			access_token: '[REDACTED]',
			sessionToken: '[REDACTED]'
		});
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
		expect(value.truncated).toBe('[REDACTED malformed JSON]');
		expect(value.dataUri).toBe('[REDACTED image data URI]');
		expect(JSON.stringify(value)).not.toContain(pixels);
	});

	it('recursively redacts secret keys inside JSON-encoded trace attributes', () => {
		const sessionToken = 'signed-workflow-session-token';
		const bearerToken = 'nested-bearer-token';
		const accessToken = 'doubly-encoded-access-token';
		const truncatedToken = 'truncated-signed-session-token';
		const commaToken = 'part-one,part-two';
		const objectToken = 'nested-object-token';
		const value = redactDiagnosticEvidence({
			'input.value': JSON.stringify({
				workflowMcpSessionToken: sessionToken,
				nested: {
					headers: { Authorization: `Bearer ${bearerToken}` },
					usage: { promptTokens: 12, reasoningTokens: 3 }
				}
			}),
			doublySerialized: JSON.stringify(
				JSON.stringify({ access_token: accessToken, status: 'ready' })
			),
			truncated: `{"workflowMcpSessionToken":"${truncatedToken}`,
			escapedTruncated: `"{\\"access_token\\":\\"${accessToken}`,
			commaTruncated: `{"workflowMcpSessionToken":"${commaToken}`,
			objectTruncated: `{"workflowMcpSessionToken":{"raw":"${objectToken}`
		});
		const input = JSON.parse(value['input.value']);
		const nested = JSON.parse(JSON.parse(value.doublySerialized));
		const serialized = JSON.stringify(value);

		expect(input).toMatchObject({
			workflowMcpSessionToken: '[REDACTED]',
			nested: {
				headers: { Authorization: '[REDACTED]' },
				usage: { promptTokens: 12, reasoningTokens: 3 }
			}
		});
		expect(nested).toEqual({ access_token: '[REDACTED]', status: 'ready' });
		expect(value.truncated).toBe('[REDACTED malformed JSON]');
		expect(value.escapedTruncated).toBe('[REDACTED malformed JSON]');
		expect(value.commaTruncated).toBe('[REDACTED malformed JSON]');
		expect(value.objectTruncated).toBe('[REDACTED malformed JSON]');
		expect(serialized).not.toContain(sessionToken);
		expect(serialized).not.toContain(bearerToken);
		expect(serialized).not.toContain(accessToken);
		expect(serialized).not.toContain(truncatedToken);
		expect(serialized).not.toContain(commaToken);
		expect(serialized).not.toContain(objectToken);
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
