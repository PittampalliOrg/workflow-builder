import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	applyAtomicDevSync,
	parseAllowedSyncRoots,
	parseDeclaredSyncRoots,
	type AtomicDevSyncState
} from './atomic-sync';

const cleanupPaths: string[] = [];

afterEach(() => {
	for (const target of cleanupPaths.splice(0)) {
		fs.rmSync(target, { recursive: true, force: true });
	}
});

function temporaryDirectory(prefix: string): string {
	const result = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanupPaths.push(result);
	return result;
}

function archive(
	files: Record<string, string>,
	directoryModes: Record<string, number> = {},
	archiveRoots?: string[]
): string {
	const source = temporaryDirectory('atomic-sync-source-');
	for (const [relative, contents] of Object.entries(files)) {
		const target = path.join(source, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, contents);
	}
	const output = path.join(temporaryDirectory('atomic-sync-archive-'), 'source.tgz');
	const roots = archiveRoots ?? [...new Set(Object.keys(files).map((entry) => entry.split('/')[0]))];
	const modeEntries = Object.entries(directoryModes).sort(
		([left], [right]) => right.split('/').length - left.split('/').length
	);
	for (const [relative, mode] of modeEntries) fs.chmodSync(path.join(source, relative), mode);
	try {
		const args = roots.length
			? ['-czf', output, '-C', source, ...roots]
			: ['-czf', output, '-C', source, '-T', '/dev/null'];
		const result = spawnSync('tar', args);
		expect(result.status, result.stderr.toString()).toBe(0);
	} finally {
		for (const [relative] of [...modeEntries].reverse()) {
			fs.chmodSync(path.join(source, relative), 0o755);
		}
	}
	return output;
}

function state(generation: string): AtomicDevSyncState {
	return {
		generation,
		service: 'workflow-builder',
		lastSyncAt: '2026-07-10T00:00:00.000Z',
		lastSyncBytes: 1,
		contentSha256: `sha256:${'1'.repeat(64)}`
	};
}

describe('dev sync root contract', () => {
	it('requires an exact, non-overlapping receiver-owned set', () => {
		const allowed = parseAllowedSyncRoots('["config","src"]');
		expect(parseDeclaredSyncRoots('["src","config"]', allowed)).toEqual(['config', 'src']);
		expect(() => parseDeclaredSyncRoots('["src"]', allowed)).toThrow('exactly match');
		expect(() => parseAllowedSyncRoots('["src","src/routes"]')).toThrow('must not overlap');
		expect(() => parseAllowedSyncRoots('["../src"]')).toThrow('invalid sync root');
		expect(() => parseAllowedSyncRoots('[".dev-sync-state.json"]')).toThrow('invalid sync root');
	});
});

