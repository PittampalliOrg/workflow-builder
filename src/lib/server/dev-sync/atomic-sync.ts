import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_PATTERN = /^(?!\.dev-sync(?:-|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const MAX_ROOTS = 128;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024;

export type AtomicDevSyncState = {
	generation: string | null;
	service: string | null;
	lastSyncAt: string | null;
	lastSyncBytes: number;
	contentSha256?: string | null;
};

export type AtomicDevSyncOptions = {
	root: string;
	archivePath: string;
	declaredRoots: readonly string[];
	nextState: AtomicDevSyncState;
	stateFile: string;
	persistState: (state: AtomicDevSyncState) => void;
	extractArchive?: (archivePath: string, stageRoot: string) => Promise<void>;
	beforeCommit?: (entries: readonly string[]) => void;
};

export class DevSyncTransactionError extends Error {
	constructor(
		message: string,
		readonly rollbackComplete: boolean,
		readonly phase: 'validation' | 'staging' | 'commit'
	) {
		super(message);
		this.name = 'DevSyncTransactionError';
	}
}

function normalizeRoot(value: unknown): string {
	if (typeof value !== 'string') throw new Error('sync roots must be strings');
	const root = value.trim().replace(/^\.\//, '').replace(/\/$/, '');
	if (
		!ROOT_PATTERN.test(root) ||
		root.split('/').some((segment) => segment === '.' || segment === '..')
	) {
		throw new Error(`invalid sync root: ${value}`);
	}
	return root;
}

function validateRootSet(values: unknown): string[] {
	if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ROOTS) {
		throw new Error(`sync roots must contain 1-${MAX_ROOTS} entries`);
	}
	const roots = [...new Set(values.map(normalizeRoot))].sort();
	if (roots.length !== values.length) throw new Error('sync roots must be unique');
	for (const [index, root] of roots.entries()) {
		if (roots.some((other, otherIndex) => otherIndex !== index && root.startsWith(`${other}/`))) {
			throw new Error(`sync roots must not overlap: ${root}`);
		}
	}
	return roots;
}

export function parseAllowedSyncRoots(raw: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('allowed sync roots must be a JSON array');
	}
	return validateRootSet(parsed);
}

export function parseDeclaredSyncRoots(raw: string, allowedRoots: readonly string[]): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('x-sync-roots must be a JSON array');
	}
	const declared = validateRootSet(parsed);
	const allowed = [...allowedRoots].sort();
	if (
		declared.length !== allowed.length ||
		declared.some((root, index) => root !== allowed[index])
	) {
		throw new Error('x-sync-roots must exactly match the receiver allowed roots');
	}
	return declared;
}

function runTar(args: string[], captureStdout = false): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('tar', args, {
			stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		let overflow = false;
		child.stdout?.on('data', (chunk) => {
			stdout += String(chunk);
			if (stdout.length > 16 * 1024 * 1024) {
				overflow = true;
				child.kill();
			}
		});
		child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0 && !overflow) resolve(stdout);
			else
				reject(
					new Error(
						stderr.slice(0, 500) || (overflow ? 'tar output too large' : `tar exit ${code}`)
					)
				);
		});
	});
}

function normalizeArchiveEntry(raw: string): string {
	let entry = raw;
	while (entry.startsWith('./')) entry = entry.slice(2);
	return entry;
}

function entryIsWithinRoot(entry: string, root: string): boolean {
	return entry === root || entry.startsWith(`${root}/`);
}

async function inspectArchive(
	archivePath: string,
	declaredRoots: readonly string[]
): Promise<string[]> {
	const [namesOutput, typesOutput] = await Promise.all([
		runTar(['-tzf', archivePath], true),
		runTar(['-tvzf', archivePath], true)
	]);
	const rawEntries = namesOutput.split('\n').filter(Boolean);
	const typeLines = typesOutput.split('\n').filter(Boolean);
	if (rawEntries.length > MAX_ARCHIVE_ENTRIES) throw new Error('archive has too many entries');
	if (typeLines.length !== rawEntries.length) throw new Error('archive listing mismatch');
	if (typeLines.some((line) => line[0] !== '-' && line[0] !== 'd')) {
		throw new Error('archive may contain only regular files and directories');
	}
	let totalBytes = 0;
	for (const line of typeLines) {
		const size = Number(line.trim().split(/\s+/)[2]);
		if (!Number.isSafeInteger(size) || size < 0) throw new Error('archive size listing is invalid');
		if (size > MAX_ARCHIVE_FILE_BYTES) throw new Error('archive member exceeds size limit');
		totalBytes += size;
		if (totalBytes > MAX_ARCHIVE_TOTAL_BYTES) throw new Error('archive expands beyond size limit');
	}
	const entries = rawEntries.map(normalizeArchiveEntry);
	for (const listedEntry of entries) {
		const entry = listedEntry.endsWith('/') ? listedEntry.slice(0, -1) : listedEntry;
		if (
			!entry ||
			entry.startsWith('/') ||
			entry.includes('\\') ||
			entry.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
			!declaredRoots.some((root) => entryIsWithinRoot(entry, root))
		) {
			throw new Error(`archive entry is outside declared roots: ${entry || '<empty>'}`);
		}
	}
	return entries;
}

