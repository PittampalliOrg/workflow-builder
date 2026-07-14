import { describe, expect, it } from 'vitest';
import {
	collectRequiredTriggerFields,
	getMissingRequiredTriggerFields
} from '$lib/utils/trigger-fields';

describe('workflow trigger fields', () => {
	it('uses JSON Schema required fields instead of inferring every expression reference', () => {
		const spec = {
			input: {
				schema: {
					document: {
						type: 'object',
						properties: {
							intent: { type: 'string' },
							previewOrigin: { type: 'string' }
						},
						required: ['intent']
					}
				}
			},
			do: [{ step: { with: { origin: '${ .trigger.previewOrigin // "" }' } } }]
		};

		expect(collectRequiredTriggerFields(spec)).toEqual(['intent']);
		expect(getMissingRequiredTriggerFields(spec, { previewOrigin: '' })).toEqual(['intent']);
	});

	it('treats properties as optional when JSON Schema omits required', () => {
		const spec = {
			input: {
				schema: {
					document: {
						type: 'object',
						properties: { previewOrigin: { type: 'string' } }
					}
				}
			},
			do: [{ step: { with: { origin: '${ .trigger.previewOrigin // "" }' } } }]
		};

		expect(collectRequiredTriggerFields(spec)).toEqual([]);
	});

	it('retains expression inference for workflows without an input schema', () => {
		const spec = {
			do: [
				{
					step: {
						with: {
							prompt: '${ .trigger.prompt }',
							repository: '{{ trigger.repository }}'
						}
					}
				}
			]
		};

		expect(collectRequiredTriggerFields(spec)).toEqual(['prompt', 'repository']);
	});
});
