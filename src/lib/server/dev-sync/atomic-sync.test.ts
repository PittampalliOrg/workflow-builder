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

function archive(files: Record<string, string>): string {
	const source = temporaryDirectory('atomic-sync-source-');
	for (const [relative, contents] of Object.entries(files)) {
		const target = path.join(source, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, contents);
	}
	const output = path.join(temporaryDirectory('atomic-sync-archive-'), 'source.tgz');
	const roots = [...new Set(Object.keys(files).map((entry) => entry.split('/')[0]))];
	const result = spawnSync('tar', ['-czf', output, '-C', source, ...roots]);
	expect(result.status, result.stderr.toString()).toBe(0);
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
	it('preserves byte-identical roots while committing changed roots and generation state', async () => {
		const root = temporaryDirectory('atomic-sync-root-');
		fs.mkdirSync(path.join(root, 'src'));
		fs.writeFileSync(path.join(root, 'src/current.txt'), 'old');
		fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"extends":"./base"}');
		const configInode = fs.statSync(path.join(root, 'tsconfig.json')).ino;
		let persisted: AtomicDevSyncState | null = null;

		const result = await applyAtomicDevSync({
			root,
			archivePath: archive({
				'src/current.txt': 'new',
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
		expect(fs.readFileSync(path.join(root, 'src/current.txt'), 'utf8')).toBe('new');
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
		expect(fs.statSync(path.join(root, 'src')).ino).toBe(sourceInode);
		expect(persisted).toEqual(state('generation-2'));
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
});