async function defaultExtractArchive(archivePath: string, stageRoot: string): Promise<void> {
	await runTar(['-xzf', archivePath, '-C', stageRoot, '-o']);
}

function validateStagedTree(root: string): void {
	const pending = [root];
	while (pending.length) {
		const current = pending.pop()!;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const absolute = path.join(current, entry.name);
			const stat = fs.lstatSync(absolute);
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
				throw new Error(
					`staged archive contains unsupported entry: ${path.relative(root, absolute)}`
				);
			}
			if (stat.isDirectory()) pending.push(absolute);
		}
	}
}

function assertSafeLiveParents(root: string, relativeRoot: string): void {
	const segments = relativeRoot.split('/').slice(0, -1);
	let current = root;
	for (const segment of segments) {
		current = path.join(current, segment);
		if (!fs.existsSync(current)) continue;
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`sync root parent is not a directory: ${path.relative(root, current)}`);
		}
	}
}

function moveIfPresent(source: string, target: string): boolean {
	if (!fs.existsSync(source)) return false;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.renameSync(source, target);
	return true;
}

function removeIfPresent(target: string): void {
	fs.rmSync(target, { recursive: true, force: true });
}

function bestEffortRemove(target: string): void {
	try {
		removeIfPresent(target);
	} catch {
		/* preserve the committed result; a later request can reap stale transactions */
	}
}

