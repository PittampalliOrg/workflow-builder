import { posix as pathPosix } from "node:path";
import { gunzipSync } from "node:zlib";
import { cliAuthForProvider } from "$lib/server/agents/runtime-registry";

export type CliTokenErrorCode = "CLI_TOKEN_MISSING" | "CLI_TOKEN_EXPIRED";

export class CliTokenError extends Error {
	readonly code: CliTokenErrorCode;
	readonly provider: string;

	constructor(code: CliTokenErrorCode, provider: string, message: string) {
		super(message);
		this.name = "CliTokenError";
		this.code = code;
		this.provider = provider;
	}
}

export type CliCredential = {
	token: string;
	expiresAt: Date | null;
	status: string;
};

export type CliCredentialSummary = {
	provider: string;
	linked: boolean;
	expiresAt: string | null;
	lastValidatedAt: string | null;
	status: string | null;
};

export type HostProviderCred = {
	token: string;
	ownerUserId: string;
	expiresAt: Date | null;
};

export type UserCliCredentialStore = {
	getCredential(userId: string, provider: string): Promise<CliCredential | null>;
	upsertCredential(input: {
		userId: string;
		provider: string;
		token: string;
		expiresAt: Date;
		updatedAt: Date;
	}): Promise<void>;
	deleteCredential(userId: string, provider: string): Promise<boolean>;
	getCredentialSummary(
		userId: string,
		provider: string,
	): Promise<CliCredentialSummary>;
	acquireBootLease(input: {
		userId: string;
		provider: string;
		sessionId: string;
		staleSecs: number;
	}): Promise<boolean>;
	releaseBootLease(input: {
		userId: string;
		provider: string;
		sessionId: string;
	}): Promise<void>;
};

export type HostCliCredentialStore = {
	isEnabled(): boolean;
	getProviderCredential(provider: string): Promise<HostProviderCred | null>;
	captureProviderCredential(
		provider: string,
		token: string,
	): Promise<string | null>;
	acquireBootLease(input: {
		ownerUserId: string;
		provider: string;
		sessionId: string;
		staleSecs: number;
	}): Promise<boolean>;
	releaseBootLease(input: {
		ownerUserId: string;
		provider: string;
		sessionId: string;
	}): Promise<void>;
};

const DEFAULT_TTL_DAYS = 363;
const FILE_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;
const FILE_BUNDLE_TAR_MAX_BYTES = 32 * 1024 * 1024;
const AGY_LOGIN_TOKEN_PATH = "antigravity-cli/antigravity-oauth-token";
const SINGLE_USE_REFRESH_PROVIDERS = new Set(["openai"]);
const LEASE_STALE_MS = 75_000;
const LEASE_ACQUIRE_TIMEOUT_MS = 75_000;
const LEASE_POLL_MS = 1_500;

export function cliCredentialNeedsBootLease(provider: string): boolean {
	return SINGLE_USE_REFRESH_PROVIDERS.has(provider);
}

function readTarString(buf: Buffer, offset: number, length: number): string {
	const slice = buf.subarray(offset, offset + length);
	const nul = slice.indexOf(0);
	return slice.subarray(0, nul >= 0 ? nul : undefined).toString("utf8").trim();
}

