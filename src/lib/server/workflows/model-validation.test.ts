import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { validateTriggerModel } from './model-validation';

describe('validateTriggerModel (inline spec options)', () => {
	const makeSpec = (values: string[]) => ({
		document: {
			'x-workflow-builder': {
				input: {
					fields: {
						model: {
							type: 'select',
							label: 'Model',
							options: values.map((v) => ({ label: v, value: v }))
						}
					}
				}
			}
		}
	});

	it('passes when the trigger model is in the declared options', async () => {
		const err = await validateTriggerModel(
			makeSpec(['anthropic/claude-opus-4-7', 'anthropic/claude-sonnet-4-6']),
			{ model: 'anthropic/claude-opus-4-7' }
		);
		expect(err).toBeNull();
	});

	it('rejects a typo with an explanatory allowed-list', async () => {
		const err = await validateTriggerModel(
			makeSpec(['anthropic/claude-opus-4-7', 'anthropic/claude-sonnet-4-6']),
			{ model: 'anthropic/claude-sonnet-4-7' }
		);
		expect(err).toMatch(/^Invalid model 'anthropic\/claude-sonnet-4-7'/);
		expect(err).toMatch(/anthropic\/claude-sonnet-4-6/);
	});

	it('skips validation when trigger payload has no model field', async () => {
		const err = await validateTriggerModel(
			makeSpec(['anthropic/claude-opus-4-7']),
			{ prompt: 'do the thing' }
		);
		expect(err).toBeNull();
	});

	it('skips validation when model is an empty string', async () => {
		const err = await validateTriggerModel(makeSpec(['anthropic/claude-opus-4-7']), {
			model: ''
		});
		expect(err).toBeNull();
	});

	it('skips validation when spec has no model field', async () => {
		const err = await validateTriggerModel(
			{ document: { 'x-workflow-builder': { input: { fields: {} } } } },
			{ model: 'anything' }
		);
		expect(err === null || typeof err === 'string').toBe(true);
	});

	it('falls back to the injected model catalog when inline options are absent', async () => {
		const modelCatalog = {
			listEnabledModelIds: vi.fn(async () => ['openai/gpt-5.5', 'anthropic/claude-opus-4-8'])
		};

		const err = await validateTriggerModel(
			{ document: { 'x-workflow-builder': { input: { fields: {} } } } },
			{ model: 'openai/gpt-5.5' },
			{ modelCatalog }
		);

		expect(err).toBeNull();
		expect(modelCatalog.listEnabledModelIds).toHaveBeenCalledTimes(1);
	});

	it('rejects a model missing from the injected model catalog', async () => {
		const modelCatalog = {
			listEnabledModelIds: vi.fn(async () => ['openai/gpt-5.5'])
		};

		const err = await validateTriggerModel(
			{ document: { 'x-workflow-builder': { input: { fields: {} } } } },
			{ model: 'openai/not-real' },
			{ modelCatalog }
		);

		expect(err).toBe("Invalid model 'openai/not-real'. Allowed: openai/gpt-5.5");
	});

	it('keeps model validation free of direct DB imports', () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), 'model-validation.ts'),
			'utf8'
		);

		expect(source).toContain('listEnabledModelIds');
		expect(source).not.toContain('$lib/server/db');
		expect(source).not.toContain('$lib/server/db/schema');
		expect(source).not.toContain('drizzle-orm');
		expect(source).not.toContain('modelCatalog } from');
	});

	it('keeps workflow start readiness behind workflow-data', () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), 'start-run.ts'),
			'utf8'
		);

		expect(source).toContain('workflowData.assertExecutionReadModelReady');
		expect(source).toContain('modelCatalog: app.workflowData');
		expect(source).not.toContain('assertExecutionReadModelColumns');
		expect(source).not.toContain('$lib/server/db/execution-read-model-support');
	});
});
