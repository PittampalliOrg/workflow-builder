/**
 * Single-store for single-use-refresh CLI credentials across the host + preview
 * vclusters.
 *
 * codex (provider "openai") uses a ChatGPT OAuth token whose refresh token is
 * SINGLE-USE — it rotates on every refresh. Copying that credential into a
 * preview's own DB forks the token lineage and breaks the source login. So a
 * preview must NOT hold a copy; instead it resolves + captures + serializes codex
 * auth against the ONE host store, shared by the host and every preview.
 *
 * Activation: `HOST_CLI_CRED_DATABASE_URL` is set ONLY inside preview vclusters
 * (runner-staged = the host `workflow_builder` DB URL, reachable via the
 * replicated postgres service). On the host itself the env is unset and all of
 * cli-credentials.ts uses the local DB (which already IS the host store).
 *
 * Owner model: previews are single-operator test tenants, so the host's
 * "active cred for a provider" is the newest active row — we key the shared
 * boot-lease on that row's owner so host + preview codex boots serialize on the
 * same lease row (see cli-credentials.ts).
 */
import postgres from "postgres";
import { env } from "$env/dynamic/private";
import {
	decryptString,
	encryptString,
	type EncryptedObject,
} from "$lib/server/security/encryption";

const HOST_URL =
	env.HOST_CLI_CRED_DATABASE_URL ??
	process.env.HOST_CLI_CRED_DATABASE_URL ??
	"";

/** True only in a preview vcluster (host DB URL staged) — gates the host-store path. */
export function hostCredStoreEnabled(): boolean {
	return !!HOST_URL;
}

let _client: ReturnType<typeof postgres> | null = null;
function hostClient(): ReturnType<typeof postgres> {
	if (!_client) _client = postgres(HOST_URL, { max: 4 });
	return _client;
}

export type HostProviderCred = {
	token: string;
	ownerUserId: string;
	expiresAt: Date | null;
};

/** The host's active credential for a provider (newest active row). */
export async function getHostProviderCred(
	provider: string,
): Promise<HostProviderCred | null> {
	const c = hostClient();
	const rows = await c<
		{ user_id: string; value: EncryptedObject; expires_at: Date | null }[]
	>`
		select user_id, value, expires_at from user_cli_credentials
		where provider = ${provider} and status = 'active'
		order by updated_at desc limit 1`;
	if (!rows.length) return null;
	return {
		token: decryptString(rows[0].value),
		ownerUserId: rows[0].user_id,
		expiresAt: rows[0].expires_at ?? null,
	};
}

/** Update the host's active cred row for a provider (the operator's lineage). */
export async function captureHostProviderCred(
	provider: string,
	token: string,
): Promise<string | null> {
	const c = hostClient();
	const rows = await c<{ user_id: string }[]>`
		select user_id from user_cli_credentials
		where provider = ${provider} and status = 'active'
		order by updated_at desc limit 1`;
	if (!rows.length) return null;
	const uid = rows[0].user_id;
	const enc = encryptString(token.trim());
	await c`update user_cli_credentials
		set value = ${c.json({ iv: enc.iv, data: enc.data })}, updated_at = now()
		where user_id = ${uid} and provider = ${provider}`;
	return uid;
}

/** Claim the boot lease on the HOST store. Returns true if held by sessionId. */
export async function hostLeaseAcquire(
	ownerUserId: string,
	provider: string,
	sessionId: string,
	staleSecs: number,
): Promise<boolean> {
	const c = hostClient();
	const rows = await c<{ holder_session_id: string }[]>`
		insert into cli_credential_locks (user_id, provider, holder_session_id, acquired_at)
		values (${ownerUserId}, ${provider}, ${sessionId}, now())
		on conflict (user_id, provider) do update
			set holder_session_id = excluded.holder_session_id, acquired_at = now()
			where cli_credential_locks.holder_session_id = ${sessionId}
			   or cli_credential_locks.acquired_at < now() - make_interval(secs => ${staleSecs})
		returning holder_session_id`;
	return rows.length > 0 && rows[0].holder_session_id === sessionId;
}

/** Release the boot lease on the HOST store if held by sessionId. */
export async function hostLeaseRelease(
	ownerUserId: string,
	provider: string,
	sessionId: string,
): Promise<void> {
	const c = hostClient();
	await c`delete from cli_credential_locks
		where user_id = ${ownerUserId} and provider = ${provider}
		  and holder_session_id = ${sessionId}`;
}