function tarGzHasRegularFile(buf: Buffer, requiredPath: string): boolean {
	let archive: Buffer;
	try {
		archive = gunzipSync(buf, { maxOutputLength: FILE_BUNDLE_TAR_MAX_BYTES });
	} catch {
		throw new Error("Credential bundle must be a valid tar.gz archive.");
	}
	if (archive.length > FILE_BUNDLE_TAR_MAX_BYTES) {
		throw new Error("Credential bundle tar archive is too large.");
	}

	for (let offset = 0; offset + 512 <= archive.length; ) {
		const header = archive.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) return false;

		const name = readTarString(header, 0, 100);
		const prefix = readTarString(header, 345, 155);
		const rawPath = prefix ? `${prefix}/${name}` : name;
		const normalizedPath = pathPosix.normalize(rawPath);
		const typeflag = readTarString(header, 156, 1);
		const sizeText = readTarString(header, 124, 12);
		const size = Number.parseInt(sizeText || "0", 8);
		if (!Number.isFinite(size) || size < 0) {
			throw new Error("Credential bundle contains an invalid tar entry.");
		}

		if (
			(typeflag === "" || typeflag === "0") &&
			normalizedPath === requiredPath &&
			size > 0
		) {
			return true;
		}

		offset += 512 + Math.ceil(size / 512) * 512;
	}

	return false;
}

export function assertPlausibleCliCredential(
	provider: string,
	token: string,
): void {
	const trimmed = token.trim();
	if (!trimmed) throw new Error("A credential value is required");
	const kind = cliAuthForProvider(provider)?.credentialKind ?? "env_token";

	if (kind === "device_login") {
		throw new Error(
			"This runtime authenticates in the terminal (device-code OAuth). " +
				"There is no token to store - just start a session and complete the login there.",
		);
	}

	if (kind === "file") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error(
				"Expected the contents of your auth.json (valid JSON). Run the login command locally, " +
					"then paste the whole ~/.codex/auth.json file.",
			);
		}
		const obj = (parsed ?? {}) as Record<string, unknown>;
		const authMode = typeof obj.auth_mode === "string" ? obj.auth_mode : null;
		const hasTokens = obj.tokens && typeof obj.tokens === "object";
		if (authMode === "apikey" || (!hasTokens && obj.OPENAI_API_KEY)) {
			throw new Error(
				"This auth.json is an API-key login, not a ChatGPT subscription login. " +
					"Run `codex login` (browser ChatGPT OAuth) and paste the resulting auth.json so usage " +
					"stays on your subscription.",
			);
		}
		if (!hasTokens) {
			throw new Error(
				"auth.json is missing the OAuth `tokens` block - re-run `codex login` and paste the fresh file.",
			);
		}
		return;
	}

	if (kind === "file_bundle") {
		let buf: Buffer;
		try {
			buf = Buffer.from(trimmed, "base64");
		} catch {
			throw new Error("Credential bundle must be base64-encoded.");
		}
		if (buf.length < 32) {
			throw new Error("Credential bundle is too small to be a valid login archive.");
		}
		if (buf[0] !== 0x1f || buf[1] !== 0x8b) {
			throw new Error("Credential bundle must be a gzip (tar.gz) archive.");
		}
		if (buf.length > FILE_BUNDLE_MAX_BYTES) {
			throw new Error("Credential bundle is too large (>8 MiB).");
		}
		if (
			provider === "google" &&
			!tarGzHasRegularFile(buf, AGY_LOGIN_TOKEN_PATH)
		) {
			throw new Error(
				"AGY credential bundle is missing the Antigravity OAuth token. " +
					"Start a fresh AGY session and complete the Antigravity login flow.",
			);
		}
		return;
	}

	if (trimmed.startsWith("sk-ant-api")) {
		throw new Error(
			"This looks like an Anthropic API key (sk-ant-api...). API keys are not accepted here - " +
				"they would break subscription auth and bill the metered API instead. Run `claude setup-token` " +
				"locally and paste the sk-ant-oat... subscription OAuth token.",
		);
	}
	if (/\s/.test(trimmed)) {
		throw new Error("Token must not contain whitespace");
	}
	if (trimmed.length < 20) {
		throw new Error("Token looks too short to be a CLI OAuth token");
	}
}

export class ApplicationCliCredentialsService {
	constructor(
		private readonly deps: {
			userStore: UserCliCredentialStore;
			hostStore: HostCliCredentialStore;
			now?: () => Date;
			sleep?: (ms: number) => Promise<void>;
		},
	) {}

