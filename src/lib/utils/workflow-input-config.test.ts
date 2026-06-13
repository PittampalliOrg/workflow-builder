import { describe, expect, it } from 'vitest';
import {
	applyWorkflowInputDefaults,
	getWorkflowInputFieldConfigs
} from './workflow-input-config';

describe('workflow input config', () => {
	it('keeps explicit x-workflow-builder select options', () => {
		const spec = {
			document: {
				'x-workflow-builder': {
					input: {
						fields: {
							cliRuntime: {
								type: 'select',
								label: 'CLI agent',
								defaultValue: 'codex-cli',
								options: [
									{ label: 'Codex CLI', value: 'codex-cli' },
									{ label: 'Claude Code CLI', value: 'claude-code-cli' }
								]
							}
						}
					}
				}
			},
			input: {
				schema: {
					document: {
						type: 'object',
						properties: {
							cliRuntime: {
								type: 'string',
								title: 'Runtime',
								enum: ['codex-cli', 'claude-code-cli'],
								default: 'claude-code-cli'
							}
						}
					}
				}
			}
		};

		expect(getWorkflowInputFieldConfigs(spec).cliRuntime).toEqual({
			type: 'select',
			label: 'CLI agent',
			description: undefined,
			defaultValue: 'codex-cli',
			options: [
				{ label: 'Codex CLI', value: 'codex-cli' },
				{ label: 'Claude Code CLI', value: 'claude-code-cli' }
			]
		});
	});

	it('synthesizes select config and defaults from JSON Schema enum fields', () => {
		const spec = {
			document: {},
			input: {
				schema: {
					document: {
						type: 'object',
						properties: {
							cliRuntime: {
								type: 'string',
								title: 'CLI agent',
								description: 'Choose a CLI runtime.',
								enum: ['codex-cli', 'claude-code-cli', 'agy-cli'],
								default: 'codex-cli'
							}
						}
					}
				}
			}
		};

		expect(getWorkflowInputFieldConfigs(spec).cliRuntime).toEqual({
			type: 'select',
			label: 'CLI agent',
			description: 'Choose a CLI runtime.',
			defaultValue: 'codex-cli',
			options: [
				{ label: 'codex-cli', value: 'codex-cli' },
				{ label: 'claude-code-cli', value: 'claude-code-cli' },
				{ label: 'agy-cli', value: 'agy-cli' }
			]
		});
		expect(applyWorkflowInputDefaults(spec, {})).toEqual({
			cliRuntime: 'codex-cli'
		});
	});
});
