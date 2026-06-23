/**
 * GitHub trigger backing — BFF-native (no Argo EventSource).
 *
 * Why not the generic `argo-eventsource` backing: routing GitHub's public
 * deliveries to a per-trigger Argo EventSource Service over Tailscale Funnel
 * means chasing a dynamically-named Service per trigger. The BFF is already a
 * stable, Funnel-exposable endpoint that owns the whole trigger spine
 * (idempotency + concurrency gate), so for `github` we:
 *   - register the repo webhook via the GitHub API (PAT sourced via External
 *     Secrets) pointing at ONE stable Funnel URL: the receiver route below;
 *   - validate each delivery's HMAC (`X-Hub-Signature-256`) in the receiver;
 *   - publish the standard `workflow.triggers` envelope so the spine handles
 *     dedup + capacity uniformly.
 *
 * The PAT + public base URL come from the environment (populated by an
 * ExternalSecret in the workflow-builder namespace). The per-trigger HMAC
 * secret is generated here and stored encrypted in the trigger's `config`.
 */
import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';
import { encryptObject, decryptObject, type EncryptedObject } from '$lib/server/security/encryption';

/**
 * GitHub PAT with `repo` (covers `admin:repo_hook`) on the target repo.
 * Prefers a dedicated `GITHUB_TRIGGER_PAT` but falls back to the `GITHUB_TOKEN`
 * the workflow-builder pod already loads from the `workflow-builder-secrets`
 * ExternalSecret (1Password `GITHUB-PAT`). Both arrive via External Secrets.
 */
function githubToken(): string {
	const tok = (
		env.GITHUB_TRIGGER_PAT ??
		process.env.GITHUB_TRIGGER_PAT ??
		env.GITHUB_TOKEN ??
		process.env.GITHUB_TOKEN ??
		''
	).trim();
	if (!tok) {
		throw new Error(
			'No GitHub PAT available — set GITHUB_TRIGGER_PAT (or GITHUB_TOKEN) with repo / admin:repo_hook ' +
				'scope. It is sourced via External Secrets into the workflow-builder namespace.'
		);
	}
	return tok;
}

/** Public base URL GitHub can reach (Tailscale Funnel host), e.g.
 *  https://workflow-builder-webhooks-dev.tail286401.ts.net */
function publicBaseUrl(): string {
	const base = (
		env.WORKFLOW_TRIGGERS_PUBLIC_BASE_URL ??
		process.env.WORKFLOW_TRIGGERS_PUBLIC_BASE_URL ??
		''
	).trim();
	if (!base) {
		throw new Error(
			'WORKFLOW_TRIGGERS_PUBLIC_BASE_URL is not set — needed so GitHub can deliver webhooks ' +
				'to the public Funnel host. Set it to the trigger Funnel ingress URL.'
		);
	}
	return base.replace(/\/+$/, '');
}

/** Stable, public receiver URL for a given trigger (where GitHub delivers). */
export function githubReceiverUrl(triggerId: string): string {
	return `${publicBaseUrl()}/api/internal/workflows/triggers/github/${encodeURIComponent(triggerId)}`;
}

const SECRET_CONFIG_KEY = '__webhookSecretEnc';

/** Per-trigger HMAC secret, stored encrypted in the trigger's config. */
function readEncryptedSecret(config: Record<string, unknown>): string | null {
	const enc = config[SECRET_CONFIG_KEY];
	if (!enc || typeof enc !== 'object') return null;
	try {
		const obj = decryptObject<{ secret?: string }>(enc as EncryptedObject);
		return typeof obj.secret === 'string' && obj.secret ? obj.secret : null;
	} catch {
		return null;
	}
}

/** Decrypt + return the trigger's HMAC secret (for the receiver). */
export function getGithubTriggerSecret(config: Record<string, unknown> | null | undefined): string | null {
	if (!config) return null;
	return readEncryptedSecret(config);
}

interface GithubBackingContext {
	triggerId: string;
	config: Record<string, unknown>;
}

interface GithubProvisionResult {
	/** backingRef stored on the row: `github:<owner>/<repo>#<hookId>`. */
	backingRef: string;
	/** Config patch to persist (carries the encrypted HMAC secret). */
	configPatch: Record<string, unknown>;
}

