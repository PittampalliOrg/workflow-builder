import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('investigation studio span-detail boundary', () => {
	it('accepts an execution-scoped detail endpoint for run investigations', () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), 'investigation-studio.svelte'),
			'utf8'
		);

		expect(source).toContain('spanDetailBase?: string | null');
		expect(source).toContain("spanDetailBase.replace(/\\/$/, '')");
		expect(source).toContain('continuedTraceSpans');
		expect(source).toContain('nextSpanCursor');
		expect(source).toContain('generation !== continuationGeneration');
		expect(source).toContain('Load 100 more');
		expect(source).not.toContain('attributesTruncated: false');
	});

	it('keeps the run investigation on the workspace-scoped execution API', () => {
		const source = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				'../../../routes/workspaces/[slug]/workflows/[workflowId]/runs/[executionId]/+page.svelte'
			),
			'utf8'
		);

		expect(source).toContain('/api/observability/executions/${encodeURIComponent(executionId)}/investigation');
		expect(source).not.toContain('/api/observability/sessions/${encodeURIComponent(investigationSessionId)}/investigation');
	});
});