	needsBootLease(provider: string): boolean {
		return cliCredentialNeedsBootLease(provider);
	}

	getUserCredential(
		userId: string,
		provider: string,
	): Promise<CliCredential | null> {
		if (this.needsBootLease(provider) && this.deps.hostStore.isEnabled()) {
			return this.deps.hostStore.getProviderCredential(provider).then((cred) =>
				cred
					? { token: cred.token, expiresAt: cred.expiresAt, status: "active" }
					: null,
			);
		}
		return this.deps.userStore.getCredential(userId, provider);
	}

	async acquireBootLease(
		userId: string,
		provider: string,
		sessionId: string,
		opts?: { staleMs?: number; timeoutMs?: number },
	): Promise<boolean> {
		if (!this.needsBootLease(provider) || !sessionId) return true;
		const staleSecs = (opts?.staleMs ?? LEASE_STALE_MS) / 1000;
		const deadline = Date.now() + (opts?.timeoutMs ?? LEASE_ACQUIRE_TIMEOUT_MS);
		const sleep = this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

		if (this.deps.hostStore.isEnabled()) {
			const owner = (await this.deps.hostStore.getProviderCredential(provider))
				?.ownerUserId;
			if (!owner) return true;
			for (;;) {
				if (
					await this.deps.hostStore.acquireBootLease({
						ownerUserId: owner,
						provider,
						sessionId,
						staleSecs,
					})
				) {
					return true;
				}
				if (Date.now() >= deadline) return false;
				await sleep(LEASE_POLL_MS);
			}
		}

		for (;;) {
			if (
				await this.deps.userStore.acquireBootLease({
					userId,
					provider,
					sessionId,
					staleSecs,
				})
			) {
				return true;
			}
			if (Date.now() >= deadline) return false;
			await sleep(LEASE_POLL_MS);
		}
	}

	async releaseBootLease(
		userId: string,
		provider: string,
		sessionId: string,
	): Promise<void> {
		if (!this.needsBootLease(provider) || !sessionId) return;
		if (this.deps.hostStore.isEnabled()) {
			const owner = (await this.deps.hostStore.getProviderCredential(provider))
				?.ownerUserId;
			if (owner) {
				await this.deps.hostStore.releaseBootLease({
					ownerUserId: owner,
					provider,
					sessionId,
				});
			}
			return;
		}
		await this.deps.userStore.releaseBootLease({ userId, provider, sessionId });
	}

	async upsertUserCredential(
		userId: string,
		provider: string,
		token: string,
		expiresAt?: Date | null,
	): Promise<CliCredentialSummary> {
		assertPlausibleCliCredential(provider, token);
		if (this.needsBootLease(provider) && this.deps.hostStore.isEnabled()) {
			const owner = await this.deps.hostStore.captureProviderCredential(
				provider,
				token,
			);
			return {
				provider,
				linked: !!owner,
				expiresAt: (expiresAt ?? null)?.toISOString() ?? null,
				lastValidatedAt: null,
				status: "active",
			};
		}
		const now = this.deps.now?.() ?? new Date();
		const effectiveExpiresAt =
			expiresAt ?? new Date(now.getTime() + DEFAULT_TTL_DAYS * 86_400_000);
		await this.deps.userStore.upsertCredential({
			userId,
			provider,
			token,
			expiresAt: effectiveExpiresAt,
			updatedAt: now,
		});
		return {
			provider,
			linked: true,
			expiresAt: effectiveExpiresAt.toISOString(),
			lastValidatedAt: null,
			status: "active",
		};
	}

	deleteUserCredential(userId: string, provider: string): Promise<boolean> {
		return this.deps.userStore.deleteCredential(userId, provider);
	}

	getCredentialSummary(
		userId: string,
		provider: string,
	): Promise<CliCredentialSummary> {
		return this.deps.userStore.getCredentialSummary(userId, provider);
	}
}
