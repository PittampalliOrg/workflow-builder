/**
 * Clone GitHub repositories declared as session resources into a session's
 * OpenShell sandbox, before the agent's first turn.
 *
 * Design (see plan "Attach GitHub repositories to agent runs"):
 *   - The token is brokered ENTIRELY in the BFF. We decrypt the referenced
 *     vault credential in-process (`resolveCredential`) — it never enters the
 *     pod spec, a K8s Secret, or a new internal endpoint.
 *   - Delivery into the sandbox is the same workspace channel
 *     `provisionSessionSandbox` already uses
 *     (`getWorkspaceRuntimeUrl()/api/workspaces/command`). The token is passed
 *     as the `GIT_REPO_TOKEN` env var and consumed via a transient
 *     `GIT_ASKPASS` helper, so it never appears in the command string (process
 *     args), the clone URL, or `.git/config`. The remote is scrubbed to a
 *     tokenless URL after clone.
 *   - Mounting is best-effort: a failed clone emits a session event but does
 *     NOT fail the spawn (the agent can report it).
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "$lib/server/db";
import { sessionResources } from "$lib/server/db/schema";
import { daprFetch, getWorkspaceRuntimeUrl } from "$lib/server/dapr-client";
import { resolveCredential } from "$lib/server/vaults/credentials";
import { getScmConnection } from "$lib/server/scm-connections";
import { appendEvent } from "$lib/server/sessions/events";

/** Where to run the clone — the already-provisioned session sandbox. */
export type RepositorySandboxTarget = {
	/** Logical scope id the sandbox was provisioned under. For UI sessions this
	 * is the session id; for workflow-driven sessions it is the bridge's
	 * executionId. */
	executionId: string;
	/** workspaceRef returned by `provisionSessionSandbox` (or the workflow
	 * bridge). Targets the specific workspace within the execution. */
	workspaceRef: string | null;
	/** Sandbox root cwd. Default `/sandbox`. Repos with no explicit mountPath
	 * land under here. */
	rootPath?: string | null;
};

type RepoResourceRow = {
	id: string;
	repoUrl: string | null;
	checkoutRef: string | null;
	mountPath: string | null;
	authTokenCredentialId: string | null;
	appConnectionExternalId: string | null;
};

const CLONE_TIMEOUT_MS = 180_000;

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

/**
 * Mount every not-yet-mounted github_repository resource for a session. Called
 * after the sandbox is provisioned and before the workflow starts (direct
 * sessions: session-create; workflow-driven: the ensure-for-workflow bridge).
 */
export async function mountSessionRepositories(
	sessionId: string,
	target: RepositorySandboxTarget,
): Promise<void> {
	const database = requireDb();
	const rows = (await database
		.select({
			id: sessionResources.id,
			repoUrl: sessionResources.repoUrl,
			checkoutRef: sessionResources.checkoutRef,
			mountPath: sessionResources.mountPath,
			authTokenCredentialId: sessionResources.authTokenCredentialId,
			appConnectionExternalId: sessionResources.appConnectionExternalId,
		})
		.from(sessionResources)
		.where(
			and(
				eq(sessionResources.sessionId, sessionId),
				eq(sessionResources.type, "github_repository"),
				isNull(sessionResources.mountedAt),
				isNull(sessionResources.removedAt),
			),
		)) as RepoResourceRow[];

	for (const row of rows) {
		await mountSingleRepository(sessionId, row, target);
	}
}

/**
 * Mount a single repository into the live sandbox. Used by
 * `mountSessionRepositories` and by the mid-session add path (when a repo is
 * attached to an already-running session). Never throws — failures are
 * surfaced as a session event.
 */
