import { and, asc, eq } from 'drizzle-orm';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import {
	workflowCodeCheckpoints,
	type WorkflowCodeCheckpoint,
	type WorkflowCodeCheckpointStatus
} from '$lib/server/db/schema';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';

const execFileAsync = promisify(execFile);
let gitCredentialsPromise: Promise<{ username: string; token: string }> | null =
	null;

const CHECKPOINT_STATUSES = new Set<WorkflowCodeCheckpointStatus>([
	'created',
	'no_changes',
	'skipped',
	'error'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function normalizeStatus(value: unknown): WorkflowCodeCheckpointStatus {
	const text = stringValue(value);
	if (text && CHECKPOINT_STATUSES.has(text as WorkflowCodeCheckpointStatus)) {
		return text as WorkflowCodeCheckpointStatus;
	}
	return 'skipped';
}

function normalizeChangedFiles(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord).map((item) => ({ ...item }));
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safePathspec(path: string | null): string | null {
	if (!path) return null;
	if (path.includes('\0') || path.startsWith('/')) return null;
	return path;
}

function parseTimestamp(value: unknown): Date | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function daprConfigurationValues(keys: string[]) {
	const store = env.DAPR_CONFIG_STORE || 'azureappconfig-workflow-runtime';
	const host = env.DAPR_HOST || '127.0.0.1';
	const port = env.DAPR_HTTP_PORT || '3500';
	const url = new URL(`http://${host}:${port}/v1.0/configuration/${store}`);
	for (const key of keys) url.searchParams.append('key', key);
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
		if (!response.ok) return {};
		const payload = (await response.json()) as Record<
			string,
			{ value?: unknown }
		>;
		const values: Record<string, string> = {};
		for (const [key, item] of Object.entries(payload || {})) {
			if (typeof item?.value === 'string') values[key] = item.value;
		}
		return values;
	} catch {
		return {};
	}
}

async function daprSecretValue(secretName: string) {
	if (!secretName.trim()) return '';
	const store = env.DAPR_SECRETS_STORE || 'azure-keyvault';
	const host = env.DAPR_HOST || '127.0.0.1';
	const port = env.DAPR_HTTP_PORT || '3500';
	try {
		const response = await fetch(
			`http://${host}:${port}/v1.0/secrets/${store}/${encodeURIComponent(secretName)}`,
			{ signal: AbortSignal.timeout(3_000) }
		);
		if (!response.ok) return '';
		const payload = (await response.json()) as Record<string, string>;
		return payload[secretName] ?? Object.values(payload)[0] ?? '';
	} catch {
		return '';
	}
}

async function checkpointGitCredentials() {
	if (!gitCredentialsPromise) {
		gitCredentialsPromise = (async () => {
			const config = await daprConfigurationValues([
				'WORKFLOW_CHECKPOINT_GIT_USERNAME',
				'GITEA_USERNAME'
			]);
			const username = (
				env.WORKFLOW_CHECKPOINT_GIT_USERNAME ||
				config.WORKFLOW_CHECKPOINT_GIT_USERNAME ||
				env.GITEA_USERNAME ||
				config.GITEA_USERNAME ||
				'giteaadmin'
			).trim();
			const tokenSecretName = (
				env.WORKFLOW_CHECKPOINT_GIT_TOKEN_SECRET_NAME ||
				env.GITEA_TOKEN_SECRET_NAME ||
				'GITEA-TOKEN'
			).trim();
			const token = (
				env.WORKFLOW_CHECKPOINT_GIT_TOKEN ||
				env.GITEA_TOKEN ||
				env.GITEA_PASSWORD ||
				(await daprSecretValue(tokenSecretName)) ||
				(await daprSecretValue('GITEA-REGISTRY-PASSWORD')) ||
				''
			).trim();
			return { username, token };
		})();
	}
	return gitCredentialsPromise;
}

async function authenticatedGitUrl(remoteUrl: string): Promise<string> {
	const { username, token } = await checkpointGitCredentials();
	if (!username || !token) return remoteUrl;
	try {
		const parsed = new URL(remoteUrl);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return remoteUrl;
		}
		parsed.username = username;
		parsed.password = token;
		return parsed.toString();
	} catch {
		return remoteUrl;
	}
}

