import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { env } from '$env/dynamic/private';
import type { WorkflowCodeCheckpointReadModel } from '$lib/server/application/ports';
import { daprFetch, getDaprSidecarUrl } from '$lib/server/dapr-client';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';

const execFileAsync = promisify(execFile);
let gitCredentialsPromise: Promise<{ username: string; token: string }> | null =
	null;

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

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safePathspec(path: string | null): string | null {
	if (!path) return null;
	if (path.includes('\0') || path.startsWith('/')) return null;
	return path;
}

function compactMessage(value: string, maxLength = 260): string {
	const grpcDetails = value.match(/details\s*=\s*"([^"]+)"/);
	if (grpcDetails?.[1]) return grpcDetails[1];
	const grpcMessage = value.match(/grpc_message:\s*"([^"]+)"/);
	if (grpcMessage?.[1]) return grpcMessage[1];
	const compacted = value.replace(/\s+/g, ' ').trim();
	return compacted.length > maxLength
		? `${compacted.slice(0, maxLength - 1)}...`
		: compacted;
}

function checkpointHasDurableRemote(checkpoint: WorkflowCodeCheckpointReadModel): boolean {
	return (
		checkpoint.remoteStatus === 'pushed' &&
		!!checkpoint.remoteUrl &&
		!!checkpoint.remoteRef
	);
}

function checkpointUnavailableMessage(
	checkpoint: WorkflowCodeCheckpointReadModel,
	sandboxError?: string | null
): string {
	const parts = [
		checkpoint.sandboxName
			? `Checkpoint sandbox '${checkpoint.sandboxName}' is unavailable`
			: 'Checkpoint has no retained sandbox'
	];
	if (checkpoint.remoteStatus === 'error' && checkpoint.remoteError) {
		parts.push(`durable Git push failed: ${compactMessage(checkpoint.remoteError)}`);
	} else if (checkpoint.remoteStatus === 'skipped' && checkpoint.remoteError) {
		parts.push(`durable Git push was skipped: ${compactMessage(checkpoint.remoteError)}`);
	} else if (!checkpoint.remoteUrl || !checkpoint.remoteRef) {
		parts.push('no durable Git ref was recorded');
	} else if (checkpoint.remoteStatus !== 'pushed') {
		parts.push(`durable Git ref is not usable (status: ${checkpoint.remoteStatus ?? 'unknown'})`);
	}
	if (sandboxError) parts.push(`sandbox diff failed: ${sandboxError}`);
	return `${parts.join('; ')}.`;
}

async function sandboxHttpError(response: Response): Promise<string> {
	const bodyText = await response.text().catch(() => '');
	if (!bodyText.trim()) return `OpenShell returned ${response.status}`;
	try {
		const body = JSON.parse(bodyText) as unknown;
		if (isRecord(body)) {
			const message =
				typeof body.error === 'string'
					? body.error
					: typeof body.message === 'string'
						? body.message
						: '';
			if (message) return `OpenShell returned ${response.status}: ${compactMessage(message)}`;
		}
	} catch {
		// Fall through to compact raw body.
	}
	return `OpenShell returned ${response.status}: ${compactMessage(bodyText)}`;
}

async function daprConfigurationValues(keys: string[]) {
	const store = env.DAPR_CONFIG_STORE || 'azureappconfig-workflow-runtime';
	const url = new URL(`${getDaprSidecarUrl()}/v1.0/configuration/${store}`);
	for (const key of keys) url.searchParams.append('key', key);
	try {
		const response = await daprFetch(url.toString(), {
			signal: AbortSignal.timeout(3_000),
			maxRetries: 0
		});
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
	try {
		const response = await daprFetch(
			`${getDaprSidecarUrl()}/v1.0/secrets/${store}/${encodeURIComponent(secretName)}`,
			{ signal: AbortSignal.timeout(3_000), maxRetries: 0 }
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

export async function loadCodeCheckpointDiff(
	checkpoint: WorkflowCodeCheckpointReadModel,
	filePath: string | null = null
) {
	if (!checkpoint.beforeSha || !checkpoint.afterSha) {
		return {
			checkpoint,
			diff: '',
			exitCode: 0,
			message: 'No commit range was recorded for this checkpoint'
		};
	}
	if (checkpoint.beforeSha === checkpoint.afterSha) {
		return {
			checkpoint,
			diff: '',
			exitCode: 0,
			message: 'No file changes were recorded for this checkpoint'
		};
	}

	const pathspec = safePathspec(filePath);
	if (filePath && !pathspec) {
		return { error: 'Invalid file path', status: 400 as const };
	}

	let sandboxError: string | null = null;
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
		).catch((err) => {
			sandboxError = err instanceof Error ? err.message : 'request failed';
			return null;
		});

		if (upstream?.ok) {
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
					checkpoint,
					source: 'sandbox' as const,
					filePath: pathspec,
					diff,
					exitCode,
					error: null
				};
			}

			if (
				!checkpointHasDurableRemote(checkpoint) &&
				(exitCode !== 0 || diff.trim())
			) {
				return {
					checkpoint,
					source: 'sandbox' as const,
					filePath: pathspec,
					diff,
					exitCode,
					error:
						exitCode === 0 ? null : stderr || output || `git diff exited ${exitCode}`
				};
			}
			if (exitCode !== 0) {
				sandboxError = compactMessage(stderr || output || `git diff exited ${exitCode}`);
			}
		} else if (upstream) {
			sandboxError = await sandboxHttpError(upstream);
		}
	}

	if (!checkpointHasDurableRemote(checkpoint)) {
		return {
			error: checkpointUnavailableMessage(checkpoint, sandboxError),
			status: 409 as const
		};
	}

	return await loadCodeCheckpointDiffFromRemote(checkpoint, pathspec);
}

async function loadCodeCheckpointDiffFromRemote(
	checkpoint: WorkflowCodeCheckpointReadModel,
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
			checkpoint,
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
	checkpoint: WorkflowCodeCheckpointReadModel,
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
		checkpoint,
		source: 'remote' as const,
		filePath: pathspec,
		diff,
		exitCode: 0,
		error: null
	};
}

export async function restoreCodeCheckpointToSandbox(input: {
	checkpoint: WorkflowCodeCheckpointReadModel;
	sandboxName: string;
	repoPath?: string | null;
}) {
	const checkpoint = input.checkpoint;
	if (!checkpoint.afterSha) {
		return { error: 'Checkpoint has no target SHA', status: 409 as const };
	}
	if (!checkpointHasDurableRemote(checkpoint)) {
		return { error: checkpointUnavailableMessage(checkpoint), status: 409 as const };
	}
	const remoteUrl = checkpoint.remoteUrl;
	const remoteRef = checkpoint.remoteRef;
	const afterSha = checkpoint.afterSha;
	if (!remoteUrl || !remoteRef || !afterSha) {
		return { error: checkpointUnavailableMessage(checkpoint), status: 409 as const };
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
		`git remote add workflow-builder-checkpoints ${shellQuote(remoteUrl)}`,
		`GIT_TERMINAL_PROMPT=0 GIT_SSL_NO_VERIFY=true ${fetchPrefix} fetch --depth=2 workflow-builder-checkpoints ${shellQuote(remoteRef)}`,
		`git reset --hard ${shellQuote(afterSha)}`,
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
		checkpoint,
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
