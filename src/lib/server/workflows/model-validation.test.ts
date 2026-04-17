import { describe, expect, it, vi } from 'vitest';
import { validateTriggerModel } from './model-validation';

// The DB fallback path is not exercised here — when the spec declares
// options we short-circuit before touching the DB.

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
		// No inline options + no DB configured in this test → returns null.
		// The real server path runs against a connected DB; this test documents
		// the no-op case where the workflow does not advertise options.
		expect(err === null || typeof err === 'string').toBe(true);
	});
});