async function basicGitAuthHeader(): Promise<string | null> {
	const { username, token } = await checkpointGitCredentials();
	if (!username || !token) return null;
	return `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
}

function rowToDto(row: WorkflowCodeCheckpoint) {
	return {
		id: row.id,
		workflowExecutionId: row.workflowExecutionId,
		workflowAgentRunId: row.workflowAgentRunId,
		workflowAgentEventId: row.workflowAgentEventId,
		parentExecutionId: row.parentExecutionId,
		daprInstanceId: row.daprInstanceId,
		workspaceRef: row.workspaceRef,
		sandboxName: row.sandboxName,
		repoPath: row.repoPath,
		nodeId: row.nodeId,
		sourceEventId: row.sourceEventId,
		seq: row.seq,
		toolName: row.toolName,
		checkpointKind: row.checkpointKind,
		beforeSha: row.beforeSha,
		afterSha: row.afterSha,
		remoteUrl: row.remoteUrl,
		remoteRef: row.remoteRef,
		remoteStatus: row.remoteStatus,
		remoteError: row.remoteError,
		remotePushedAt: row.remotePushedAt?.toISOString() ?? null,
		changedFiles: row.changedFiles,
		fileCount: row.fileCount,
		status: row.status,
		error: row.error,
		metadata: row.metadata,
		createdAt: row.createdAt.toISOString()
	};
}

export type PersistCodeCheckpointInput = {
	workflowExecutionId: string;
	workflowAgentRunId?: string | null;
	workflowAgentEventId?: number | null;
	parentExecutionId?: string | null;
	daprInstanceId: string;
	sourceEventId: string;
	seq?: number | null;
	toolName: string;
	nodeId?: string | null;
	payload: unknown;
};

export async function persistCodeCheckpointFromAgentEvent(
	input: PersistCodeCheckpointInput
) {
	if (!db || !isRecord(input.payload)) return;

	const changedFiles = normalizeChangedFiles(input.payload.changedFiles);
	const status = normalizeStatus(input.payload.status);
	const repoPath = stringValue(input.payload.repoPath) ?? '/sandbox';
	const checkpointKind = 'tool_mutation';
	const sourceEventId =
		stringValue(input.payload.sourceEventId) ?? input.sourceEventId;
	const fileCount = numberValue(input.payload.fileCount) ?? changedFiles.length;
	const remotePushedAt = parseTimestamp(input.payload.remotePushedAt);

	await db
		.insert(workflowCodeCheckpoints)
		.values({
			workflowExecutionId: input.workflowExecutionId,
			workflowAgentRunId: input.workflowAgentRunId ?? null,
			workflowAgentEventId: input.workflowAgentEventId ?? null,
			parentExecutionId:
				input.parentExecutionId ?? stringValue(input.payload.parentExecutionId),
			daprInstanceId: input.daprInstanceId,
			workspaceRef: stringValue(input.payload.workspaceRef),
			sandboxName: stringValue(input.payload.sandboxName),
			repoPath,
			nodeId: input.nodeId ?? stringValue(input.payload.nodeId),
			sourceEventId,
			seq: input.seq ?? numberValue(input.payload.seq),
			toolName: stringValue(input.payload.toolName) ?? input.toolName,
			checkpointKind,
			beforeSha: stringValue(input.payload.beforeSha),
			afterSha: stringValue(input.payload.afterSha),
			remoteUrl: stringValue(input.payload.remoteUrl),
			remoteRef: stringValue(input.payload.remoteRef),
			remoteStatus: stringValue(input.payload.remoteStatus),
			remoteError: stringValue(input.payload.remoteError),
			remotePushedAt,
			changedFiles,
			fileCount,
			status,
			error: stringValue(input.payload.error),
			metadata: isRecord(input.payload.metadata)
				? input.payload.metadata
				: {
						toolCallId: stringValue(input.payload.toolCallId),
						createdBy: 'dapr-agent-py'
					}
		})
		.onConflictDoNothing({
			target: [
				workflowCodeCheckpoints.workflowExecutionId,
				workflowCodeCheckpoints.daprInstanceId,
				workflowCodeCheckpoints.sourceEventId,
				workflowCodeCheckpoints.checkpointKind
			]
		});
}

export async function listCodeCheckpointsForExecution(executionId: string) {
	if (!db) return [];
	const rows = await db
		.select()
		.from(workflowCodeCheckpoints)
		.where(eq(workflowCodeCheckpoints.workflowExecutionId, executionId))
		.orderBy(
			asc(workflowCodeCheckpoints.seq),
			asc(workflowCodeCheckpoints.createdAt)
		);
	return rows.map(rowToDto);
}

export async function getCodeCheckpoint(
	executionId: string,
	checkpointId: string
) {
	if (!db) return null;
	const [row] = await db
		.select()
		.from(workflowCodeCheckpoints)
		.where(
			and(
				eq(workflowCodeCheckpoints.workflowExecutionId, executionId),
				eq(workflowCodeCheckpoints.id, checkpointId)
			)
		)
		.limit(1);
	return row ?? null;
}

export async function loadCodeCheckpointDiff(
	executionId: string,
	checkpointId: string,
	filePath: string | null = null
) {
	const checkpoint = await getCodeCheckpoint(executionId, checkpointId);
	if (!checkpoint) {
		return { error: 'Checkpoint not found', status: 404 as const };
	}
	if (!checkpoint.beforeSha || !checkpoint.afterSha) {
		return {
			checkpoint: rowToDto(checkpoint),
			diff: '',
			exitCode: 0,
			message: 'No commit range was recorded for this checkpoint'
		};
	}
	if (checkpoint.beforeSha === checkpoint.afterSha) {
		return {
			checkpoint: rowToDto(checkpoint),
			diff: '',
			exitCode: 0,
			message: 'No file changes were recorded for this checkpoint'
		};
	}

	const pathspec = safePathspec(filePath);
	if (filePath && !pathspec) {
		return { error: 'Invalid file path', status: 400 as const };
	}

	if (checkpoint.sandboxName) {
		const command = [
			`cd ${shellQuote(checkpoint.repoPath)}`,
			'git diff --find-renames --stat --patch --binary',
			shellQuote(checkpoint.beforeSha),
			shellQuote(checkpoint.afterSha),
			'--',
			pathspec ? shellQuote(pathspec) : ''
		]
			.filter(Boolean)
			.join(' ');

		const upstream = await openshellRuntimeFetch(
			`/api/v1/sandboxes/${encodeURIComponent(checkpoint.sandboxName)}/exec`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ command, timeout: 30 })
			}
		);

		if (upstream.ok) {
			const body = (await upstream.json().catch(() => ({}))) as Record<
				string,
				unknown
			>;
			const stdout = typeof body.stdout === 'string' ? body.stdout : '';
			const stderr = typeof body.stderr === 'string' ? body.stderr : '';
			const output = typeof body.output === 'string' ? body.output : '';
			const diff = stdout || output || stderr;
			const exitCode =
				numberValue(body.exit_code) ?? numberValue(body.exitCode) ?? 0;

			if (exitCode === 0 && diff.trim()) {
				return {
					checkpoint: rowToDto(checkpoint),
					source: 'sandbox' as const,
					filePath: pathspec,
					diff,
					exitCode,
					error: null
				};
			}

			if (
				(checkpoint.remoteStatus !== 'pushed' ||
					!checkpoint.remoteUrl ||
					!checkpoint.remoteRef) &&
				(exitCode !== 0 || diff.trim())
			) {
				return {
					checkpoint: rowToDto(checkpoint),
					source: 'sandbox' as const,
					filePath: pathspec,
					diff,
					exitCode,
					error:
						exitCode === 0 ? null : stderr || output || `git diff exited ${exitCode}`
				};
			}
		}
	}

	if (
		checkpoint.remoteStatus !== 'pushed' ||
		!checkpoint.remoteUrl ||
		!checkpoint.remoteRef
	) {
		return {
			error:
				checkpoint.sandboxName
					? 'Checkpoint sandbox is unavailable and no durable remote ref was recorded'
					: 'Checkpoint has no retained sandbox or durable remote ref',
			status: 409 as const
		};
	}

	return await loadCodeCheckpointDiffFromRemote(checkpoint, pathspec);
}

async function loadCodeCheckpointDiffFromRemote(
	checkpoint: WorkflowCodeCheckpoint,
	pathspec: string | null
) {
	try {
		const giteaDiff = await loadCodeCheckpointDiffFromGiteaApi(
			checkpoint,
			pathspec
		);
		if (giteaDiff) return giteaDiff;
	} catch (err) {
		return {
			error:
				err instanceof Error
					? `Remote checkpoint diff failed: ${err.message}`
					: 'Remote checkpoint diff failed',
			status: 502 as const
		};
	}

	const tempDir = await mkdtemp(join(tmpdir(), 'workflow-code-checkpoint-'));
	try {
		const remoteUrl = await authenticatedGitUrl(checkpoint.remoteUrl ?? '');
		await execFileAsync('git', ['init', '-q'], { cwd: tempDir });
		await execFileAsync(
			'git',
			['fetch', '--depth=2', remoteUrl, checkpoint.remoteRef ?? ''],
			{
			cwd: tempDir,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSL_NO_VERIFY: 'true' },
			maxBuffer: 1024 * 1024 * 12
		}
	);
		const args = [
			'diff',
			'--find-renames',
			'--stat',
			'--patch',
			'--binary',
			checkpoint.beforeSha ?? '',
			checkpoint.afterSha ?? '',
			'--'
		];
		if (pathspec) args.push(pathspec);
		const { stdout, stderr } = await execFileAsync('git', args, {
			cwd: tempDir,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSL_NO_VERIFY: 'true' },
			maxBuffer: 1024 * 1024 * 24
		});
		return {
			checkpoint: rowToDto(checkpoint),
			source: 'remote' as const,
			filePath: pathspec,
			diff: stdout || stderr,
			exitCode: 0,
			error: null
		};
	} catch (err) {
		return {
			error:
				err instanceof Error
					? `Remote checkpoint diff failed: ${err.message}`
					: 'Remote checkpoint diff failed',
			status: 502 as const
		};
	} finally {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}

async function loadCodeCheckpointDiffFromGiteaApi(
	checkpoint: WorkflowCodeCheckpoint,
	pathspec: string | null
) {
	if (!checkpoint.remoteUrl || !checkpoint.afterSha) return null;
	let apiUrl: URL;
	try {
		const parsed = new URL(checkpoint.remoteUrl);
		const parts = parsed.pathname
			.replace(/^\/+/, '')
			.replace(/\.git$/, '')
			.split('/')
			.filter(Boolean);
		if (parts.length < 2) return null;
		const owner = parts[0];
		const repo = parts.slice(1).join('/');
		apiUrl = new URL(
			`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(checkpoint.afterSha)}.diff`,
			parsed.origin
		);
	} catch {
		return null;
	}

	const headers: Record<string, string> = {};
	const authHeader = await basicGitAuthHeader();
	if (authHeader) {
		headers.Authorization = authHeader.replace(/^Authorization:\s*/i, '');
	}
	const response = await fetch(apiUrl, {
		headers,
		signal: AbortSignal.timeout(15_000)
	}).catch((err) => {
		throw new Error(
			err instanceof Error ? err.message : 'Gitea diff request failed'
		);
	});
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(
			`Gitea diff request failed (${response.status}): ${body.slice(0, 300)}`
		);
	}
	const diff = await response.text();
	return {
		checkpoint: rowToDto(checkpoint),
		source: 'remote' as const,
		filePath: pathspec,
		diff,
		exitCode: 0,
		error: null
	};
}

export async function restoreCodeCheckpointToSandbox(input: {
	executionId: string;
	checkpointId: string;
	sandboxName: string;
	repoPath?: string | null;
}) {
	const checkpoint = await getCodeCheckpoint(input.executionId, input.checkpointId);
	if (!checkpoint) {
		return { error: 'Checkpoint not found', status: 404 as const };
	}
	if (!checkpoint.afterSha) {
		return { error: 'Checkpoint has no target SHA', status: 409 as const };
	}
	if (
		checkpoint.remoteStatus !== 'pushed' ||
		!checkpoint.remoteUrl ||
		!checkpoint.remoteRef
	) {
		return { error: 'Checkpoint has no durable remote ref', status: 409 as const };
	}
	const sandboxName = input.sandboxName.trim();
	if (!sandboxName) {
		return { error: 'sandboxName is required', status: 400 as const };
	}
	const repoPath = input.repoPath?.trim() || checkpoint.repoPath || '/sandbox';
	const authHeader = await basicGitAuthHeader();
	const fetchPrefix = authHeader
		? `git -c http.extraHeader=${shellQuote(authHeader)}`
		: 'git';
	const command = [
		`mkdir -p ${shellQuote(repoPath)}`,
		`cd ${shellQuote(repoPath)}`,
		'git init -q',
		`(git remote remove workflow-builder-checkpoints >/dev/null 2>&1 || true)`,
		`git remote add workflow-builder-checkpoints ${shellQuote(checkpoint.remoteUrl)}`,
		`GIT_TERMINAL_PROMPT=0 GIT_SSL_NO_VERIFY=true ${fetchPrefix} fetch --depth=2 workflow-builder-checkpoints ${shellQuote(checkpoint.remoteRef)}`,
		`git reset --hard ${shellQuote(checkpoint.afterSha)}`,
		'git clean -fdx',
		'git status --short'
	].join(' && ');

	const upstream = await openshellRuntimeFetch(
		`/api/v1/sandboxes/${encodeURIComponent(sandboxName)}/exec`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ command, timeout: 120 })
		}
	);
	if (!upstream.ok) {
		return {
			error: `OpenShell runtime returned HTTP ${upstream.status}`,
			status: 502 as const
		};
	}
	const body = (await upstream.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const exitCode =
		numberValue(body.exit_code) ?? numberValue(body.exitCode) ?? 0;
	if (exitCode !== 0) {
		return {
			error:
				typeof body.stderr === 'string'
					? body.stderr
					: typeof body.output === 'string'
						? body.output
						: `restore exited ${exitCode}`,
			status: 502 as const
		};
	}
	return {
		checkpoint: rowToDto(checkpoint),
		sandboxName,
		repoPath,
		afterSha: checkpoint.afterSha,
		output:
			typeof body.output === 'string'
				? body.output
				: typeof body.stdout === 'string'
					? body.stdout
					: ''
	};
}
