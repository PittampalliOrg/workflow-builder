import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { env } from "$env/dynamic/private";
import type { PreviewGitHubInstallationTokenPort } from "$lib/server/application/ports";

type GitHubAppPermission = "read" | "write";

export type GithubAppInstallationTokenOptions = Readonly<{
  appId?: () => string | null;
  installationId?: () => string | null;
  privateKey?: () => string | null | Promise<string | null>;
  repositories: readonly string[];
  permissions: Readonly<Record<string, GitHubAppPermission>>;
  fetch?: typeof globalThis.fetch;
  apiBaseUrl?: string;
  now?: () => Date;
}>;

type CachedToken = Readonly<{ token: string; expiresAt: number }>;

const POSITIVE_INTEGER = /^[1-9][0-9]{0,19}$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+$/;
const PERMISSION_NAME = /^[a-z_]+$/;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function createGithubAppJwt(
  appId: string,
  privateKey: string,
  now: Date,
): string {
  if (!POSITIVE_INTEGER.test(appId) || !privateKey.includes("PRIVATE KEY")) {
    throw new Error("preview control GitHub App identity is invalid");
  }
  const issuedAt = Math.floor(now.getTime() / 1_000) - 60;
  const encodedHeader = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64url(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: appId }),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString("base64url")}`;
}

/** Exchanges a physical-only GitHub App key for a scoped, short-lived installation token. */
export class GithubAppInstallationTokenAdapter implements PreviewGitHubInstallationTokenPort {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly apiBaseUrl: string;
  private cached: CachedToken | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(private readonly options: GithubAppInstallationTokenOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(
      /\/+$/,
      "",
    );
    if (
      options.repositories.length === 0 ||
      options.repositories.some((repository) => !REPOSITORY_NAME.test(repository)) ||
      new Set(options.repositories).size !== options.repositories.length ||
      Object.keys(options.permissions).length === 0 ||
      Object.entries(options.permissions).some(
        ([name, permission]) =>
          !PERMISSION_NAME.test(name) ||
          !(permission === "read" || permission === "write"),
      )
    ) {
      throw new Error("preview control GitHub App token scope is invalid");
    }
  }

  async token(): Promise<string> {
    const now = (this.options.now ?? (() => new Date()))().getTime();
    if (this.cached && this.cached.expiresAt - now > 60_000) {
      return this.cached.token;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.exchange().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async exchange(): Promise<string> {
    const appId = (
      this.options.appId?.() ??
      env.PREVIEW_CONTROL_GITHUB_APP_ID ??
      process.env.PREVIEW_CONTROL_GITHUB_APP_ID ??
      ""
    ).trim();
    const installationId = (
      this.options.installationId?.() ??
      env.PREVIEW_CONTROL_GITHUB_APP_INSTALLATION_ID ??
      process.env.PREVIEW_CONTROL_GITHUB_APP_INSTALLATION_ID ??
      ""
    ).trim();
    const privateKey = (
      (await this.options.privateKey?.()) ?? (await environmentPrivateKey())
    )?.trim();
    if (
      !POSITIVE_INTEGER.test(appId) ||
      !POSITIVE_INTEGER.test(installationId) ||
      !privateKey
    ) {
      throw new Error("preview control GitHub App credentials are not configured");
    }
    const now = (this.options.now ?? (() => new Date()))();
    const jwt = createGithubAppJwt(appId, privateKey, now);
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          repositories: [...this.options.repositories],
          permissions: this.options.permissions,
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const expiresAt =
      typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    if (!response.ok || !token || !Number.isFinite(expiresAt)) {
      throw new Error(
        typeof body.message === "string"
          ? body.message
          : `GitHub App token exchange failed (HTTP ${response.status})`,
      );
    }
    this.cached = Object.freeze({ token, expiresAt });
    return token;
  }
}

async function environmentPrivateKey(): Promise<string | null> {
  const inline = (
    env.PREVIEW_CONTROL_GITHUB_APP_PRIVATE_KEY ??
    process.env.PREVIEW_CONTROL_GITHUB_APP_PRIVATE_KEY ??
    ""
  ).trim();
  if (inline) return inline.replace(/\\n/g, "\n");
  const file = (
    env.PREVIEW_CONTROL_GITHUB_APP_PRIVATE_KEY_FILE ??
    process.env.PREVIEW_CONTROL_GITHUB_APP_PRIVATE_KEY_FILE ??
    ""
  ).trim();
  if (!file) return null;
  return readFile(file, "utf8");
}
