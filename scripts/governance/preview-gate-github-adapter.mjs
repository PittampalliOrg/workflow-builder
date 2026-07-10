import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  PREVIEW_ACCEPTANCE_CONTEXT,
  PREVIEW_ACTIVATION_CONTEXT,
  PREVIEW_GATE_CONTEXT,
} from "./preview-gate-domain.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CONTEXTS = new Set([
  PREVIEW_GATE_CONTEXT,
  PREVIEW_ACCEPTANCE_CONTEXT,
  PREVIEW_ACTIVATION_CONTEXT,
]);
const STATES = new Set(["pending", "success", "failure", "error"]);
const POSITIVE_INTEGER = /^[1-9][0-9]{0,19}$/;

function headers(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function validTuple(tuple) {
  return (
    tuple &&
    REPOSITORY.test(tuple.repository) &&
    Number.isSafeInteger(tuple.pullRequestNumber) &&
    tuple.pullRequestNumber > 0 &&
    FULL_SHA.test(tuple.baseSha) &&
    FULL_SHA.test(tuple.headSha) &&
    tuple.baseSha !== tuple.headSha
  );
}

export class GitHubPreviewGateAdapter {
  constructor({ token, fetch: fetchImpl = globalThis.fetch, apiBaseUrl } = {}) {
    this.token = token ?? "";
    this.fetch = fetchImpl;
    this.apiBaseUrl = (apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  }

  async inspect(tuple) {
    if (!validTuple(tuple)) throw new Error("preview gate PR tuple is invalid");
    const requestHeaders = headers(this.token);
    const pullResponse = await this.fetch(
      `${this.apiBaseUrl}/repos/${tuple.repository}/pulls/${tuple.pullRequestNumber}`,
      { headers: requestHeaders, signal: AbortSignal.timeout(15_000) },
    );
    if (!pullResponse.ok) {
      throw new Error(`GitHub PR inspection failed (HTTP ${pullResponse.status})`);
    }
    const pull = await pullResponse.json();
    const base = pull?.base;
    const head = pull?.head;
    if (
      pull?.state !== "open" ||
      base?.ref !== "main" ||
      base?.repo?.full_name !== tuple.repository ||
      head?.repo?.full_name !== tuple.repository ||
      base?.sha !== tuple.baseSha ||
      head?.sha !== tuple.headSha ||
      !Number.isSafeInteger(pull.changed_files) ||
      pull.changed_files < 1 ||
      pull.changed_files > 3_000
    ) {
      throw new Error("GitHub PR repo/base/head tuple is stale or mismatched");
    }

    const changedPaths = new Set();
    let observed = 0;
    for (let page = 1; page <= 30; page += 1) {
      const response = await this.fetch(
        `${this.apiBaseUrl}/repos/${tuple.repository}/pulls/${tuple.pullRequestNumber}/files?per_page=100&page=${page}`,
        { headers: requestHeaders, signal: AbortSignal.timeout(20_000) },
      );
      if (!response.ok) {
        throw new Error(`GitHub PR files failed (HTTP ${response.status})`);
      }
      const files = await response.json();
      if (!Array.isArray(files)) throw new Error("GitHub returned invalid PR files");
      for (const file of files) {
        if (typeof file?.filename !== "string" || !file.filename) {
          throw new Error("GitHub returned an invalid changed path");
        }
        observed += 1;
        changedPaths.add(file.filename);
        if (file.status === "renamed") {
          if (typeof file.previous_filename !== "string" || !file.previous_filename) {
            throw new Error("GitHub returned an invalid renamed path");
          }
          changedPaths.add(file.previous_filename);
        }
      }
      if (observed > pull.changed_files) {
        throw new Error("GitHub PR file pages exceed the declared count");
      }
      if (files.length < 100) break;
      if (page === 30) throw new Error("GitHub PR file list exceeds the bound");
    }
    if (observed !== pull.changed_files) {
      throw new Error("GitHub PR file pages are incomplete");
    }
    return Object.freeze({ ...tuple, changedPaths: Object.freeze([...changedPaths]) });
  }

  async publish(tuple, { context, state, description }) {
    if (
      !validTuple(tuple) ||
      !CONTEXTS.has(context) ||
      !STATES.has(state) ||
      typeof description !== "string" ||
      !description ||
      description.length > 140 ||
      /[\u0000-\u001f\u007f]/.test(description)
    ) {
      throw new Error("preview gate commit status is invalid");
    }
    if (!this.token) throw new Error("preview gate GitHub App token is required");
    const response = await this.fetch(
      `${this.apiBaseUrl}/repos/${tuple.repository}/statuses/${tuple.headSha}`,
      {
        method: "POST",
        headers: { ...headers(this.token), "Content-Type": "application/json" },
        body: JSON.stringify({
          state,
          context,
          description,
          target_url: `https://github.com/${tuple.repository}/pull/${tuple.pullRequestNumber}`,
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(
        typeof body.message === "string"
          ? body.message
          : `GitHub status publication failed (HTTP ${response.status})`,
      );
    }
  }
}

function githubAppJwt(appId, privateKey, now) {
  if (!POSITIVE_INTEGER.test(appId) || !privateKey.includes("PRIVATE KEY")) {
    throw new Error("workflow-builder preview gate GitHub App identity is invalid");
  }
  const issuedAt = Math.floor(now.getTime() / 1_000) - 60;
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: appId }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(privateKey).toString("base64url")}`;
}

/** Trusted-base workflow credential, fixed to this repo and gate permissions. */
export class GitHubAppWorkflowPreviewGateCredentials {
  constructor({
    appId,
    installationId,
    privateKey,
    privateKeyFile,
    fetch: fetchImpl = globalThis.fetch,
    apiBaseUrl,
    now,
  } = {}) {
    this.appId = appId;
    this.installationId = installationId;
    this.privateKey = privateKey;
    this.privateKeyFile = privateKeyFile;
    this.fetch = fetchImpl;
    this.apiBaseUrl = (apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.now = now ?? (() => new Date());
  }

  async token() {
    const appId = String(
      this.appId ?? process.env.PREVIEW_CONTROL_GITHUB_APP_ID ?? "",
    ).trim();
    const installationId = String(
      this.installationId ??
        process.env.PREVIEW_CONTROL_GITHUB_APP_INSTALLATION_ID ??
        "",
    ).trim();
    const inline = String(
      this.privateKey ??
        process.env.PREVIEW_CONTROL_GITHUB_APP_PRIVATE_KEY ??
        "",
    )
      .trim()
      .replace(/\\n/g, "\n");
    const keyFile = String(
      this.privateKeyFile ??
        process.env.PREVIEW_CONTROL_GITHUB_APP_PRIVATE_KEY_FILE ??
        "",
    ).trim();
    const privateKey =
      inline || (keyFile ? (await readFile(keyFile, "utf8")).trim() : "");
    if (
      !POSITIVE_INTEGER.test(appId) ||
      !POSITIVE_INTEGER.test(installationId) ||
      !privateKey
    ) {
      throw new Error(
        "workflow-builder preview gate GitHub App credentials are not configured",
      );
    }
    const response = await this.fetch(
      `${this.apiBaseUrl}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubAppJwt(appId, privateKey, this.now())}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          repositories: ["workflow-builder"],
          permissions: {
            contents: "read",
            pull_requests: "read",
            statuses: "write",
          },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.token !== "string" || !body.token.trim()) {
      throw new Error(
        typeof body.message === "string"
          ? body.message
          : `GitHub App token exchange failed (HTTP ${response.status})`,
      );
    }
    return body.token.trim();
  }
}