export async function mountSingleRepository(
	sessionId: string,
	row: RepoResourceRow,
	target: RepositorySandboxTarget,
): Promise<void> {
	const rootPath =
		(target.rootPath ?? "/sandbox").replace(/\/+$/, "") || "/sandbox";
	const prepared = await prepareRepoMount(sessionId, row, rootPath);
	if (!prepared) return;
	const { repoUrl, command, token, mountPath, ref } = prepared;

	try {
		const url = `${getWorkspaceRuntimeUrl()}/api/workspaces/command`;
		const body: Record<string, unknown> = {
			executionId: target.executionId,
			workspaceRef: target.workspaceRef ?? undefined,
			command,
			// Token rides ONLY in env — never in `command` (process args/logs),
			// the clone URL, or `.git/config`.
			env: token ? { GIT_REPO_TOKEN: token } : undefined,
			cwd: rootPath,
			timeoutMs: CLONE_TIMEOUT_MS,
			workflowId: "ui-session-repo",
			nodeId: sessionId,
			nodeName: "mount-repository",
		};
		const res = await daprFetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			maxRetries: 1,
		});
		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).slice(0, 400);
			await emitMountFailed(
				sessionId,
				row,
				repoUrl,
				`workspace/command failed (${res.status}): ${detail}`,
			);
			return;
		}
		await markMounted(row.id);
		await appendEvent(sessionId, {
			type: "session.resource_mounted",
			data: { resourceId: row.id, repoUrl, mountPath, ref: ref || null },
		});
	} catch (err) {
		await emitMountFailed(
			sessionId,
			row,
			repoUrl,
			`clone request errored: ${describeError(err)}`,
		);
	}
}

/**
 * Shared per-row prep for both clone transports: token resolution
 * (app_connection > vault credential) + askpass-based clone command. Returns
 * null (after emitting a `session.resource_mount_failed` event) when the row
 * can't be cloned.
 */
async function prepareRepoMount(
	sessionId: string,
	row: RepoResourceRow,
	rootPath: string,
): Promise<{
	repoUrl: string;
	command: string;
	token: string | null;
	mountPath: string;
	ref: string;
} | null> {
	const repoUrl = (row.repoUrl ?? "").trim();
	if (!repoUrl) return null;

	const normalizedUrl = normalizeGithubUrl(repoUrl);
	if (!normalizedUrl) {
		await emitMountFailed(sessionId, row, repoUrl, "unsupported repository URL");
		return null;
	}

	const mountPath = resolveMountPath(row.mountPath, normalizedUrl, rootPath);
	const ref = (row.checkoutRef ?? "").trim();

	// Clone-auth token comes from EITHER a GitHub OAuth app_connection
	// (resolved + auto-refreshed at clone time) OR a vault credential. The
	// connection path takes precedence when both are set.
	let token: string | null = null;
	if (row.appConnectionExternalId) {
		try {
			const scm = await getScmConnection(row.appConnectionExternalId);
			const auth = scm?.headers?.Authorization ?? "";
			token = auth.replace(/^Bearer\s+/i, "").trim() || null;
			if (!token) {
				await emitMountFailed(
					sessionId,
					row,
					repoUrl,
					"GitHub connection resolved to no usable token",
				);
				return null;
			}
		} catch (err) {
			await emitMountFailed(
				sessionId,
				row,
				repoUrl,
				`connection token resolution failed: ${describeError(err)}`,
			);
			return null;
		}
	} else if (row.authTokenCredentialId) {
		try {
			const cred = await resolveCredential(row.authTokenCredentialId);
			token = cred?.accessToken ?? cred?.secret ?? null;
			if (!token) {
				await emitMountFailed(
					sessionId,
					row,
					repoUrl,
					"bound credential resolved to no usable token",
				);
				return null;
			}
		} catch (err) {
			await emitMountFailed(
				sessionId,
				row,
				repoUrl,
				`credential resolution failed: ${describeError(err)}`,
			);
			return null;
		}
	}

	const command = buildCloneCommand({
		cloneUrl: token ? withAuthUsername(normalizedUrl) : normalizedUrl,
		tokenlessUrl: normalizedUrl,
		mountPath,
		ref,
		usesToken: Boolean(token),
	});

	return { repoUrl, command, token, mountPath, ref };
}

