import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_PATTERN = /^(?!\.dev-sync(?:-|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const MAX_ROOTS = 128;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024;

export class DevSyncTransactionError extends Error {
	constructor(message, rollbackComplete, phase) {
		super(message);
		this.name = 'DevSyncTransactionError';
		this.rollbackComplete = rollbackComplete;
		this.phase = phase;
	}
}

function normalizeRoot(value) {
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

function validateRootSet(values) {
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

export function parseAllowedSyncRoots(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('allowed sync roots must be a JSON array');
	}
	return validateRootSet(parsed);
}

export function parseDeclaredSyncRoots(raw, allowedRoots) {
	let parsed;
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

function runTar(args, captureStdout = false) {
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
		child.stderr.on('data', (chunk) => (stderr += String(chunk)));
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

function normalizeArchiveEntry(raw) {
	let entry = raw;
	while (entry.startsWith('./')) entry = entry.slice(2);
	return entry;
}

function entryIsWithinRoot(entry, root) {
	return entry === root || entry.startsWith(`${root}/`);
}

async function inspectArchive(archivePath, declaredRoots) {
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

async function defaultExtractArchive(archivePath, stageRoot) {
	await runTar(['-xzf', archivePath, '-C', stageRoot, '-o']);
}

function validateStagedTree(root) {
	const pending = [root];
	while (pending.length) {
		const current = pending.pop();
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

function assertSafeLiveParents(root, relativeRoot) {
	const segments = relativeRoot.split('/').slice(0, -1);
	let current = root;
	for (const segment of segments) {
		current = path.join(current, segment);
		const stat = lstatIfPresent(current);
		if (!stat) continue;
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`sync root parent is not a directory: ${path.relative(root, current)}`);
		}
	}
}

function moveIfPresent(source, target) {
	if (!lstatIfPresent(source)) return false;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.renameSync(source, target);
	return true;
}

function backUpForMutation(source, target, operation) {
	if (operation !== 'replace-file') return moveIfPresent(source, target);
	const stat = lstatIfPresent(source);
	if (!stat?.isFile()) throw new Error(`live file disappeared before commit: ${source}`);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	// A hard link changes the watched file's link count and can emit a false
	// change event before the staged content is renamed into place. Reflink when
	// supported, otherwise copy only the changed file into the private backup.
	fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
	fs.chmodSync(target, stat.mode & 0o7777);
	return true;
}

function removeIfPresent(target) {
	fs.rmSync(target, { recursive: true, force: true });
}

function makeTreeOwnerWritable(target) {
	const stat = lstatIfPresent(target);
	if (!stat || stat.isSymbolicLink()) return;
	if (stat.isDirectory()) {
		fs.chmodSync(target, (stat.mode & 0o7777) | 0o700);
		for (const entry of fs.readdirSync(target)) makeTreeOwnerWritable(path.join(target, entry));
	}
}

function bestEffortRemove(target) {
	try {
		makeTreeOwnerWritable(target);
		removeIfPresent(target);
	} catch {
		// Preserve the committed result; a later request can reap stale transactions.
	}
}

function lstatIfPresent(target) {
	try {
		return fs.lstatSync(target);
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}

function filesHaveEqualContents(left, right, size) {
	let leftFd = null;
	let rightFd = null;
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

function buildReconciliationPlan(live, staged, relativePath, plan, options = {}) {
	const liveStat = lstatIfPresent(live);
	const stagedStat = lstatIfPresent(staged);
	if (!liveStat && !stagedStat) return;
	if (!liveStat) {
		plan.push({ operation: 'add', relativePath });
		return;
	}
	if (!stagedStat) {
		if (!options.pruneMissing) return;
		plan.push({ operation: 'delete', relativePath });
		return;
	}

	if (liveStat.isFile() && stagedStat.isFile()) {
		if (
			(liveStat.mode & 0o7777) !== (stagedStat.mode & 0o7777) ||
			liveStat.size !== stagedStat.size ||
			!filesHaveEqualContents(live, staged, liveStat.size)
		) {
			plan.push({ operation: 'replace-file', relativePath });
		}
		return;
	}

	if (!liveStat.isDirectory() || !stagedStat.isDirectory()) {
		plan.push({ operation: 'replace', relativePath });
		return;
	}

	// Keep matching directories in place so their watcher descriptors and the
	// inodes of unchanged descendants survive a one-file sync. Only changed
	// leaves and wholly added/removed subtrees are renamed during commit.
	const liveMode = liveStat.mode & 0o7777;
	const stagedMode = stagedStat.mode & 0o7777;
	if (liveMode !== stagedMode) {
		plan.push({ operation: 'chmod', relativePath, liveMode, stagedMode });
	}
	const entries = [...new Set([...fs.readdirSync(live), ...fs.readdirSync(staged)])].sort();
	for (const entry of entries) {
		buildReconciliationPlan(
			path.join(live, entry),
			path.join(staged, entry),
			`${relativePath}/${entry}`,
			plan,
			options
		);
	}
}

function reconciliationPlan(root, stageRoot, roots, options = {}) {
	const plan = [];
	const changedRoots = [];
	for (const relativeRoot of roots) {
		const before = plan.length;
		buildReconciliationPlan(
			path.join(root, relativeRoot),
			path.join(stageRoot, relativeRoot),
			relativeRoot,
			plan,
			options
		);
		if (plan.length !== before) changedRoots.push(relativeRoot);
	}
	return { plan, changedRoots };
}

function pathDepth(relativePath) {
	return relativePath.split('/').length;
}

function directoryModeTransitions(root, plan) {
	const finalModes = new Map(
		plan
			.filter(({ operation }) => operation === 'chmod')
			.map((mutation) => [mutation.relativePath, mutation.stagedMode])
	);
	const structuralParents = new Set();
	for (const mutation of plan) {
		if (mutation.operation === 'chmod') continue;
		const segments = mutation.relativePath.split('/');
		for (let index = 1; index < segments.length; index += 1) {
			structuralParents.add(segments.slice(0, index).join('/'));
		}
	}

	const paths = new Set([...structuralParents, ...finalModes.keys()]);
	return [...paths]
		.sort((left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right))
		.flatMap((relativePath) => {
			const stat = lstatIfPresent(path.join(root, relativePath));
			// A missing ancestor is valid for a newly added nested root; the move
			// creates it. Existing ancestors must remain real directories.
			if (!stat) return [];
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				throw new Error(`live directory disappeared before commit: ${relativePath}`);
			}
			const liveMode = stat.mode & 0o7777;
			return [{
				relativePath,
				liveMode,
				finalMode: finalModes.get(relativePath) ?? liveMode
			}];
		});
}

function ensureLiveParentDirectories(root, target) {
	const relativeParent = path.relative(root, path.dirname(target));
	if (!relativeParent || relativeParent === '.') return [];
	const created = [];
	let current = root;
	for (const segment of relativeParent.split(path.sep)) {
		current = path.join(current, segment);
		const stat = lstatIfPresent(current);
		if (stat) {
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				throw new Error(`live path parent is not a directory: ${path.relative(root, current)}`);
			}
			continue;
		}
		fs.mkdirSync(current);
		created.push(path.relative(root, current));
	}
	return created;
}

function makeStagedStructuralParentsWritable(stageRoot, plan) {
	const parents = new Set();
	for (const mutation of plan) {
		if (mutation.operation === 'chmod' || mutation.operation === 'delete') continue;
		const segments = mutation.relativePath.split('/');
		for (let index = 1; index < segments.length; index += 1) {
			parents.add(segments.slice(0, index).join('/'));
		}
	}
	for (const relativePath of [...parents].sort(
		(left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right)
	)) {
		const target = path.join(stageRoot, relativePath);
		const stat = lstatIfPresent(target);
		if (!stat?.isDirectory() || stat.isSymbolicLink()) {
			throw new Error(`staged path parent is not a directory: ${relativePath}`);
		}
		const currentMode = stat.mode & 0o7777;
		const writableMode = currentMode | 0o700;
		if (currentMode !== writableMode) fs.chmodSync(target, writableMode);
	}
}

function prepareTransactionBase(root, stateFile) {
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

export async function applyAtomicDevSync(options) {
	const startedAt = Date.now();
	let phaseStartedAt = startedAt;
	const roots = validateRootSet([...options.declaredRoots]);
	let entries;
	try {
		entries = await inspectArchive(options.archivePath, roots);
	} catch (error) {
		throw new DevSyncTransactionError(
			`archive validation failed: ${error.message}`,
			true,
			'validation'
		);
	}
	const validationMs = Date.now() - phaseStartedAt;
	phaseStartedAt = Date.now();
	const transactionBase = prepareTransactionBase(options.root, options.stateFile);
	const transactionRoot = fs.mkdtempSync(path.join(transactionBase, 'txn-'));
	const stageRoot = path.join(transactionRoot, 'stage');
	const backupRoot = path.join(transactionRoot, 'backup');
	const stateTarget = path.join(options.root, options.stateFile);
	const stateBackup = path.join(transactionRoot, 'state-backup');
	fs.mkdirSync(stageRoot, { recursive: true });
	fs.mkdirSync(backupRoot, { recursive: true });

	try {
		await (options.extractArchive || defaultExtractArchive)(options.archivePath, stageRoot);
		validateStagedTree(stageRoot);
		options.beforeCommit?.(entries);
	} catch (error) {
		bestEffortRemove(transactionRoot);
		throw new DevSyncTransactionError(`archive staging failed: ${error.message}`, true, 'staging');
	}
	const stagingMs = Date.now() - phaseStartedAt;
	phaseStartedAt = Date.now();

	let plan;
	let changedRoots;
	try {
		for (const root of roots) assertSafeLiveParents(options.root, root);
		({ plan, changedRoots } = reconciliationPlan(options.root, stageRoot, roots, {
			pruneMissing: options.pruneMissing === true
		}));
	} catch (error) {
		bestEffortRemove(transactionRoot);
		throw new DevSyncTransactionError(
			`live root comparison failed: ${error.message}`,
			true,
			'staging'
		);
	}
	const planningMs = Date.now() - phaseStartedAt;
	phaseStartedAt = Date.now();
	let stateBackedUp = false;
	let stateCommitStarted = false;
	let rollbackComplete = true;
	const committedPaths = [];
	const createdLiveParents = [];
	let modeTransitions = [];
	const touchedModes = new Set();
	try {
		stateBackedUp = moveIfPresent(stateTarget, stateBackup);
		stateCommitStarted = true;
		modeTransitions = directoryModeTransitions(options.root, plan);
		for (const transition of modeTransitions) {
			const writableMode = transition.liveMode | 0o700;
			if (writableMode === transition.liveMode) continue;
			fs.chmodSync(path.join(options.root, transition.relativePath), writableMode);
			touchedModes.add(transition.relativePath);
		}
		makeStagedStructuralParentsWritable(stageRoot, plan);
		for (const mutation of plan.filter(({ operation }) => operation !== 'chmod')) {
			const live = path.join(options.root, mutation.relativePath);
			const backup = path.join(backupRoot, mutation.relativePath);
			const staged = path.join(stageRoot, mutation.relativePath);
			const liveBackedUp = backUpForMutation(live, backup, mutation.operation);
			committedPaths.push({ relativePath: mutation.relativePath, liveBackedUp });
			if (mutation.operation !== 'delete') {
				createdLiveParents.push(...ensureLiveParentDirectories(options.root, live));
				if (!moveIfPresent(staged, live)) {
					throw new Error(`staged path disappeared: ${mutation.relativePath}`);
				}
			}
		}
		// Apply restrictive modes deepest-first so parent traversal remains
		// available until every descendant has reached its final state.
		for (const transition of [...modeTransitions].sort(
			(left, right) => pathDepth(right.relativePath) - pathDepth(left.relativePath)
		)) {
			const currentMode = fs.lstatSync(path.join(options.root, transition.relativePath)).mode & 0o7777;
			if (currentMode === transition.finalMode) continue;
			fs.chmodSync(path.join(options.root, transition.relativePath), transition.finalMode);
			touchedModes.add(transition.relativePath);
		}
		options.persistState(options.nextState);
	} catch (error) {
		if (committedPaths.length > 0 || touchedModes.size > 0) {
			for (const transition of modeTransitions) {
				try {
					const target = path.join(options.root, transition.relativePath);
					const currentMode = fs.lstatSync(target).mode & 0o7777;
					const writableMode = currentMode | 0o700;
					if (currentMode !== writableMode) fs.chmodSync(target, writableMode);
					touchedModes.add(transition.relativePath);
				} catch {
					rollbackComplete = false;
				}
			}
		}
		for (const { relativePath, liveBackedUp } of [...committedPaths].reverse()) {
			const live = path.join(options.root, relativePath);
			const backup = path.join(backupRoot, relativePath);
			try {
				removeIfPresent(live);
				if (liveBackedUp) moveIfPresent(backup, live);
			} catch {
				rollbackComplete = false;
			}
		}
		for (const relativePath of [...createdLiveParents].reverse()) {
			try {
				fs.rmdirSync(path.join(options.root, relativePath));
			} catch {
				rollbackComplete = false;
			}
		}
		for (const transition of [...modeTransitions]
			.filter(({ relativePath }) => touchedModes.has(relativePath))
			.sort((left, right) => pathDepth(right.relativePath) - pathDepth(left.relativePath))) {
			try {
				fs.chmodSync(path.join(options.root, transition.relativePath), transition.liveMode);
			} catch {
				rollbackComplete = false;
			}
		}
		if (stateCommitStarted) {
			try {
				removeIfPresent(stateTarget);
				if (stateBackedUp) moveIfPresent(stateBackup, stateTarget);
			} catch {
				rollbackComplete = false;
				try {
					removeIfPresent(stateTarget);
				} catch {
					// Best effort: never deliberately restore a stale generation marker.
				}
			}
		}
		if (rollbackComplete) bestEffortRemove(transactionRoot);
		throw new DevSyncTransactionError(
			`atomic sync commit failed: ${error.message}${rollbackComplete ? '' : '; rollback incomplete and generation state withheld'}`,
			rollbackComplete,
			'commit'
		);
	}
	const commitMs = Date.now() - phaseStartedAt;

	bestEffortRemove(transactionRoot);
	try {
		fs.rmdirSync(transactionBase);
	} catch {
		// Another transaction or recovery artifact still exists.
	}
	return {
		entries,
		changedRoots,
		changedPaths: plan.map(({ relativePath }) => relativePath),
		timingsMs: {
			validation: validationMs,
			staging: stagingMs,
			planning: planningMs,
			commit: commitMs,
			total: Date.now() - startedAt
		}
	};
}
