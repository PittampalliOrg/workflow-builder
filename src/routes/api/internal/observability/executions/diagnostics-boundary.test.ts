import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const routeFiles = [
	'[executionId]/digest/+server.ts',
	'[executionId]/spans/+server.ts',
	'[executionId]/spans/[spanId]/+server.ts',
	'[executionId]/llm-turn/+server.ts',
	'[executionId]/logs/+server.ts'
];

describe('internal workflow diagnostics route boundary', () => {
	it('keeps telemetry storage and response assembly behind the application service', () => {
		const root = dirname(fileURLToPath(import.meta.url));

		for (const file of routeFiles) {
			const source = readFileSync(join(root, file), 'utf8');
			expect(source).toContain('workflowDiagnostics');
			expect(source).not.toContain('$lib/server/otel');
			expect(source).not.toContain('run-digest-loader');
			expect(source).not.toContain('diagnostic-redaction');
			expect(source).not.toContain('$lib/server/application/adapters');
			expect(source).not.toContain('$lib/server/db');
			expect(source).not.toContain('drizzle-orm');
		}
	});

	it('normalizes public page limits to positive bounded values', () => {
		const root = dirname(fileURLToPath(import.meta.url));
		const spans = readFileSync(join(root, '[executionId]/spans/+server.ts'), 'utf8');
		const turns = readFileSync(join(root, '[executionId]/llm-turn/+server.ts'), 'utf8');
		const logs = readFileSync(join(root, '[executionId]/logs/+server.ts'), 'utf8');

		expect(spans).toContain('Math.min(100, Math.max(1,');
		expect(turns).toContain('Math.min(3, Math.max(1,');
		expect(logs).toContain('Math.min(200, Math.max(1,');
	});
});