function parseEvents(config: Record<string, unknown>): string[] {
	const raw = typeof config.events === 'string' ? config.events : 'push';
	const list = raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length ? list : ['push'];
}

async function githubApi(
	path: string,
	init: { method?: string; body?: unknown } = {}
): Promise<Response> {
	return fetch(`https://api.github.com${path}`, {
		method: init.method ?? 'GET',
		headers: {
			authorization: `Bearer ${githubToken()}`,
			accept: 'application/vnd.github+json',
			'x-github-api-version': '2022-11-28',
			'user-agent': 'workflow-builder-triggers',
			...(init.body ? { 'content-type': 'application/json' } : {})
		},
		body: init.body ? JSON.stringify(init.body) : undefined
	});
}

/**
 * Create (or update) the repo webhook on GitHub pointing at our receiver, with a
 * freshly-generated HMAC secret. Idempotent: if a hook for our receiver URL
 * already exists it is patched in place. Returns the backingRef + the config
 * patch carrying the encrypted secret.
 */
export async function registerGithubWebhook(ctx: GithubBackingContext): Promise<GithubProvisionResult> {
	const owner = String(ctx.config.owner ?? '').trim();
	const repo = String(ctx.config.repo ?? '').trim();
	if (!owner || !repo) throw new Error('github trigger requires owner + repo');
	const events = parseEvents(ctx.config);
	const url = githubReceiverUrl(ctx.triggerId);

	// Reuse the existing per-trigger secret if present, else generate one.
	const existingSecret = readEncryptedSecret(ctx.config);
	const secret = existingSecret ?? crypto.randomBytes(32).toString('hex');

	const hookConfig = {
		url,
		content_type: 'json',
		secret,
		insecure_ssl: '0'
	};

	// Find an existing hook with our receiver URL (idempotent reconcile).
	const listRes = await githubApi(`/repos/${owner}/${repo}/hooks?per_page=100`);
	if (!listRes.ok) {
		const t = await listRes.text().catch(() => '');
		throw new Error(`list webhooks failed (${listRes.status}): ${t.slice(0, 200)}`);
	}
	const hooks = (await listRes.json()) as Array<{ id: number; config?: { url?: string } }>;
	const mine = hooks.find((h) => h.config?.url === url);

	let hookId: number;
	if (mine) {
		const patchRes = await githubApi(`/repos/${owner}/${repo}/hooks/${mine.id}`, {
			method: 'PATCH',
			body: { active: true, events, config: hookConfig }
		});
		if (!patchRes.ok) {
			const t = await patchRes.text().catch(() => '');
			throw new Error(`update webhook failed (${patchRes.status}): ${t.slice(0, 200)}`);
		}
		hookId = mine.id;
	} else {
		const createRes = await githubApi(`/repos/${owner}/${repo}/hooks`, {
			method: 'POST',
			body: { name: 'web', active: true, events, config: hookConfig }
		});
		if (!createRes.ok) {
			const t = await createRes.text().catch(() => '');
			throw new Error(`create webhook failed (${createRes.status}): ${t.slice(0, 200)}`);
		}
		const created = (await createRes.json()) as { id: number };
		hookId = created.id;
	}

	return {
		backingRef: `github:${owner}/${repo}#${hookId}`,
		configPatch: { [SECRET_CONFIG_KEY]: encryptObject({ secret }) }
	};
}

/** Delete the GitHub webhook referenced by backingRef (idempotent). */
export async function deleteGithubWebhook(backingRef: string | null | undefined): Promise<void> {
	if (!backingRef || !backingRef.startsWith('github:')) return;
	const m = backingRef.match(/^github:([^/]+)\/([^#]+)#(\d+)$/);
	if (!m) return;
	const [, owner, repo, hookId] = m;
	const res = await githubApi(`/repos/${owner}/${repo}/hooks/${hookId}`, { method: 'DELETE' });
	if (!res.ok && res.status !== 404) {
		const t = await res.text().catch(() => '');
		throw new Error(`delete webhook failed (${res.status}): ${t.slice(0, 200)}`);
	}
}
