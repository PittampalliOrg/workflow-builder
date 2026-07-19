import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('preview workflow diagnostics hexagonal boundary', () => {
	it('keeps transport, ClickHouse, and credentials in driven adapters', () => {
		const application = readFileSync(
			resolve(process.cwd(), 'src/lib/server/application/preview-workflow-diagnostics.ts'),
			'utf8'
		);
		const port = readFileSync(
			resolve(
				process.cwd(),
				'src/lib/server/application/ports/preview-workflow-diagnostics.ts'
			),
			'utf8'
		);

		for (const source of [application, port]) {
			expect(source).not.toContain('$lib/server/application/adapters');
			expect(source).not.toContain('$lib/server/otel');
			expect(source).not.toContain('$lib/server/db');
			expect(source).not.toMatch(/\bfetch\s*\(/);
			expect(source).not.toContain('CLICKHOUSE_');
			expect(source).not.toContain('PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN');
		}
	});

	it('keeps the HTTP route as a thin authenticated application adapter', () => {
		const route = readFileSync(
			resolve(
				process.cwd(),
				'src/routes/api/internal/preview-control/environment/workflow-diagnostics/+server.ts'
			),
			'utf8'
		);
		expect(route).toContain('requirePreviewControlCapability');
		expect(route).toContain('previewWorkflowDiagnosticsBroker.execute');
		expect(route).not.toContain('$lib/server/otel');
		expect(route).not.toContain('$lib/server/db');
		expect(route).not.toMatch(/\bfetch\s*\(/);
	});
});