function lstatIfPresent(target: string): fs.Stats | null {
	try {
		return fs.lstatSync(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

function filesHaveEqualContents(left: string, right: string, size: number): boolean {
	let leftFd: number | null = null;
	let rightFd: number | null = null;
	const leftBuffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
	const rightBuffer = Buffer.allocUnsafe(leftBuffer.length);
	let offset = 0;
	try {
		leftFd = fs.openSync(left, 'r');
		rightFd = fs.openSync(right, 'r');
		while (offset < size) {
			const length = Math.min(leftBuffer.length, size - offset);
			const leftBytes = fs.readSync(leftFd, leftBuffer, 0, length, offset);
			const rightBytes = fs.readSync(rightFd, rightBuffer, 0, length, offset);
			if (
				leftBytes === 0 ||
				rightBytes === 0 ||
				leftBytes !== rightBytes ||
				!leftBuffer.subarray(0, leftBytes).equals(rightBuffer.subarray(0, rightBytes))
			) {
				return false;
			}
			offset += leftBytes;
		}
		return true;
	} finally {
		if (leftFd !== null) fs.closeSync(leftFd);
		if (rightFd !== null) fs.closeSync(rightFd);
	}
}

function treesHaveEqualContents(left: string, right: string): boolean {
	const leftStat = lstatIfPresent(left);
	const rightStat = lstatIfPresent(right);
	if (!leftStat || !rightStat) return leftStat === rightStat;
	if ((leftStat.mode & 0o7777) !== (rightStat.mode & 0o7777)) return false;
	if (leftStat.isFile() && rightStat.isFile()) {
		return (
			leftStat.size === rightStat.size && filesHaveEqualContents(left, right, leftStat.size)
		);
	}
	if (!leftStat.isDirectory() || !rightStat.isDirectory()) return false;
	const leftEntries = fs.readdirSync(left).sort();
	const rightEntries = fs.readdirSync(right).sort();
	if (
		leftEntries.length !== rightEntries.length ||
		leftEntries.some((entry, index) => entry !== rightEntries[index])
	) {
		return false;
	}
	return leftEntries.every((entry) =>
		treesHaveEqualContents(path.join(left, entry), path.join(right, entry))
	);
}

function prepareTransactionBase(root: string, stateFile: string): string {
	const rootStat = fs.lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error('sync destination must be a real directory');
	}
	if (path.basename(stateFile) !== stateFile || stateFile !== '.dev-sync-state.json') {
		throw new Error('invalid sync state path');
	}
	const stateTarget = path.join(root, stateFile);
	if (lstatIfPresent(stateTarget)?.isSymbolicLink()) {
		throw new Error('sync state path must not be a symlink');
	}
	const transactionBase = path.join(root, '.dev-sync-transactions');
	const transactionStat = lstatIfPresent(transactionBase);
	if (transactionStat) {
		const stat = transactionStat;
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error('sync transaction path must be a real directory');
		}
	} else {
		fs.mkdirSync(transactionBase);
	}
	return transactionBase;
}

export async function applyAtomicDevSync(
	options: AtomicDevSyncOptions
): Promise<{ entries: string[]; changedRoots: string[] }> {
	const roots = validateRootSet([...options.declaredRoots]);
	let entries: string[];
	try {
		entries = await inspectArchive(options.archivePath, roots);
	} catch (error) {
		throw new DevSyncTransactionError(
			`archive validation failed: ${(error as Error).message}`,
			true,
			'validation'
		);
	}
	const transactionBase = prepareTransactionBase(options.root, options.stateFile);
	const transactionRoot = fs.mkdtempSync(path.join(transactionBase, 'txn-'));
	const stageRoot = path.join(transactionRoot, 'stage');
	const backupRoot = path.join(transactionRoot, 'backup');
	const stateTarget = path.join(options.root, options.stateFile);
	const stateBackup = path.join(transactionRoot, 'state-backup');
	fs.mkdirSync(stageRoot, { recursive: true });
	fs.mkdirSync(backupRoot, { recursive: true });

	try {
		await (options.extractArchive ?? defaultExtractArchive)(options.archivePath, stageRoot);
		validateStagedTree(stageRoot);
		options.beforeCommit?.(entries);
	} catch (error) {
		bestEffortRemove(transactionRoot);
		throw new DevSyncTransactionError(
			`archive staging failed: ${(error as Error).message}`,
			true,
			'staging'
		);
	}

	let changedRoots: string[];
	try {
		for (const root of roots) assertSafeLiveParents(options.root, root);
		changedRoots = roots.filter(
			(root) =>
				!treesHaveEqualContents(path.join(options.root, root), path.join(stageRoot, root))
		);
	} catch (error) {
		bestEffortRemove(transactionRoot);
		throw new DevSyncTransactionError(
			`live root comparison failed: ${(error as Error).message}`,
			true,
			'staging'
		);
	}
	let stateBackedUp = false;
	let rollbackComplete = true;
	const committedRoots: Array<{ root: string; liveBackedUp: boolean }> = [];
	try {
		stateBackedUp = moveIfPresent(stateTarget, stateBackup);
		for (const root of changedRoots) {
			const live = path.join(options.root, root);
			const backup = path.join(backupRoot, root);
			const staged = path.join(stageRoot, root);
			const liveBackedUp = moveIfPresent(live, backup);
			committedRoots.push({ root, liveBackedUp });
			moveIfPresent(staged, live);
		}
		options.persistState(options.nextState);
	} catch (error) {
		for (const { root, liveBackedUp } of [...committedRoots].reverse()) {
			const live = path.join(options.root, root);
			const backup = path.join(backupRoot, root);
			try {
				removeIfPresent(live);
				if (liveBackedUp) moveIfPresent(backup, live);
			} catch {
				rollbackComplete = false;
			}
		}
		try {
			removeIfPresent(stateTarget);
			if (stateBackedUp) moveIfPresent(stateBackup, stateTarget);
		} catch {
			rollbackComplete = false;
			try {
				removeIfPresent(stateTarget);
			} catch {
				/* best effort: never deliberately restore a stale generation marker */
			}
		}
		if (rollbackComplete) removeIfPresent(transactionRoot);
		throw new DevSyncTransactionError(
			`atomic sync commit failed: ${(error as Error).message}${rollbackComplete ? '' : '; rollback incomplete and generation state withheld'}`,
			rollbackComplete,
			'commit'
		);
	}

	bestEffortRemove(transactionRoot);
	try {
		fs.rmdirSync(transactionBase);
	} catch {
		/* another transaction or recovery artifact still exists */
	}
	return { entries, changedRoots };
}
