import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('execution digest route', () => {
	it('loads telemetry through the application diagnostics port', () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '+server.ts'), 'utf8');

		expect(source).toContain('application.workflowDiagnostics.getDigest');
		expect(source).toContain("'cache-control': 'no-store'");
		expect(source).not.toContain('$lib/server/otel');
		expect(source).not.toContain('buildRunDigestForExecution');
		expect(source).not.toContain('$lib/server/db');
	});
});
