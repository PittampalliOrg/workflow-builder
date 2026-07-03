import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { env } from "$env/dynamic/private";
import { db as defaultDb } from "$lib/server/db";
import { userCliCredentials } from "$lib/server/db/schema";
import { requirePostgresDb } from "$lib/server/application/adapters/postgres";
import type {
	CliCredentialSummary,
	HostCliCredentialStore,
	HostProviderCred,
	UserCliCredentialStore,
} from "$lib/server/application/cli-credentials";
import {
	decryptString,
	encryptString,
	type EncryptedObject,
} from "$lib/server/security/encryption";

type Database = typeof defaultDb;

function leaseRows(result: unknown): Array<{ holder_session_id?: string }> {
	if (Array.isArray(result)) return result as Array<{ holder_session_id?: string }>;
	const rows = (result as { rows?: unknown })?.rows;
	return Array.isArray(rows) ? (rows as Array<{ holder_session_id?: string }>) : [];
}

export class PostgresUserCliCredentialStore
	implements UserCliCredentialStore
{
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getCredential(userId: string, provider: string) {
		const [row] = await this.database
			.select({
				value: userCliCredentials.value,
				expiresAt: userCliCredentials.expiresAt,
				status: userCliCredentials.status,
			})
			.from(userCliCredentials)
			.where(
				and(
					eq(userCliCredentials.userId, userId),
					eq(userCliCredentials.provider, provider),
				),
			)
			.limit(1);
		if (!row) return null;
		return {
			token: decryptString(row.value as EncryptedObject),
			expiresAt: row.expiresAt ?? null,
			status: row.status,
		};
	}

	async upsertCredential(input: {
		userId: string;
		provider: string;
		token: string;
		expiresAt: Date;
		updatedAt: Date;
	}): Promise<void> {
		const encrypted = encryptString(input.token.trim());
		await this.database
			.insert(userCliCredentials)
			.values({
				userId: input.userId,
				provider: input.provider,
				value: encrypted,
				expiresAt: input.expiresAt,
				lastValidatedAt: null,
				status: "active",
				updatedAt: input.updatedAt,
			})
			.onConflictDoUpdate({
				target: [userCliCredentials.userId, userCliCredentials.provider],
				set: {
					value: encrypted,
					expiresAt: input.expiresAt,
					lastValidatedAt: null,
					status: "active",
					updatedAt: input.updatedAt,
				},
			});
	}

	async deleteCredential(userId: string, provider: string): Promise<boolean> {
		const deleted = await this.database
			.delete(userCliCredentials)
			.where(
				and(
					eq(userCliCredentials.userId, userId),
					eq(userCliCredentials.provider, provider),
				),
			)
			.returning({ id: userCliCredentials.id });
		return deleted.length > 0;
	}

	async getCredentialSummary(
		userId: string,
		provider: string,
	): Promise<CliCredentialSummary> {
		const [row] = await this.database
			.select({
				expiresAt: userCliCredentials.expiresAt,
				lastValidatedAt: userCliCredentials.lastValidatedAt,
				status: userCliCredentials.status,
			})
			.from(userCliCredentials)
			.where(
				and(
					eq(userCliCredentials.userId, userId),
					eq(userCliCredentials.provider, provider),
				),
			)
			.limit(1);
		if (!row) {
			return {
				provider,
				linked: false,
				expiresAt: null,
				lastValidatedAt: null,
				status: null,
			};
		}
		return {
			provider,
			linked: true,
			expiresAt: row.expiresAt?.toISOString() ?? null,
			lastValidatedAt: row.lastValidatedAt?.toISOString() ?? null,
			status: row.status,
		};
	}

	async acquireBootLease(input: {
		userId: string;
		provider: string;
		sessionId: string;
		staleSecs: number;
	}): Promise<boolean> {
		const result = await this.database.execute(sql`
			INSERT INTO cli_credential_locks (user_id, provider, holder_session_id, acquired_at)
			VALUES (${input.userId}, ${input.provider}, ${input.sessionId}, now())
			ON CONFLICT (user_id, provider) DO UPDATE
				SET holder_session_id = EXCLUDED.holder_session_id, acquired_at = now()
				WHERE cli_credential_locks.holder_session_id = ${input.sessionId}
				   OR cli_credential_locks.acquired_at < now() - make_interval(secs => ${input.staleSecs})
			RETURNING holder_session_id
		`);
		return leaseRows(result)[0]?.holder_session_id === input.sessionId;
	}

	async releaseBootLease(input: {
		userId: string;
		provider: string;
		sessionId: string;
	}): Promise<void> {
		await this.database.execute(sql`
			DELETE FROM cli_credential_locks
			WHERE user_id = ${input.userId} AND provider = ${input.provider}
			  AND holder_session_id = ${input.sessionId}
		`);
	}
}

const HOST_URL =
	env.HOST_CLI_CRED_DATABASE_URL ??
	process.env.HOST_CLI_CRED_DATABASE_URL ??
	"";

export class RawPostgresHostCliCredentialStore
	implements HostCliCredentialStore
{
	private client: ReturnType<typeof postgres> | null = null;

	isEnabled(): boolean {
		return !!HOST_URL;
	}

	private getClient(): ReturnType<typeof postgres> {
		if (!this.client) this.client = postgres(HOST_URL, { max: 4 });
		return this.client;
	}

	async getProviderCredential(
		provider: string,
	): Promise<HostProviderCred | null> {
		const c = this.getClient();
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

	async captureProviderCredential(
		provider: string,
		token: string,
	): Promise<string | null> {
		const c = this.getClient();
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

	async acquireBootLease(input: {
		ownerUserId: string;
		provider: string;
		sessionId: string;
		staleSecs: number;
	}): Promise<boolean> {
		const c = this.getClient();
		const rows = await c<{ holder_session_id: string }[]>`
			insert into cli_credential_locks (user_id, provider, holder_session_id, acquired_at)
			values (${input.ownerUserId}, ${input.provider}, ${input.sessionId}, now())
			on conflict (user_id, provider) do update
				set holder_session_id = excluded.holder_session_id, acquired_at = now()
				where cli_credential_locks.holder_session_id = ${input.sessionId}
				   or cli_credential_locks.acquired_at < now() - make_interval(secs => ${input.staleSecs})
			returning holder_session_id`;
		return rows.length > 0 && rows[0].holder_session_id === input.sessionId;
	}

	async releaseBootLease(input: {
		ownerUserId: string;
		provider: string;
		sessionId: string;
	}): Promise<void> {
		const c = this.getClient();
		await c`delete from cli_credential_locks
			where user_id = ${input.ownerUserId} and provider = ${input.provider}
			  and holder_session_id = ${input.sessionId}`;
	}
}