/**
 * Clone every not-yet-mounted github_repository resource directly into an
 * interactive-CLI session's per-session sandbox pod, via the cli-agent-py
 * host's `POST /internal/workspace/command` (port 8002, X-Internal-Token).
 * Used instead of `mountSessionRepositories` for `interactive-cli`-family
 * runtimes — their working tree lives in the agent pod's `/sandbox`, not an
 * OpenShell workspace sandbox.
 *
 * Same token discipline as the workspace path: the token rides ONLY in `env`
 * (GIT_ASKPASS pattern), never in the command string or `.git/config`.
 * Best-effort: failures emit a `session.resource_mount_failed` event and
 * never throw.
 */
export async function mountSessionRepositoriesViaHost(
	sessionId: string,
	hostBaseUrl: string,
): Promise<void> {
	const database = requireDb();
	const rows = (await database
		.select({
			id: sessionResources.id,
			repoUrl: sessionResources.repoUrl,
			checkoutRef: sessionResources.checkoutRef,
			mountPath: sessionResources.mountPath,
			authTokenCredentialId: sessionResources.authTokenCredentialId,
			appConnectionExternalId: sessionResources.appConnectionExternalId,
		})
		.from(sessionResources)
		.where(
			and(
				eq(sessionResources.sessionId, sessionId),
				eq(sessionResources.type, "github_repository"),
				isNull(sessionResources.mountedAt),
				isNull(sessionResources.removedAt),
			),
		)) as RepoResourceRow[];
	if (rows.length === 0) return;

	const rootPath = "/sandbox";
	const internalToken =
		process.env.INTERNAL_API_TOKEN?.trim() ?? "";
	const baseUrl = hostBaseUrl.replace(/\/+$/, "");

	for (const row of rows) {
		const prepared = await prepareRepoMount(sessionId, row, rootPath);
		if (!prepared) continue;
		const { repoUrl, command, token, mountPath, ref } = prepared;
		try {
			const res = await daprFetch(`${baseUrl}/internal/workspace/command`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(internalToken ? { "X-Internal-Token": internalToken } : {}),
				},
				body: JSON.stringify({
					command,
					// Token rides ONLY in env — never in `command` (process args/
					// logs), the clone URL, or `.git/config`.
					...(token ? { env: { GIT_REPO_TOKEN: token } } : {}),
					cwd: rootPath,
				}),
				maxRetries: 0,
			});
			if (!res.ok) {
				const detail = (await res.text().catch(() => "")).slice(0, 400);
				await emitMountFailed(
					sessionId,
					row,
					repoUrl,
					`host workspace/command failed (${res.status}): ${detail}`,
				);
				continue;
			}
			await markMounted(row.id);
			await appendEvent(sessionId, {
				type: "session.resource_mounted",
				data: { resourceId: row.id, repoUrl, mountPath, ref: ref || null },
			});
		} catch (err) {
			await emitMountFailed(
				sessionId,
				row,
				repoUrl,
				`host clone request errored: ${describeError(err)}`,
			);
		}
	}
}

async function markMounted(resourceId: string): Promise<void> {
	const database = requireDb();
	await database
		.update(sessionResources)
		.set({ mountedAt: new Date() })
		.where(eq(sessionResources.id, resourceId));
}

async function emitMountFailed(
	sessionId: string,
	row: { id: string },
	repoUrl: string,
	error: string,
): Promise<void> {
	console.warn(
		`[session-repos] mount failed for ${repoUrl} (session ${sessionId}): ${error}`,
	);
	try {
		await appendEvent(sessionId, {
			type: "session.resource_mount_failed",
			data: { resourceId: row.id, repoUrl, error },
		});
	} catch (emitErr) {
		console.warn("[session-repos] failed to emit mount-failed event:", emitErr);
	}
}

/**
 * Normalize an https github.com URL to its canonical `.git` clone form. Returns
 * null for anything that isn't an https github.com repo — the brokered clone
 * path is github-only (Tier 1) and must not be coerced into cloning arbitrary
 * hosts.
 */
