import { describe, expect, it } from 'vitest';

import { applyWorkflowSpecOperations } from './spec-operations';

function spec() {
	return {
		document: {
			dsl: '1.0.0',
			namespace: 'workflow-builder',
			name: 'test-workflow',
			version: '1.0.0',
			title: 'Test Workflow',
		},
		do: [
			{
				'fetch-data': {
					call: 'http',
					with: {
						method: 'GET',
						endpoint: {
							uri: 'https://example.com/data',
						},
					},
				},
			},
		],
	};
}

describe('applyWorkflowSpecOperations', () => {
	it('updates an existing task with a deep patch', () => {
		const result = applyWorkflowSpecOperations({
			workflowName: 'Test Workflow',
			spec: spec(),
			operations: [
				{
					op: 'update_task',
					taskName: 'fetch-data',
					patch: {
						with: {
							endpoint: {
								uri: 'https://example.com/updated',
							},
						},
					},
				},
			],
		});

		expect(result.applied).toBe(true);
		expect(result.validation.valid).toBe(true);
		expect(result.changedTaskNames).toEqual(['fetch-data']);
		expect(
			(((result.proposedSpec?.do as Array<Record<string, unknown>>)[0]['fetch-data'] as Record<string, unknown>)
				.with as Record<string, unknown>).method,
		).toBe('GET');
		expect(
			((((result.proposedSpec?.do as Array<Record<string, unknown>>)[0]['fetch-data'] as Record<string, unknown>)
				.with as Record<string, unknown>).endpoint as Record<string, unknown>).uri,
		).toBe('https://example.com/updated');
	});

	it('blocks ambiguous clarification operations', () => {
		const result = applyWorkflowSpecOperations({
			workflowName: 'Test Workflow',
			spec: spec(),
			operations: [{ op: 'clarify', question: 'Which task should I update?' }],
		});

		expect(result.applied).toBe(false);
		expect(result.needsClarification).toBe(true);
		expect(result.message).toBe('Which task should I update?');
	});

	it('blocks create_workflow when editing an existing workflow', () => {
		const result = applyWorkflowSpecOperations({
			workflowName: 'Test Workflow',
			spec: spec(),
			operations: [
				{
					op: 'create_workflow',
					spec: {
						document: {
							dsl: '1.0.0',
							namespace: 'workflow-builder',
							name: 'replacement',
							version: '1.0.0',
						},
						do: [],
					},
				},
			],
		});

		expect(result.applied).toBe(false);
		expect(result.validation.valid).toBe(false);
		expect(result.validation.errors[0]).toContain('Refusing to replace a non-empty workflow');
		expect(result.proposedSpec?.do).toEqual(spec().do);
	});

	it('blocks an empty create_workflow for a new workflow', () => {
		const result = applyWorkflowSpecOperations({
			workflowName: 'Test Workflow',
			spec: null,
			operations: [
				{
					op: 'create_workflow',
					spec: {
						document: {
							dsl: '1.0.0',
							namespace: 'workflow-builder',
							name: 'empty-workflow',
							version: '1.0.0',
						},
						do: [],
					},
				},
			],
		});

		expect(result.applied).toBe(false);
		expect(result.validation.valid).toBe(false);
		expect(result.validation.errors[0]).toContain('proposed workflow has no tasks');
	});

	it('normalizes document.do for new create_workflow plans', () => {
		const result = applyWorkflowSpecOperations({
			workflowName: 'Test Workflow',
			spec: null,
			operations: [
				{
					op: 'create_workflow',
					spec: {
						document: {
							dsl: '1.0.0',
							namespace: 'workflow-builder',
							name: 'document-do-workflow',
							version: '1.0.0',
							do: [
								{
									'fetch-data': {
										call: 'http',
										with: {
											method: 'GET',
											endpoint: {
												uri: 'https://example.com/data',
											},
										},
									},
								},
							],
						},
					},
				},
			],
		});

		expect(result.applied).toBe(true);
		expect((result.proposedSpec?.do as unknown[]).length).toBe(1);
		expect((result.proposedSpec?.document as Record<string, unknown>).do).toBeUndefined();
	});

	it('preserves existing tasks on document-only updates', () => {
		const result = applyWorkflowSpecOperations({
			workflowName: 'Test Workflow',
			spec: spec(),
			operations: [
				{
					op: 'update_document',
					fields: {
						title: 'Updated',
					},
				},
			],
		});

		expect(result.applied).toBe(true);
		expect((result.proposedSpec?.do as unknown[]).length).toBe(1);
	});
});