describe('applyAtomicDevSync', () => {
	it('changes one file without replacing its root or unchanged siblings', async () => {
		const root = temporaryDirectory('atomic-sync-root-');
		fs.mkdirSync(path.join(root, 'src'));
		fs.writeFileSync(path.join(root, 'src/current.txt'), 'old');
		fs.writeFileSync(path.join(root, 'src/unchanged.txt'), 'same');
		fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"extends":"./base"}');
		const sourceInode = fs.statSync(path.join(root, 'src')).ino;
		const currentInode = fs.statSync(path.join(root, 'src/current.txt')).ino;
		const unchangedInode = fs.statSync(path.join(root, 'src/unchanged.txt')).ino;
		const configInode = fs.statSync(path.join(root, 'tsconfig.json')).ino;
		let persisted: AtomicDevSyncState | null = null;

		const result = await applyAtomicDevSync({
			root,
			archivePath: archive({
				'src/current.txt': 'new',
				'src/unchanged.txt': 'same',
				'tsconfig.json': '{"extends":"./base"}'
			}),
			declaredRoots: ['src', 'tsconfig.json'],
			nextState: state('generation-2'),
			stateFile: '.dev-sync-state.json',
			persistState: (nextState) => {
				persisted = nextState;
			}
		});

		expect(result.changedRoots).toEqual(['src']);
		expect(result.changedPaths).toEqual(['src/current.txt']);
		expect(fs.readFileSync(path.join(root, 'src/current.txt'), 'utf8')).toBe('new');
		expect(fs.statSync(path.join(root, 'src')).ino).toBe(sourceInode);
		expect(fs.statSync(path.join(root, 'src/current.txt')).ino).not.toBe(currentInode);
		expect(fs.statSync(path.join(root, 'src/unchanged.txt')).ino).toBe(unchangedInode);
		expect(fs.statSync(path.join(root, 'tsconfig.json')).ino).toBe(configInode);
		expect(persisted).toEqual(state('generation-2'));
	});

	it('advances generation state when every declared root is byte-identical', async () => {
		const root = temporaryDirectory('atomic-sync-root-');
		fs.mkdirSync(path.join(root, 'src'));
		fs.writeFileSync(path.join(root, 'src/current.txt'), 'same');
		const sourceInode = fs.statSync(path.join(root, 'src')).ino;
		let persisted: AtomicDevSyncState | null = null;

		const result = await applyAtomicDevSync({
			root,
			archivePath: archive({ 'src/current.txt': 'same' }),
			declaredRoots: ['src'],
			nextState: state('generation-2'),
			stateFile: '.dev-sync-state.json',
			persistState: (nextState) => {
				persisted = nextState;
			}
		});

		expect(result.changedRoots).toEqual([]);
		expect(result.changedPaths).toEqual([]);
		expect(fs.statSync(path.join(root, 'src')).ino).toBe(sourceInode);
		expect(persisted).toEqual(state('generation-2'));
	});

	it('reconciles mixed add, replace, and delete operations without replacing parents', async () => {
		const root = temporaryDirectory('atomic-sync-root-');
		fs.mkdirSync(path.join(root, 'src/nested'), { recursive: true });
		fs.writeFileSync(path.join(root, 'src/deleted.txt'), 'delete');
		fs.writeFileSync(path.join(root, 'src/nested/changed.txt'), 'old');
		fs.writeFileSync(path.join(root, 'src/nested/stable.txt'), 'same');
		const sourceInode = fs.statSync(path.join(root, 'src')).ino;
		const nestedInode = fs.statSync(path.join(root, 'src/nested')).ino;
		const stableInode = fs.statSync(path.join(root, 'src/nested/stable.txt')).ino;

		const result = await applyAtomicDevSync({
			root,
			archivePath: archive({
				'src/added.txt': 'add',
				'src/nested/changed.txt': 'new',
				'src/nested/stable.txt': 'same'
			}),
			declaredRoots: ['src'],
			nextState: state('generation-2'),
			stateFile: '.dev-sync-state.json',
			persistState: () => undefined
		});

		expect(result.changedPaths).toEqual([
			'src/added.txt',
			'src/deleted.txt',
			'src/nested/changed.txt'
		]);
		expect(fs.readFileSync(path.join(root, 'src/added.txt'), 'utf8')).toBe('add');
		expect(fs.existsSync(path.join(root, 'src/deleted.txt'))).toBe(false);
		expect(fs.readFileSync(path.join(root, 'src/nested/changed.txt'), 'utf8')).toBe('new');
		expect(fs.statSync(path.join(root, 'src')).ino).toBe(sourceInode);
		expect(fs.statSync(path.join(root, 'src/nested')).ino).toBe(nestedInode);
		expect(fs.statSync(path.join(root, 'src/nested/stable.txt')).ino).toBe(stableInode);
	});

	it('temporarily widens a read-only source root and applies its staged mode parent-last', async () => {
		const root = temporaryDirectory('atomic-sync-root-');
		fs.mkdirSync(path.join(root, 'src'));
		fs.writeFileSync(path.join(root, 'src/current.txt'), 'old');
		fs.writeFileSync(path.join(root, 'src/stable.txt'), 'same');
		const sourceInode = fs.statSync(path.join(root, 'src')).ino;
		const stableInode = fs.statSync(path.join(root, 'src/stable.txt')).ino;
		fs.chmodSync(path.join(root, 'src'), 0o555);

		const result = await applyAtomicDevSync({
			root,
			archivePath: archive({ 'src/current.txt': 'new', 'src/stable.txt': 'same' }),
			declaredRoots: ['src'],
			nextState: state('generation-2'),
			stateFile: '.dev-sync-state.json',
			persistState: () => undefined
		});

		expect(result.changedPaths).toEqual(['src', 'src/current.txt']);
		expect(fs.readFileSync(path.join(root, 'src/current.txt'), 'utf8')).toBe('new');
		expect(fs.statSync(path.join(root, 'src')).ino).toBe(sourceInode);
		expect(fs.statSync(path.join(root, 'src/stable.txt')).ino).toBe(stableInode);
		expect(fs.statSync(path.join(root, 'src')).mode & 0o7777).toBe(0o755);
	});

	it('restores a matching read-only directory mode after changing a child file', async () => {
		const root = temporaryDirectory('atomic-sync-root-');
		fs.mkdirSync(path.join(root, 'src'));
		fs.writeFileSync(path.join(root, 'src/current.txt'), 'old');
		const sourceInode = fs.statSync(path.join(root, 'src')).ino;
		fs.chmodSync(path.join(root, 'src'), 0o555);

		try {
			const result = await applyAtomicDevSync({
				root,
				archivePath: archive({ 'src/current.txt': 'new' }, { src: 0o555 }),
				declaredRoots: ['src'],
				nextState: state('generation-2'),
				stateFile: '.dev-sync-state.json',
				persistState: () => undefined
			});

			expect(result.changedPaths).toEqual(['src/current.txt']);
			expect(fs.readFileSync(path.join(root, 'src/current.txt'), 'utf8')).toBe('new');
			expect(fs.statSync(path.join(root, 'src')).ino).toBe(sourceInode);
			expect(fs.statSync(path.join(root, 'src')).mode & 0o7777).toBe(0o555);
		} finally {
			fs.chmodSync(path.join(root, 'src'), 0o755);
		}
	});

	it('rejects a symlinked transaction base before touching live roots', async () => {
		const root = temporaryDirectory('atomic-sync-root-');
		fs.mkdirSync(path.join(root, 'src'));
		fs.writeFileSync(path.join(root, 'src/current.txt'), 'old');
		fs.symlinkSync(os.tmpdir(), path.join(root, '.dev-sync-transactions'));
		await expect(
			applyAtomicDevSync({
				root,
				archivePath: archive({ 'src/current.txt': 'new' }),
				declaredRoots: ['src'],
				nextState: state('generation-2'),
				stateFile: '.dev-sync-state.json',
				persistState: () => undefined
			})
		).rejects.toThrow('transaction path must be a real directory');
		expect(fs.readFileSync(path.join(root, 'src/current.txt'), 'utf8')).toBe('old');
	});

	it('removes newly created nested-root parents and restores generation state on rollback', async () => {
		const root = temporaryDirectory('atomic-sync-root-');
		const prior = JSON.stringify(state('generation-1'));
		fs.writeFileSync(path.join(root, '.dev-sync-state.json'), prior);

		await expect(
			applyAtomicDevSync({
				root,
				archivePath: archive({ 'config/foo/app.json': 'new' }, {}, ['config/foo']),
				declaredRoots: ['config/foo'],
				nextState: state('generation-2'),
				stateFile: '.dev-sync-state.json',
				persistState: () => {
					throw new Error('state device full');
				}
			})
		).rejects.toMatchObject({ phase: 'commit', rollbackComplete: true });

		expect(fs.existsSync(path.join(root, 'config'))).toBe(false);
		expect(fs.readFileSync(path.join(root, '.dev-sync-state.json'), 'utf8')).toBe(prior);
	});

	it('deletes a nested declared root when the snapshot omits it', async () => {
		const root = temporaryDirectory('atomic-sync-root-');
		fs.mkdirSync(path.join(root, 'config/foo'), { recursive: true });
		fs.writeFileSync(path.join(root, 'config/foo/app.json'), 'old');

		const result = await applyAtomicDevSync({
			root,
			archivePath: archive({}),
			declaredRoots: ['config/foo'],
			nextState: state('generation-2'),
			stateFile: '.dev-sync-state.json',
			persistState: () => undefined
		});

		expect(result.changedPaths).toEqual(['config/foo']);
		expect(fs.existsSync(path.join(root, 'config/foo'))).toBe(false);
		expect(fs.existsSync(path.join(root, 'config'))).toBe(true);
	});

	it('does not expose a partially extracted tree when staging fails mid-extract', async () => {
		const root = temporaryDirectory('atomic-sync-root-');
		fs.mkdirSync(path.join(root, 'src'));
		fs.writeFileSync(path.join(root, 'src/current.txt'), 'old');
		const prior = JSON.stringify(state('generation-1'));
		fs.writeFileSync(path.join(root, '.dev-sync-state.json'), prior);

		await expect(
			applyAtomicDevSync({
				root,
				archivePath: archive({ 'src/current.txt': 'new' }),
				declaredRoots: ['src'],
				nextState: state('generation-2'),
				stateFile: '.dev-sync-state.json',
				persistState: () => {
					throw new Error('must not persist');
				},
				extractArchive: async (_archivePath, stageRoot) => {
					fs.mkdirSync(path.join(stageRoot, 'src'));
					fs.writeFileSync(path.join(stageRoot, 'src/current.txt'), 'partial');
					throw new Error('mid-extract failure');
				}
			})
		).rejects.toMatchObject({
			phase: 'staging',
			rollbackComplete: true
		});
		expect(fs.readFileSync(path.join(root, 'src/current.txt'), 'utf8')).toBe('old');
		expect(fs.readFileSync(path.join(root, '.dev-sync-state.json'), 'utf8')).toBe(prior);
	});

	it('restores every root and the prior generation when state commit fails', async () => {
		const root = temporaryDirectory('atomic-sync-root-');
		fs.mkdirSync(path.join(root, 'src'));
		fs.mkdirSync(path.join(root, 'config'));
		fs.writeFileSync(path.join(root, 'src/current.txt'), 'old');
		fs.writeFileSync(path.join(root, 'config/app.json'), 'old-config');
		const prior = JSON.stringify(state('generation-1'));
		fs.writeFileSync(path.join(root, '.dev-sync-state.json'), prior);

		await expect(
			applyAtomicDevSync({
				root,
				archivePath: archive({ 'src/current.txt': 'new' }),
				declaredRoots: ['config', 'src'],
				nextState: state('generation-2'),
				stateFile: '.dev-sync-state.json',
				persistState: () => {
					throw new Error('state device full');
				}
			})
		).rejects.toMatchObject({
			phase: 'commit',
			rollbackComplete: true
		});
		expect(fs.readFileSync(path.join(root, 'src/current.txt'), 'utf8')).toBe('old');
		expect(fs.readFileSync(path.join(root, 'config/app.json'), 'utf8')).toBe('old-config');
		expect(fs.readFileSync(path.join(root, '.dev-sync-state.json'), 'utf8')).toBe(prior);
	});

	it('does not remove an unchanged root when a changed-root commit rolls back', async () => {
		const root = temporaryDirectory('atomic-sync-root-');
		fs.mkdirSync(path.join(root, 'src'));
		fs.writeFileSync(path.join(root, 'src/current.txt'), 'old');
		fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
		const configInode = fs.statSync(path.join(root, 'tsconfig.json')).ino;

		await expect(
			applyAtomicDevSync({
				root,
				archivePath: archive({ 'src/current.txt': 'new', 'tsconfig.json': '{}' }),
				declaredRoots: ['src', 'tsconfig.json'],
				nextState: state('generation-2'),
				stateFile: '.dev-sync-state.json',
				persistState: () => {
					throw new Error('state device full');
				}
			})
		).rejects.toMatchObject({ phase: 'commit', rollbackComplete: true });
		expect(fs.readFileSync(path.join(root, 'src/current.txt'), 'utf8')).toBe('old');
		expect(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')).toBe('{}');
		expect(fs.statSync(path.join(root, 'tsconfig.json')).ino).toBe(configInode);
	});

	it('rolls back mixed add, replace, and delete operations when state persistence fails', async () => {
		const root = temporaryDirectory('atomic-sync-root-');
		fs.mkdirSync(path.join(root, 'src/nested'), { recursive: true });
		fs.writeFileSync(path.join(root, 'src/deleted.txt'), 'keep-after-rollback');
		fs.writeFileSync(path.join(root, 'src/nested/changed.txt'), 'old');
		fs.writeFileSync(path.join(root, 'src/nested/stable.txt'), 'same');
		const sourceInode = fs.statSync(path.join(root, 'src')).ino;
		const nestedInode = fs.statSync(path.join(root, 'src/nested')).ino;
		const stableInode = fs.statSync(path.join(root, 'src/nested/stable.txt')).ino;

		await expect(
			applyAtomicDevSync({
				root,
				archivePath: archive({
					'src/added.txt': 'add',
					'src/nested/changed.txt': 'new',
					'src/nested/stable.txt': 'same'
				}),
				declaredRoots: ['src'],
				nextState: state('generation-2'),
				stateFile: '.dev-sync-state.json',
				persistState: () => {
					throw new Error('state device full');
				}
			})
		).rejects.toMatchObject({ phase: 'commit', rollbackComplete: true });

		expect(fs.existsSync(path.join(root, 'src/added.txt'))).toBe(false);
		expect(fs.readFileSync(path.join(root, 'src/deleted.txt'), 'utf8')).toBe(
			'keep-after-rollback'
		);
		expect(fs.readFileSync(path.join(root, 'src/nested/changed.txt'), 'utf8')).toBe('old');
		expect(fs.statSync(path.join(root, 'src')).ino).toBe(sourceInode);
		expect(fs.statSync(path.join(root, 'src/nested')).ino).toBe(nestedInode);
		expect(fs.statSync(path.join(root, 'src/nested/stable.txt')).ino).toBe(stableInode);
	});

	it('restores read-only directory contents and mode when state persistence fails', async () => {
		const root = temporaryDirectory('atomic-sync-root-');
		fs.mkdirSync(path.join(root, 'src'));
		fs.writeFileSync(path.join(root, 'src/current.txt'), 'old');
		const sourceInode = fs.statSync(path.join(root, 'src')).ino;
		fs.chmodSync(path.join(root, 'src'), 0o555);

		try {
			await expect(
				applyAtomicDevSync({
					root,
					archivePath: archive({ 'src/current.txt': 'new' }),
					declaredRoots: ['src'],
					nextState: state('generation-2'),
					stateFile: '.dev-sync-state.json',
					persistState: () => {
						throw new Error('state device full');
					}
				})
			).rejects.toMatchObject({ phase: 'commit', rollbackComplete: true });

			expect(fs.readFileSync(path.join(root, 'src/current.txt'), 'utf8')).toBe('old');
			expect(fs.statSync(path.join(root, 'src')).ino).toBe(sourceInode);
			expect(fs.statSync(path.join(root, 'src')).mode & 0o7777).toBe(0o555);
		} finally {
			fs.chmodSync(path.join(root, 'src'), 0o755);
		}
	});
	});