export function normalizeGithubUrl(input: string): string | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	if (url.hostname.toLowerCase() !== "github.com") return null;
	// owner/repo[.git] — strip query/hash, trailing slash, ensure .git suffix.
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length < 2) return null;
	const owner = segments[0];
	const repo = segments[1].replace(/\.git$/i, "");
	if (!owner || !repo) return null;
	return `https://github.com/${owner}/${repo}.git`;
}

/** Insert the `x-access-token` username so git invokes GIT_ASKPASS for the
 * password (the token). No secret in the URL itself. */
function withAuthUsername(githubGitUrl: string): string {
	return githubGitUrl.replace(/^https:\/\//, "https://x-access-token@");
}

function resolveMountPath(
	explicit: string | null,
	normalizedUrl: string,
	rootPath: string,
): string {
	const trimmed = (explicit ?? "").trim();
	if (trimmed) {
		// Keep it inside the sandbox root: absolute paths pass through; bare
		// names are placed under rootPath.
		if (trimmed.startsWith("/")) return trimmed;
		return `${rootPath}/${trimmed}`;
	}
	const repoName =
		normalizedUrl
			.replace(/\.git$/i, "")
			.split("/")
			.pop() || "repo";
	return `${rootPath}/${repoName}`;
}

/** Build the bash clone command. The token is NOT referenced here — it is read
 * from $GIT_REPO_TOKEN by the transient askpass helper at runtime. */
function buildCloneCommand(opts: {
	cloneUrl: string;
	tokenlessUrl: string;
	mountPath: string;
	ref: string;
	usesToken: boolean;
}): string {
	const dir = shQuote(opts.mountPath);
	const cloneUrl = shQuote(opts.cloneUrl);
	const tokenlessUrl = shQuote(opts.tokenlessUrl);
	const lines: string[] = ["set -e", `DIR=${dir}`];
	lines.push(
		`if [ -e "$DIR/.git" ]; then echo "repo already present at $DIR"; exit 0; fi`,
	);
	lines.push(`mkdir -p "$(dirname "$DIR")"`);

	if (opts.usesToken) {
		lines.push(`ASKPASS="$(mktemp)"`);
		// echo the token from env; never logged because it's not in the command.
		lines.push(
			`printf '#!/bin/sh\\nexec echo "$GIT_REPO_TOKEN"\\n' > "$ASKPASS"`,
		);
		lines.push(`chmod +x "$ASKPASS"`);
		lines.push(
			`GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 git clone --filter=blob:none ${cloneUrl} "$DIR" || { rm -f "$ASKPASS"; exit 1; }`,
		);
		lines.push(`rm -f "$ASKPASS"`);
		// Scrub the remote so the (username-only) auth URL isn't persisted.
		lines.push(`git -C "$DIR" remote set-url origin ${tokenlessUrl}`);
	} else {
		lines.push(
			`GIT_TERMINAL_PROMPT=0 git clone --filter=blob:none ${cloneUrl} "$DIR"`,
		);
	}

	if (opts.ref) {
		lines.push(`git -C "$DIR" checkout ${shQuote(opts.ref)}`);
	}
	// Record the clone point as the run-diff baseline so the session-end
	// workspace diff shows ONLY what the agent changed (not the whole clone).
	// Best-effort (lightweight tag); the capture falls back to empty-tree.
	lines.push(`git -C "$DIR" tag -f wfb-baseline HEAD 2>/dev/null || true`);
	return lines.join("\n");
}

/** POSIX single-quote escaping — safe for user-supplied URL/ref/path. */
function shQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function describeError(err: unknown): string {
	const message =
		err instanceof Error
			? err.message
			: typeof err === "string"
				? err
				: String(err);
	// Strip NUL bytes (Postgres-hostile in the event payload) and clamp.
	return (message ?? "").replace(/\u0000/g, "").trim().slice(0, 400);
}
