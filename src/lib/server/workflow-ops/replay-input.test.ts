import { describe, expect, it } from 'vitest';
import { buildCodeCheckpointReplayInput } from './replay-input';

describe('buildCodeCheckpointReplayInput', () => {
	it('injects checkpoint restore into top-level input and message metadata', () => {
		const restore = {
			checkpointId: 'cp_1',
			afterSha: 'abc123',
			remoteUrl: 'http://gitea/checkpoints.git',
			remoteRef: 'refs/workflow-builder/checkpoints/run/tool'
		};

		const input = buildCodeCheckpointReplayInput(
			{
				task: 'continue',
				_message_metadata: { cwd: '/sandbox/repo' }
			},
			restore
		);

		expect(input.codeCheckpointRestore).toEqual(restore);
		expect(input._message_metadata).toMatchObject({
			cwd: '/sandbox/repo',
			codeCheckpointRestore: restore
		});
	});

	it('injects fresh sandbox name into both sandbox routing and restore directive before replay', () => {
		const input = buildCodeCheckpointReplayInput(
			{
				task: 'continue',
				node: {
					config: {
						body: {},
						input: {},
						metadata: {}
					}
				}
			},
			{
				checkpointId: 'cp_2',
				afterSha: 'def456',
				remoteUrl: 'http://gitea/checkpoints.git',
				remoteRef: 'refs/workflow-builder/checkpoints/run/tool'
			},
			'agent-replay-cp-2'
		);

		expect(input.sandboxName).toBe('agent-replay-cp-2');
		expect(input._message_metadata).toMatchObject({
			sandboxName: 'agent-replay-cp-2',
			codeCheckpointRestore: expect.objectContaining({
				checkpointId: 'cp_2',
				sandboxName: 'agent-replay-cp-2'
			})
		});
		expect(input.codeCheckpointRestore).toMatchObject({
			checkpointId: 'cp_2',
			sandboxName: 'agent-replay-cp-2'
		});
		expect((input.node as Record<string, Record<string, unknown>>).config).toMatchObject({
			codeCheckpointRestore: expect.objectContaining({
				checkpointId: 'cp_2',
				sandboxName: 'agent-replay-cp-2'
			}),
			body: {
				codeCheckpointRestore: expect.objectContaining({
					sandboxName: 'agent-replay-cp-2'
				})
			},
			input: {
				codeCheckpointRestore: expect.objectContaining({
					sandboxName: 'agent-replay-cp-2'
				})
			}
		});
	});
});
