import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Agent as UndiciAgent, Pool } from "undici";
import { env } from "$env/dynamic/private";
import type {
  PreviewControlEnvironmentInspectionPort,
  PreviewControlEnvironmentRecord,
  PreviewControlGitDiffPort,
  PreviewControlGitSourceVerificationPort,
  PreviewControlPullRequestInspectionPort,
  PreviewAcceptanceBrokerPort,
  PreviewAcceptanceCommitStatusPort,
  PreviewAcceptanceResponseCatalogPort,
  PreviewAcceptanceBrokerRequest,
  PreviewAcceptanceBrokerResult,
  PreviewDevelopmentBrokerRequest,
  PreviewDevelopmentBrokerResult,
  PreviewDevelopmentBuildBrokerPort,
  PreviewInfrastructureCandidateBrokerPort,
  PreviewInfrastructureCandidateBrokerRequest,
  PreviewInfrastructureCandidateBrokerResult,
  PreviewSourcePromotionBrokerPort,
  PreviewSourcePromotionBrokerRequest,
  PreviewSourcePromotionResult,
  PreviewArtifactTransferPort,
  PreviewLocalControlIdentityPort,
  PreviewGitHubInstallationTokenPort,
  PreviewGateBaseCatalogPort,
  PreviewGateCatalogSnapshot,
  VclusterPreviewGatewayPort,
} from "$lib/server/application/ports";
import {
  localPreviewControlCapability,
  localPreviewControlIdentity,
  type PreviewControlIdentity,
} from "$lib/server/preview-control-capability";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SAFE_GITHUB_HEAD_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const MAX_COMMIT_CHANGED_PATHS = 3_000;

export class EnvironmentPreviewLocalControlIdentityAdapter implements PreviewLocalControlIdentityPort {
  current(expectedName?: string): PreviewControlIdentity {
    return localPreviewControlIdentity(expectedName);
  }
}

export class VclusterPreviewControlEnvironmentAdapter implements PreviewControlEnvironmentInspectionPort {
  constructor(private readonly gateway: VclusterPreviewGatewayPort) {}

  async inspect(name: string): Promise<PreviewControlEnvironmentRecord> {
    const preview = await this.gateway.get(name);
    return Object.freeze({
      name: preview.name,
      exists: preview.phase !== "absent",
      ready: preview.ready,
      owner: preview.owner?.id ?? null,
      profile: preview.profile,
      mode: preview.mode,
      trustedCode: preview.trustedCode === true,
      platformRevision: preview.platformRevision,
      sourceRevision: preview.sourceRevision,
      catalogDigest: preview.catalogDigest,
      services: Object.freeze([...(preview.services ?? [])]),
      provenance: parseProvenance(preview.provenance),
    });
  }
}

function parseProvenance(value: Record<string, unknown> | null) {
  if (
    !value ||
    typeof value.requestId !== "string" ||
    typeof value.requestedAt !== "string" ||
    typeof value.platformRepository !== "string" ||
    typeof value.sourceRepository !== "string" ||
    (value.parentEnvironmentId !== undefined &&
      value.parentEnvironmentId !== null &&
      typeof value.parentEnvironmentId !== "string")
  ) {
    return null;
  }
  return Object.freeze({
    requestId: value.requestId,
    requestedAt: value.requestedAt,
    platformRepository: value.platformRepository,
    sourceRepository: value.sourceRepository,
    ...(value.parentEnvironmentId !== undefined
      ? { parentEnvironmentId: value.parentEnvironmentId as string | null }
      : {}),
  });
}

export type GithubPreviewControlSourceOptions = Readonly<{
  token?: () => string | null | Promise<string | null>;
  credentials?: PreviewGitHubInstallationTokenPort;
  fetch?: typeof globalThis.fetch;
  baseBranch?: string;
}>;

/** Resolve the server-created branch through GitHub before any build is admitted. */
export class GithubPreviewControlSourceAdapter implements PreviewControlGitSourceVerificationPort, PreviewControlGitDiffPort {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    private readonly options: GithubPreviewControlSourceOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async verifyBranch(input: {
    repository: string;
    branch: string;
    commitSha: string;
    baseBranch: string;
    baseRevision: string;
    expectedBaseSnapshot?: string;
    expectedChangedPaths?: readonly string[];
  }): Promise<boolean> {
    const token = await previewGithubToken(this.options);
    const headers = githubHeaders(token);
    const read = async (
      path: string,
    ): Promise<Record<string, unknown> | null> => {
      const response = await this.fetchImpl(
        `https://api.github.com/repos/${input.repository}/${path}`,
        { headers, signal: AbortSignal.timeout(15_000) },
      );
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(
          `GitHub branch verification failed (HTTP ${response.status})`,
        );
      }
      const body = await response.json();
      return body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    };
    const [candidateRef, baseRef, candidateCommit] = await Promise.all([
      read(`git/ref/heads/${encodeURIComponent(input.branch)}`),
      read(`git/ref/heads/${encodeURIComponent(input.baseBranch)}`),
      read(`git/commits/${input.commitSha}`),
    ]);
    if (!candidateRef || !baseRef || !candidateCommit) return false;
    const candidateObject = candidateRef.object as
      | Record<string, unknown>
      | undefined;
    const baseObject = baseRef.object as Record<string, unknown> | undefined;
    const parents = candidateCommit.parents;
    if (
      candidateObject?.sha !== input.commitSha ||
      typeof baseObject?.sha !== "string" ||
      !Array.isArray(parents) ||
      parents.length !== 1 ||
      (parents[0] as Record<string, unknown> | undefined)?.sha !==
        input.baseRevision
    ) {
      return false;
    }
    const observedBaseHead = baseObject.sha;
    const descendsFrom = async (
      ancestor: string,
      descendant: string,
    ): Promise<boolean> => {
      if (ancestor === descendant) return true;
      const comparison = await read(`compare/${ancestor}...${descendant}`);
      const mergeBase = comparison?.merge_base_commit as
        | Record<string, unknown>
        | undefined;
      return comparison?.status === "ahead" && mergeBase?.sha === ancestor;
    };
    const expectedBaseSnapshot =
      input.expectedBaseSnapshot ?? observedBaseHead;
    if (
      !(await descendsFrom(input.baseRevision, expectedBaseSnapshot)) ||
      !(await descendsFrom(expectedBaseSnapshot, observedBaseHead))
    ) {
      return false;
    }
    if (input.expectedChangedPaths !== undefined) {
      const expected = normalizeChangedPaths(input.expectedChangedPaths);
      if (!expected) return false;
      const actual = await this.commitChangedPaths(
        input.repository,
        input.commitSha,
        headers,
      );
      if (!actual || !sameStrings(actual, expected)) return false;
    }
    if (
      input.expectedChangedPaths !== undefined ||
      input.expectedBaseSnapshot !== undefined
    ) {
      const [finalCandidateRef, finalBaseRef] = await Promise.all([
        read(`git/ref/heads/${encodeURIComponent(input.branch)}`),
        input.expectedBaseSnapshot !== undefined
          ? read(`git/ref/heads/${encodeURIComponent(input.baseBranch)}`)
          : Promise.resolve(null),
      ]);
      const finalCandidate = finalCandidateRef?.object as
        | Record<string, unknown>
        | undefined;
      const finalBase = finalBaseRef?.object as
        | Record<string, unknown>
        | undefined;
      if (
        finalCandidate?.sha !== input.commitSha ||
        (input.expectedBaseSnapshot !== undefined &&
          finalBase?.sha !== observedBaseHead)
      ) {
        return false;
      }
    }
    return true;
  }

  async readCommitDiff(input: {
    repository: string;
    baseRevision: string;
    commitSha: string;
    expectedChangedPaths: readonly string[];
  }): Promise<string | null> {
    const expected = normalizeChangedPaths(input.expectedChangedPaths);
    if (!expected) return null;
    const token = await previewGithubToken(this.options);
    const headers = {
      ...githubHeaders(token),
      Accept: "application/vnd.github.diff",
    };
    const response = await this.fetchImpl(
      `https://api.github.com/repos/${input.repository}/compare/${input.baseRevision}...${input.commitSha}`,
      { headers, signal: AbortSignal.timeout(15_000) },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`GitHub commit diff read failed (HTTP ${response.status})`);
    }
    const patch = await response.text();
    return patch.trim() ? patch : null;
  }

  private async commitChangedPaths(
    repository: string,
    commitSha: string,
    headers: Record<string, string>,
  ): Promise<readonly string[] | null> {
    const paths: string[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 31; page += 1) {
      const response = await this.fetchImpl(
        `https://api.github.com/repos/${repository}/commits/${commitSha}?per_page=100&page=${page}`,
        { headers, signal: AbortSignal.timeout(15_000) },
      );
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(
          `GitHub commit diff verification failed (HTTP ${response.status})`,
        );
      }
      const body = (await response.json()) as Record<string, unknown>;
      if (body.sha !== commitSha || !Array.isArray(body.files)) return null;
      for (const entry of body.files) {
        const filename = (entry as Record<string, unknown> | null)?.filename;
        if (
          typeof filename !== "string" ||
          !isNormalizedChangedPath(filename) ||
          seen.has(filename)
        ) {
          return null;
        }
        seen.add(filename);
        paths.push(filename);
        if (paths.length > MAX_COMMIT_CHANGED_PATHS) return null;
      }
      const hasNext = /<[^>]+>;\s*rel="next"/.test(
        response.headers.get("link") ?? "",
      );
      if (!hasNext) return Object.freeze(paths);
      if (page === 30) return null;
    }
    return null;
  }
}

function normalizeChangedPaths(
  value: readonly string[],
): readonly string[] | null {
  if (
    value.length === 0 ||
    value.length > MAX_COMMIT_CHANGED_PATHS ||
    value.some((path) => !isNormalizedChangedPath(path))
  ) {
    return null;
  }
  const unique = new Set(value);
  return unique.size === value.length
    ? Object.freeze([...unique].sort())
    : null;
}

function isNormalizedChangedPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1_024 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Physical-broker GitHub adapter: exact open PR identity plus complete changed-file pagination. */
export class GithubPreviewControlPullRequestAdapter implements PreviewControlPullRequestInspectionPort {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    private readonly options: GithubPreviewControlSourceOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async inspect(input: {
    repository: string;
    number: number;
    baseSha: string;
    headSha: string;
  }) {
    const pull = await this.inspectOpen(input);
    if (pull.baseSha !== input.baseSha || pull.headSha !== input.headSha) {
      throw new Error(
        "GitHub pull request repo/base/head identity does not match",
      );
    }
    return pull;
  }

  async inspectOpen(input: { repository: string; number: number }) {
    const headers = githubHeaders(await previewGithubToken(this.options));
    const response = await this.fetchImpl(
      `https://api.github.com/repos/${input.repository}/pulls/${input.number}`,
      { headers, signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub pull request verification failed (HTTP ${response.status})`,
      );
    }
    const pull = (await response.json()) as Record<string, unknown>;
    const base = pull.base as Record<string, unknown> | undefined;
    const head = pull.head as Record<string, unknown> | undefined;
    const baseRepository = base?.repo as Record<string, unknown> | undefined;
    const headRepository = head?.repo as Record<string, unknown> | undefined;
    const declaredChangedFiles = pull.changed_files;
    if (
      pull.state !== "open" ||
      typeof pull.draft !== "boolean" ||
      base?.ref !== (this.options.baseBranch ?? "main") ||
      baseRepository?.full_name !== input.repository ||
      headRepository?.full_name !== input.repository
    ) {
      throw new Error(
        "GitHub pull request repo/base/head identity does not match",
      );
    }
    if (
      typeof declaredChangedFiles !== "number" ||
      !Number.isSafeInteger(declaredChangedFiles) ||
      declaredChangedFiles < 1 ||
      declaredChangedFiles > 3_000
    ) {
      throw new Error(
        "GitHub pull request changed-file count is invalid or unsupported",
      );
    }
    const baseSha = typeof base?.sha === "string" ? base.sha : "";
    const headRef = typeof head?.ref === "string" ? head.ref : "";
    const headSha = typeof head?.sha === "string" ? head.sha : "";
    if (
      !FULL_SHA.test(baseSha) ||
      !isSafeGithubHeadRef(headRef) ||
      !FULL_SHA.test(headSha)
    ) {
      throw new Error("GitHub pull request returned invalid commit identity");
    }

    const changedPaths = new Set<string>();
    let observedFiles = 0;
    for (let page = 1; page <= 30; page += 1) {
      const filesResponse = await this.fetchImpl(
        `https://api.github.com/repos/${input.repository}/pulls/${input.number}/files?per_page=100&page=${page}`,
        { headers, signal: AbortSignal.timeout(20_000) },
      );
      if (!filesResponse.ok) {
        throw new Error(
          `GitHub pull request files failed (HTTP ${filesResponse.status})`,
        );
      }
      const files = (await filesResponse.json()) as Array<
        Record<string, unknown>
      >;
      if (!Array.isArray(files))
        throw new Error("GitHub returned invalid PR files");
      for (const file of files) {
        if (typeof file.filename !== "string" || !file.filename) {
          throw new Error("GitHub returned an invalid changed path");
        }
        observedFiles += 1;
        changedPaths.add(file.filename);
        if (file.status === "renamed") {
          if (
            typeof file.previous_filename !== "string" ||
            !file.previous_filename
          ) {
            throw new Error(
              "GitHub returned a renamed file without its previous path",
            );
          }
          changedPaths.add(file.previous_filename);
        }
      }
      if (observedFiles > declaredChangedFiles) {
        throw new Error(
          "GitHub PR file pages exceed the declared changed-file count",
        );
      }
      if (files.length < 100) break;
      if (page === 30)
        throw new Error("GitHub PR file list exceeds the supported bound");
    }
    if (observedFiles !== declaredChangedFiles) {
      throw new Error("GitHub PR file pages are incomplete");
    }
    return Object.freeze({
      repository: input.repository,
      number: input.number,
      draft: pull.draft as boolean,
      baseSha: baseSha as never,
      headRef,
      headSha: headSha as never,
      changedPaths: Object.freeze([...changedPaths]),
    });
  }
}

const PREVIEW_GATE_CATALOG_PATH =
  "services/shared/dev-preview-service-catalog.json";

/** Reads and verifies the base-owned catalog digest before aggregate reconciliation. */
export class GithubPreviewGateBaseCatalogAdapter implements PreviewGateBaseCatalogPort {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    private readonly options: GithubPreviewControlSourceOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async loadAt(input: {
    repository: string;
    baseSha: string;
  }): Promise<PreviewGateCatalogSnapshot> {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
      !FULL_SHA.test(input.baseSha)
    ) {
      throw new Error("preview base catalog identity is invalid");
    }
    const token = await previewGithubToken(this.options);
    if (!token)
      throw new Error("preview control GitHub App token is not configured");
    const response = await this.fetchImpl(
      `https://api.github.com/repos/${input.repository}/contents/${PREVIEW_GATE_CATALOG_PATH}?ref=${input.baseSha}`,
      {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub base catalog read failed (HTTP ${response.status})`,
      );
    }
    const body = (await response.json()) as Record<string, unknown>;
    const encoded =
      body.encoding === "base64" && typeof body.content === "string"
        ? body.content.replace(/\s/g, "")
        : "";
    if (!encoded || encoded.length > 2_000_000) {
      throw new Error("GitHub returned an invalid base catalog document");
    }
    let catalog: Record<string, unknown>;
    try {
      const parsed = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf8"),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("catalog is not an object");
      }
      catalog = parsed as Record<string, unknown>;
    } catch {
      throw new Error("GitHub returned an invalid base catalog document");
    }
    const claimed = catalog.catalogDigest;
    const { catalogDigest: _ignored, ...payload } = catalog;
    const computed = `sha256:${createHash("sha256")
      .update(JSON.stringify(canonicalizeJson(payload)))
      .digest("hex")}`;
    const services = catalog.services;
    const pathPolicy = catalog.pathPolicy as
      | Record<string, unknown>
      | undefined;
    const ignoredPathPrefixes = pathPolicy?.ignoredPathPrefixes;
    const unsupportedPathPrefixes = pathPolicy?.unsupportedPathPrefixes;
    if (
      catalog.schemaVersion !== 3 ||
      catalog.source !== "src/lib/server/workflows/dev-preview-registry.ts" ||
      !Array.isArray(services) ||
      services.length === 0 ||
      !Array.isArray(ignoredPathPrefixes) ||
      ignoredPathPrefixes.length === 0 ||
      !Array.isArray(unsupportedPathPrefixes) ||
      unsupportedPathPrefixes.length === 0 ||
      pathPolicy?.unmatchedPathPolicy !== "unsupported" ||
      typeof claimed !== "string" ||
      !SHA256.test(claimed) ||
      claimed !== computed
    ) {
      throw new Error("base preview catalog digest is invalid");
    }
    const normalizedIgnored = validateCatalogPathPrefixes(
      ignoredPathPrefixes,
      "ignored",
    );
    const normalizedUnsupported = validateCatalogPathPrefixes(
      unsupportedPathPrefixes,
      "unsupported",
    );
    if (
      normalizedIgnored.some((ignored) =>
        normalizedUnsupported.some(
          (unsupported) =>
            matchesCatalogPath(ignored, unsupported) ||
            matchesCatalogPath(unsupported, ignored),
        ),
      )
    ) {
      throw new Error("base preview catalog path policy is ambiguous");
    }
    const seen = new Set<string>();
    const normalized = services.map((value) => {
      const descriptor = value as Record<string, unknown> | null;
      const service = descriptor?.service;
      const source = descriptor?.source as Record<string, unknown> | undefined;
      const capabilities = descriptor?.capabilities as
        | Record<string, unknown>
        | undefined;
      const changedPaths = source?.changedPaths;
      const acceptanceBuild = capabilities?.acceptanceBuild;
      const acceptanceReplay = capabilities?.acceptanceReplay;
      const activationBuild = capabilities?.activationBuild;
      if (
        typeof service !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(service) ||
        seen.has(service) ||
        source?.repository !== input.repository ||
        !Array.isArray(changedPaths) ||
        changedPaths.length === 0 ||
        changedPaths.some(
          (path) => typeof path !== "string" || !isNormalizedChangedPath(path),
        ) ||
        new Set(changedPaths).size !== changedPaths.length ||
        typeof acceptanceBuild !== "boolean" ||
        typeof acceptanceReplay !== "boolean" ||
        typeof activationBuild !== "boolean" ||
        acceptanceBuild !== (descriptor?.acceptance !== null) ||
        (acceptanceReplay && !acceptanceBuild) ||
        activationBuild !== (descriptor?.activation !== null)
      ) {
        throw new Error("base preview catalog service mapping is invalid");
      }
      seen.add(service);
      return Object.freeze({
        service,
        changedPaths: Object.freeze([...(changedPaths as string[])]),
        acceptanceBuild,
        acceptanceReplay,
        activationBuild,
      });
    });
    return Object.freeze({
      catalogDigest: claimed as `sha256:${string}`,
      pathPolicy: Object.freeze({
        ignoredPathPrefixes: Object.freeze(normalizedIgnored),
        unsupportedPathPrefixes: Object.freeze(normalizedUnsupported),
        unmatchedPathPolicy: "unsupported" as const,
      }),
      services: Object.freeze(normalized),
    });
  }
}

function validateCatalogPathPrefixes(
  values: unknown[],
  kind: string,
): string[] {
  if (
    values.some(
      (value) => typeof value !== "string" || !isNormalizedChangedPath(value),
    ) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`base preview catalog ${kind} path policy is invalid`);
  }
  return [...(values as string[])].sort();
}

function matchesCatalogPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeJson(child)]),
    );
  }
  return value;
}

export type GithubPreviewAcceptanceCommitStatusOptions = Readonly<{
  token?: () => string | null | Promise<string | null>;
  credentials?: PreviewGitHubInstallationTokenPort;
  fetch?: typeof globalThis.fetch;
  apiBaseUrl?: string;
  attestationRoot?: () => string | null;
}>;

/** Publish a bounded preview status only after the broker verifies the exact open PR tuple. */
export class GithubPreviewAcceptanceCommitStatusAdapter implements PreviewAcceptanceCommitStatusPort {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly apiBaseUrl: string;

  constructor(
    private readonly options: GithubPreviewAcceptanceCommitStatusOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(
      /\/+$/,
      "",
    );
  }

  async publish(
    input: Parameters<PreviewAcceptanceCommitStatusPort["publish"]>[0],
  ): Promise<void> {
    const subordinate = input.context !== "preview/gate";
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
      !Number.isSafeInteger(input.pullRequestNumber) ||
      input.pullRequestNumber < 1 ||
      !FULL_SHA.test(input.baseSha) ||
      !FULL_SHA.test(input.headSha) ||
      input.baseSha === input.headSha ||
      !(
        "preview/gate" === input.context ||
        "preview/immutable-acceptance" === input.context ||
        "preview/activation-images" === input.context
      ) ||
      !(["pending", "success", "failure", "error"] as const).includes(
        input.state,
      ) ||
      !input.description ||
      input.description.length > 140 ||
      /[\u0000-\u001f\u007f]/.test(input.description) ||
      (subordinate && !SHA256.test(input.requirementDigest ?? "")) ||
      (subordinate &&
        input.state === "success" &&
        !SHA256.test(input.evidenceReceiptDigest ?? "")) ||
      (subordinate &&
        input.state !== "success" &&
        input.evidenceReceiptDigest !== undefined) ||
      (!subordinate &&
        (input.requirementDigest !== undefined ||
          input.evidenceReceiptDigest !== undefined))
    ) {
      throw new Error("preview acceptance commit status is invalid");
    }
    const token = await previewGithubToken(this.options);
    if (!token)
      throw new Error("preview control GitHub App token is not configured");
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/repos/${input.repository}/statuses/${input.headSha}`,
      {
        method: "POST",
        headers: {
          ...githubHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state: input.state,
          context: input.context,
          description: input.description,
          target_url: statusTargetUrl(input, this.options),
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      throw new Error(
        typeof body.message === "string"
          ? body.message
          : `GitHub acceptance commit status failed (HTTP ${response.status})`,
      );
    }
  }

  async latest(
    input: Parameters<PreviewAcceptanceCommitStatusPort["latest"]>[0],
  ): ReturnType<PreviewAcceptanceCommitStatusPort["latest"]> {
    const requested = new Set(input.contexts);
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
      !Number.isSafeInteger(input.pullRequestNumber) ||
      input.pullRequestNumber < 1 ||
      !FULL_SHA.test(input.baseSha) ||
      !FULL_SHA.test(input.headSha) ||
      input.baseSha === input.headSha ||
      requested.size !== input.contexts.length ||
      [...requested].some(
        (context) =>
          context !== "preview/immutable-acceptance" &&
          context !== "preview/activation-images",
      ) ||
      [...requested].some(
        (context) => !SHA256.test(input.requirementDigests[context] ?? ""),
      )
    ) {
      throw new Error("preview status observation tuple is invalid");
    }
    const observed = {
      "preview/immutable-acceptance": null,
      "preview/activation-images": null,
    } as Record<
      "preview/immutable-acceptance" | "preview/activation-images",
      "pending" | "success" | "failure" | "error" | null
    >;
    if (requested.size === 0) return Object.freeze(observed);
    const token = await previewGithubToken(this.options);
    if (!token)
      throw new Error("preview control GitHub App token is not configured");
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.fetchImpl(
        `${this.apiBaseUrl}/repos/${input.repository}/commits/${input.headSha}/statuses?per_page=100&page=${page}`,
        {
          headers: githubHeaders(token),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) {
        throw new Error(
          `GitHub commit status observation failed (HTTP ${response.status})`,
        );
      }
      const statuses = (await response.json()) as Array<
        Record<string, unknown>
      >;
      if (!Array.isArray(statuses))
        throw new Error("GitHub returned invalid commit statuses");
      for (const status of statuses) {
        const context = status.context;
        if (typeof status.sha === "string" && status.sha !== input.headSha) {
          throw new Error("GitHub returned a status for a different head SHA");
        }
        if (
          (context === "preview/immutable-acceptance" ||
            context === "preview/activation-images") &&
          requested.has(context)
        ) {
          const state = status.state;
          if (state === "pending" && observed[context] === null) {
            // Pending from the trusted initializer is provisional. An older
            // signed terminal result for this immutable tuple remains valid.
            observed[context] = state;
          } else if (
            (observed[context] === null || observed[context] === "pending") &&
            (state === "success" || state === "failure" || state === "error") &&
            verifiesStatusAttestation(
              input,
              context,
              state,
              status.description,
              status.target_url,
              input.requirementDigests[context],
              input.evidenceReceiptDigests[context],
              this.options,
            )
          ) {
            observed[context] = state;
          }
        }
      }
      if (
        [...requested].every(
          (context) =>
            observed[context] === "success" ||
            observed[context] === "failure" ||
            observed[context] === "error",
        )
      )
        break;
      if (statuses.length < 100) break;
      if (page === 10)
        throw new Error(
          "GitHub commit status history exceeds the supported bound",
        );
    }
    return Object.freeze(observed);
  }
}

function statusAttestationRoot(
  options: GithubPreviewAcceptanceCommitStatusOptions,
): string {
  return (
    options.attestationRoot?.() ??
    env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
    process.env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
    ""
  ).trim();
}

function statusAttestation(
  input: {
    repository: string;
    pullRequestNumber: number;
    baseSha: string;
    headSha: string;
    context: string;
    state: string;
    description: string;
    requirementDigest?: string;
    evidenceReceiptDigest?: string;
  },
  options: GithubPreviewAcceptanceCommitStatusOptions,
): string {
  const root = statusAttestationRoot(options);
  if (root.length < 32) {
    throw new Error("preview status attestation root is not configured");
  }
  const key = createHmac("sha256", root)
    .update("preview-status-attestation-v2")
    .digest();
  return createHmac("sha256", key)
    .update(
      [
        input.repository,
        String(input.pullRequestNumber),
        input.baseSha,
        input.headSha,
        input.context,
        input.state,
        input.description,
        input.requirementDigest ?? "",
        input.evidenceReceiptDigest ?? "",
      ].join("\0"),
    )
    .digest("hex");
}

function statusTargetUrl(
  input: Parameters<PreviewAcceptanceCommitStatusPort["publish"]>[0],
  options: GithubPreviewAcceptanceCommitStatusOptions,
): string {
  const url = new URL(
    `https://github.com/${input.repository}/pull/${input.pullRequestNumber}`,
  );
  if (input.context !== "preview/gate") {
    url.searchParams.set(
      "preview_attestation",
      `v2.${statusAttestation(input, options)}`,
    );
  }
  return url.toString();
}

function verifiesStatusAttestation(
  input: Parameters<PreviewAcceptanceCommitStatusPort["latest"]>[0],
  context: "preview/immutable-acceptance" | "preview/activation-images",
  state: "success" | "failure" | "error",
  description: unknown,
  targetUrl: unknown,
  requirementDigest: `sha256:${string}` | null,
  evidenceReceiptDigest: `sha256:${string}` | null,
  options: GithubPreviewAcceptanceCommitStatusOptions,
): boolean {
  if (
    typeof description !== "string" ||
    typeof targetUrl !== "string" ||
    !SHA256.test(requirementDigest ?? "")
  )
    return false;
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }
  const actual = url.searchParams.get("preview_attestation") ?? "";
  if (
    url.origin !== "https://github.com" ||
    url.pathname !== `/${input.repository}/pull/${input.pullRequestNumber}` ||
    [...url.searchParams.keys()].some((key) => key !== "preview_attestation") ||
    !/^v2\.[0-9a-f]{64}$/.test(actual)
  ) {
    return false;
  }
  let expected: string;
  try {
    const boundReceipt = state === "success" ? evidenceReceiptDigest : null;
    if (state === "success" && !SHA256.test(boundReceipt ?? "")) return false;
    expected = `v2.${statusAttestation(
      {
        ...input,
        context,
        state,
        description,
        requirementDigest: requirementDigest ?? undefined,
        evidenceReceiptDigest: boundReceipt ?? undefined,
      },
      options,
    )}`;
  } catch {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function isSafeGithubHeadRef(value: string): boolean {
  if (
    !SAFE_GITHUB_HEAD_REF.test(value) ||
    value === "@" ||
    value.startsWith(".") ||
    value.endsWith(".") ||
    value.endsWith("/") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{")
  ) {
    return false;
  }
  return value.split("/").every((part) => !part.endsWith(".lock"));
}

async function previewGithubToken(
  options: Pick<GithubPreviewControlSourceOptions, "token" | "credentials">,
): Promise<string> {
  const token = options.credentials
    ? await options.credentials.token()
    : await options.token?.();
  return token?.trim() ?? "";
}

function githubHeaders(explicitToken?: string | null): Record<string, string> {
  const token = explicitToken?.trim() ?? "";
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export type HttpPreviewDevelopmentBuildBrokerOptions = Readonly<{
  baseUrl?: () => string | null;
  token?: () => string | null;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  identity?: (expectedName?: string) => PreviewControlIdentity;
  artifacts?: PreviewArtifactTransferPort;
  sourceRepository?: string;
}>;

export type HttpPreviewInfrastructureCandidateBrokerOptions =
  HttpPreviewDevelopmentBuildBrokerOptions &
    Readonly<{ platformRepository?: string }>;

export type HttpPreviewAcceptanceBrokerOptions =
  HttpPreviewDevelopmentBuildBrokerOptions &
    Readonly<{ catalog: PreviewAcceptanceResponseCatalogPort }>;

function brokerConnection(options: HttpPreviewDevelopmentBuildBrokerOptions) {
  const baseUrl = (
    options.baseUrl?.() ??
    env.PREVIEW_CONTROL_BROKER_URL ??
    process.env.PREVIEW_CONTROL_BROKER_URL ??
    ""
  )
    .trim()
    .replace(/\/+$/, "");
  const token = (
    options.token?.() ??
    env.PREVIEW_CONTROL_BROKER_TOKEN ??
    process.env.PREVIEW_CONTROL_BROKER_TOKEN ??
    ""
  ).trim();
  if (!baseUrl) throw new Error("PREVIEW_CONTROL_BROKER_URL is not configured");
  if (!token) throw new Error("PREVIEW_CONTROL_BROKER_TOKEN is not configured");
  return { baseUrl, token };
}

/** Preview-local adapter; it owns no Kubernetes or Tekton credentials. */
export class HttpPreviewDevelopmentBuildBrokerAdapter implements PreviewDevelopmentBuildBrokerPort {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    private readonly options: HttpPreviewDevelopmentBuildBrokerOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async build(
    input: PreviewDevelopmentBrokerRequest,
  ): Promise<PreviewDevelopmentBrokerResult> {
    const baseUrl = (
      this.options.baseUrl?.() ??
      env.PREVIEW_CONTROL_BROKER_URL ??
      process.env.PREVIEW_CONTROL_BROKER_URL ??
      ""
    )
      .trim()
      .replace(/\/+$/, "");
    const token = (
      this.options.token?.() ?? localPreviewControlCapability()
    ).trim();
    const identity = (this.options.identity ?? localPreviewControlIdentity)(
      input.previewName,
    );
    if (identity.catalogDigest !== input.catalogDigest) {
      throw new Error("preview control catalog identity changed");
    }
    if (!this.options.artifacts) {
      throw new Error("preview artifact transfer is not configured");
    }
    const transferred = await this.options.artifacts.transfer({
      identity,
      executionId: input.executionId,
      artifactId: input.artifactId,
    });
    const imported = transferred.importIdentity;
    if (
      imported.previewName !== identity.previewName ||
      imported.requestId !== identity.environmentRequestId ||
      imported.executionId !== input.executionId ||
      imported.sourceArtifactId !== input.artifactId ||
      imported.platformRevision !== identity.environmentPlatformRevision ||
      imported.sourceRevision !== identity.environmentSourceRevision ||
      imported.catalogDigest !== identity.catalogDigest ||
      !sameStringSets(imported.services, input.services)
    ) {
      throw new Error(
        "imported artifact identity does not match the build request",
      );
    }
    const command = {
      ...input,
      artifactId: transferred.id,
      artifactIdentity: transferred.importIdentity,
      environmentRequestId: identity.environmentRequestId,
      environmentPlatformRevision: identity.environmentPlatformRevision,
      environmentSourceRevision: identity.environmentSourceRevision,
    };
    if (!baseUrl) {
      throw new Error("PREVIEW_CONTROL_BROKER_URL is not configured");
    }
    if (!token) {
      throw new Error("PREVIEW_CONTROL_BROKER_TOKEN is not configured");
    }
    const response = await this.fetchImpl(
      `${baseUrl}/api/internal/preview-control/development-build`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Control-Capability": token,
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 46 * 60_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : `preview control broker failed (HTTP ${response.status})`,
      );
    }
    return validateBrokerResult(body, command);
  }
}

/** Preview-local PR handoff. GitHub and Git execution stay behind the broker. */
export class HttpPreviewSourcePromotionBrokerAdapter implements PreviewSourcePromotionBrokerPort {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    private readonly options: HttpPreviewDevelopmentBuildBrokerOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async promote(
    input: PreviewSourcePromotionBrokerRequest,
  ): Promise<PreviewSourcePromotionResult> {
    const baseUrl = (
      this.options.baseUrl?.() ??
      env.PREVIEW_CONTROL_BROKER_URL ??
      process.env.PREVIEW_CONTROL_BROKER_URL ??
      ""
    )
      .trim()
      .replace(/\/+$/, "");
    const token = (
      this.options.token?.() ?? localPreviewControlCapability()
    ).trim();
    const identity = (this.options.identity ?? localPreviewControlIdentity)(
      input.previewName,
    );
    if (
      identity.environmentRequestId !== input.environmentRequestId ||
      identity.environmentPlatformRevision !==
        input.environmentPlatformRevision ||
      identity.environmentSourceRevision !== input.environmentSourceRevision ||
      identity.catalogDigest !== input.catalogDigest
    ) {
      throw new Error("preview source promotion identity changed");
    }
    if (!baseUrl)
      throw new Error("PREVIEW_CONTROL_BROKER_URL is not configured");
    if (!token)
      throw new Error("PREVIEW_CONTROL_BROKER_TOKEN is not configured");
    const response = await this.fetchImpl(
      `${baseUrl}/api/internal/preview-control/promotion`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Control-Capability": token,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10 * 60_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : `preview source promotion failed (HTTP ${response.status})`,
      );
    }
    const pullRequest = record(body.pullRequest);
    const expectedRepository =
      this.options.sourceRepository ?? "PittampalliOrg/workflow-builder";
    const expectedPullRequestUrl = pullRequest
      ? `https://github.com/${expectedRepository}/pull/${String(pullRequest.number)}`
      : "";
    const services = canonicalCapturedServiceSubset(
      body.services,
      input.artifactIdentity.services,
    );
    if (
      body.ok !== true ||
      typeof body.receiptId !== "string" ||
      !/^pspr_[0-9a-f]{64}$/.test(body.receiptId) ||
      body.previewName !== input.previewName ||
      body.requestId !== input.environmentRequestId ||
      body.executionId !== input.executionId ||
      body.artifactId !== input.artifactId ||
      typeof body.branch !== "string" ||
      !/^preview-feature-[0-9a-f]{32}$/.test(body.branch) ||
      !FULL_SHA.test(String(body.commitSha)) ||
      typeof body.prUrl !== "string" ||
      !pullRequest ||
      pullRequest.repository !== expectedRepository ||
      !Number.isSafeInteger(pullRequest.number) ||
      Number(pullRequest.number) < 1 ||
      !FULL_SHA.test(String(pullRequest.baseSha)) ||
      pullRequest.baseSha === body.commitSha ||
      pullRequest.headSha !== body.commitSha ||
      body.prUrl !== expectedPullRequestUrl ||
      body.draft !== input.draft ||
      !services
    ) {
      throw new Error("preview source promotion broker returned invalid proof");
    }
    return Object.freeze({
      ok: true,
      receiptId: body.receiptId,
      previewName: body.previewName,
      requestId: body.requestId,
      executionId: body.executionId,
      artifactId: body.artifactId,
      services,
      branch: body.branch,
      commitSha: body.commitSha as never,
      prUrl: body.prUrl,
      pullRequest: Object.freeze({
        repository: pullRequest.repository as string,
        number: pullRequest.number as number,
        baseSha: pullRequest.baseSha as never,
        headSha: pullRequest.headSha as never,
      }),
      draft: body.draft,
    });
  }
}

function canonicalCapturedServiceSubset(
  value: unknown,
  capturedServices: readonly string[],
): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const captured = new Set(capturedServices);
  const services: string[] = [];
  let previous: string | null = null;
  for (const service of value) {
    if (
      typeof service !== "string" ||
      !service ||
      !captured.has(service) ||
      (previous !== null && previous >= service)
    ) {
      return null;
    }
    services.push(service);
    previous = service;
  }
  return Object.freeze(services);
}

/** Normal-BFF client for GitHub-verified infrastructure candidate admission. */
export class HttpPreviewInfrastructureCandidateBrokerAdapter implements PreviewInfrastructureCandidateBrokerPort {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    private readonly options: HttpPreviewInfrastructureCandidateBrokerOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async launch(
    input: PreviewInfrastructureCandidateBrokerRequest,
  ): Promise<PreviewInfrastructureCandidateBrokerResult> {
    const { baseUrl, token } = brokerConnection(this.options);
    const response = await this.fetchImpl(
      `${baseUrl}/api/internal/preview-control/infrastructure-candidate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Control-Broker-Token": token,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20 * 60_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok && response.status !== 409) {
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : `infrastructure candidate broker failed (HTTP ${response.status})`,
      );
    }
    if (response.status === 409 && typeof body.error === "string") {
      throw new Error(body.error);
    }
    return validateInfrastructureCandidateBrokerResult(
      body,
      input,
      this.options.platformRepository ?? "PittampalliOrg/stacks",
      response.status,
    );
  }
}

const previewAcceptanceDispatcher = new UndiciAgent({
  factory: (origin, options) =>
    new Pool(origin, {
      ...options,
      headersTimeout: 0,
      bodyTimeout: 0,
    }),
});

const previewAcceptanceFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, {
    ...init,
    dispatcher: previewAcceptanceDispatcher,
  } as RequestInit);

/** Preview-local acceptance client; all build, GitHub, and cluster authority stays physical. */
export class HttpPreviewAcceptanceBrokerAdapter implements PreviewAcceptanceBrokerPort {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: HttpPreviewAcceptanceBrokerOptions) {
    this.fetchImpl = options.fetch ?? previewAcceptanceFetch;
  }

  async replay(
    input: PreviewAcceptanceBrokerRequest,
  ): Promise<PreviewAcceptanceBrokerResult> {
    const baseUrl = (
      this.options.baseUrl?.() ??
      env.PREVIEW_CONTROL_BROKER_URL ??
      process.env.PREVIEW_CONTROL_BROKER_URL ??
      ""
    )
      .trim()
      .replace(/\/+$/, "");
    const token = (
      this.options.token?.() ?? localPreviewControlCapability()
    ).trim();
    const identity = (this.options.identity ?? localPreviewControlIdentity)(
      input.previewName,
    );
    if (
      (input.environmentRequestId !== undefined &&
        input.environmentRequestId !== identity.environmentRequestId) ||
      (input.environmentPlatformRevision !== undefined &&
        input.environmentPlatformRevision !==
          identity.environmentPlatformRevision) ||
      (input.environmentSourceRevision !== undefined &&
        input.environmentSourceRevision !==
          identity.environmentSourceRevision) ||
      (input.catalogDigest !== undefined &&
        input.catalogDigest !== identity.catalogDigest)
    ) {
      throw new Error("preview acceptance identity changed");
    }
    const command = {
      ...input,
      environmentRequestId: identity.environmentRequestId,
      environmentPlatformRevision: identity.environmentPlatformRevision,
      environmentSourceRevision: identity.environmentSourceRevision,
      catalogDigest: identity.catalogDigest,
    };
    if (!baseUrl)
      throw new Error("PREVIEW_CONTROL_BROKER_URL is not configured");
    if (!token)
      throw new Error("PREVIEW_CONTROL_BROKER_TOKEN is not configured");
    const response = await this.fetchImpl(
      `${baseUrl}/api/internal/preview-control/acceptance`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Control-Capability": token,
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 45 * 60_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok && response.status !== 409 && response.status !== 422) {
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : `preview acceptance broker failed (HTTP ${response.status})`,
      );
    }
    if (response.status === 409 && typeof body.error === "string") {
      throw new Error(body.error);
    }
    return validateAcceptanceBrokerResult(
      body,
      input,
      this.options.catalog,
      response.status,
    );
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactStringSet(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !item) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return value as string[];
}

function validateInfrastructureCandidateBrokerResult(
  body: Record<string, unknown>,
  input: PreviewInfrastructureCandidateBrokerRequest,
  platformRepository: string,
  httpStatus: number,
): PreviewInfrastructureCandidateBrokerResult {
  const pullRequest = record(body.pullRequest);
  const pullPaths = pullRequest
    ? normalizeChangedPaths(
        Array.isArray(pullRequest.changedPaths)
          ? (pullRequest.changedPaths as string[])
          : [],
      )
    : null;
  const changedPaths = normalizeChangedPaths(
    Array.isArray(body.changedPaths) ? (body.changedPaths as string[]) : [],
  );
  if (
    !pullRequest ||
    pullRequest.repository !== platformRepository ||
    pullRequest.number !== input.pullRequestNumber ||
    typeof pullRequest.baseSha !== "string" ||
    !FULL_SHA.test(pullRequest.baseSha) ||
    typeof pullRequest.headSha !== "string" ||
    !FULL_SHA.test(pullRequest.headSha) ||
    pullRequest.baseSha === pullRequest.headSha ||
    typeof pullRequest.headRef !== "string" ||
    !isSafeGithubHeadRef(pullRequest.headRef) ||
    !pullPaths ||
    !changedPaths ||
    !sameStrings(pullPaths, changedPaths)
  ) {
    throw new Error(
      "infrastructure candidate broker returned mismatched pull request proof",
    );
  }

  if (body.status === "operator-required") {
    const action = record(body.operatorAction);
    const management =
      body.profile === "manifest-candidate" && body.lane === "management";
    const host =
      body.profile === "host-candidate" && body.lane === "application";
    const expectedCommand = management
      ? "preview-management-candidate.sh"
      : host
        ? "preview-host-candidate.sh"
        : null;
    const actionPaths = action
      ? normalizeChangedPaths(
          Array.isArray(action.candidatePaths)
            ? (action.candidatePaths as string[])
            : [],
        )
      : null;
    if (
      httpStatus !== 409 ||
      body.ok !== false ||
      body.launch !== null ||
      !expectedCommand ||
      !action ||
      action.command !== expectedCommand ||
      action.id !== input.name ||
      action.revision !== pullRequest.headSha ||
      !actionPaths ||
      !sameStrings(actionPaths, changedPaths)
    ) {
      throw new Error(
        "infrastructure candidate broker returned invalid operator action proof",
      );
    }
    return body as unknown as PreviewInfrastructureCandidateBrokerResult;
  }

  const launch = record(body.launch);
  if (
    body.status !== "launched" ||
    body.profile !== "manifest-candidate" ||
    body.lane !== "application" ||
    body.operatorAction !== undefined ||
    !launch ||
    typeof launch.ok !== "boolean" ||
    body.ok !== launch.ok ||
    httpStatus !== (launch.ok ? 202 : 409)
  ) {
    throw new Error(
      "infrastructure candidate broker returned invalid launch proof",
    );
  }
  if (launch.ok) {
    const environment = record(launch.environment);
    const owner = record(environment?.owner);
    const origin = record(environment?.origin);
    const allocation = record(environment?.allocation);
    const provenance = record(environment?.provenance);
    const runtime = record(environment?.runtime);
    const environmentPaths = normalizeChangedPaths(
      Array.isArray(environment?.candidatePaths)
        ? (environment.candidatePaths as string[])
        : [],
    );
    const capabilities = exactStringSet(environment?.capabilities);
    const services = Array.isArray(environment?.services)
      ? environment.services
      : null;
    const imageOverrides = record(environment?.imageOverrides);
    const expectedParent =
      `pull-request:${platformRepository}#${input.pullRequestNumber}@` +
      pullRequest.headSha;
    if (
      !environment ||
      environment.name !== input.name ||
      environment.id !== input.name ||
      environment.profile !== "manifest-candidate" ||
      environment.lane !== "application" ||
      environment.platformRevision !== pullRequest.headSha ||
      typeof environment.sourceRevision !== "string" ||
      !FULL_SHA.test(environment.sourceRevision) ||
      environment.mode !== "reconciled" ||
      environment.lifecycle !== (input.lifecycle ?? "ephemeral") ||
      environment.ttlHours !== (input.ttlHours ?? 24) ||
      environment.placement !== "dev-vcluster" ||
      !environmentPaths ||
      !sameStrings(environmentPaths, changedPaths) ||
      !capabilities ||
      !sameStrings(capabilities, ["namespaced-manifests"]) ||
      !services ||
      services.length !== 0 ||
      !imageOverrides ||
      Object.keys(imageOverrides).length !== 0 ||
      owner?.kind !== "user" ||
      owner.id !== input.userId ||
      origin?.kind !== "user" ||
      allocation?.kind !== "cold" ||
      Object.keys(allocation).length !== 1 ||
      provenance?.platformRepository !== platformRepository ||
      provenance.parentEnvironmentId !== expectedParent ||
      runtime?.placement !== "dev-vcluster" ||
      typeof environment.catalogDigest !== "string" ||
      !SHA256.test(environment.catalogDigest)
    ) {
      throw new Error(
        "infrastructure candidate broker returned a mismatched environment proof",
      );
    }
  } else if (
    !["capacity", "conflict"].includes(String(launch.reason)) ||
    typeof launch.message !== "string" ||
    !launch.message
  ) {
    throw new Error(
      "infrastructure candidate broker returned an invalid launch failure",
    );
  }
  return body as unknown as PreviewInfrastructureCandidateBrokerResult;
}

const ACCEPTANCE_FAILURE_STAGES = new Set([
  "freshness",
  "build",
  "capacity",
  "readiness",
  "runtime",
  "verification",
  "cleanup",
  "reporting",
]);

const CLEANUP_CHECKS = [
  "runner-succeeded",
  "preview-environment-absent",
  "application-absent",
  "agent-registration-absent",
  "agent-namespaces-absent",
  "database-absent",
  "nats-stream-absent",
  "headlamp-registration-absent",
  "tailnet-egress-absent",
  "host-namespace-absent",
  "storage-scope-absent",
  "runner-identity-absent",
] as const;

export function validateAcceptanceBrokerResult(
  body: Record<string, unknown>,
  input: PreviewAcceptanceBrokerRequest,
  catalog: PreviewAcceptanceResponseCatalogPort,
  httpStatus: number,
): PreviewAcceptanceBrokerResult {
  const expectedName =
    `accept-pr${input.pullRequest.number}-${input.pullRequest.headSha.slice(0, 12)}`.slice(
      0,
      40,
    );
  const pullRequest = record(body.pullRequest);
  const services = exactStringSet(body.services);
  if (
    typeof body.ok !== "boolean" ||
    body.previewName !== input.previewName ||
    body.name !== expectedName ||
    !pullRequest ||
    pullRequest.repository !== input.pullRequest.repository ||
    pullRequest.number !== input.pullRequest.number ||
    pullRequest.baseSha !== input.pullRequest.baseSha ||
    pullRequest.headSha !== input.pullRequest.headSha ||
    !services
  ) {
    throw new Error(
      "preview acceptance broker returned invalid provenance proof",
    );
  }
  let admittedServices: readonly string[];
  try {
    admittedServices = catalog.assertAcceptanceReplayServices(services);
  } catch (cause) {
    throw new Error("preview acceptance broker returned non-catalog services", {
      cause,
    });
  }
  if (!sameStrings(admittedServices, services)) {
    throw new Error(
      "preview acceptance broker returned a different service set",
    );
  }

  const images = validateAcceptanceImages(
    body.images,
    services,
    input.pullRequest.headSha,
    catalog,
  );
  const verification = validateAcceptanceVerification(body.verification);
  const cleanup = validateAcceptanceCleanup(body.cleanup, expectedName);

  if (body.ok) {
    if (
      httpStatus !== 200 ||
      !images ||
      !verification ||
      !verification.ok ||
      !cleanup ||
      !cleanup.complete
    ) {
      throw new Error(
        "preview acceptance broker returned incomplete success proof",
      );
    }
  } else {
    const stage = typeof body.stage === "string" ? body.stage : "";
    if (
      httpStatus !== 422 ||
      !ACCEPTANCE_FAILURE_STAGES.has(stage) ||
      typeof body.message !== "string" ||
      !body.message
    ) {
      throw new Error(
        "preview acceptance broker returned invalid failure proof",
      );
    }
    const launched = [
      "readiness",
      "runtime",
      "verification",
      "cleanup",
    ].includes(stage);
    if (launched && (!images || !cleanup)) {
      throw new Error(
        "preview acceptance broker omitted launched-environment cleanup proof",
      );
    }
    if (["capacity"].includes(stage) && !images) {
      throw new Error("preview acceptance broker omitted build proof");
    }
  }
  return body as unknown as PreviewAcceptanceBrokerResult;
}

function validateAcceptanceImages(
  value: unknown,
  services: readonly string[],
  sourceRevision: string,
  catalog: PreviewAcceptanceResponseCatalogPort,
): readonly Record<string, unknown>[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length !== services.length) {
    throw new Error(
      "preview acceptance broker returned an incomplete image proof",
    );
  }
  const images = value.map(record);
  if (images.some((image) => image === null)) {
    throw new Error(
      "preview acceptance broker returned an invalid image proof",
    );
  }
  const names = images.map((image) => String(image!.service ?? ""));
  if (!sameStrings(names, services) || new Set(names).size !== names.length) {
    throw new Error("preview acceptance broker returned a different image set");
  }
  for (const image of images as Record<string, unknown>[]) {
    const service = String(image.service);
    const repository = catalog.acceptanceImageRepository(service);
    if (
      image.sourceRevision !== sourceRevision ||
      typeof image.buildId !== "string" ||
      !image.buildId ||
      typeof image.digest !== "string" ||
      !SHA256.test(image.digest) ||
      typeof image.imageRef !== "string" ||
      !image.imageRef.startsWith(`${repository}:`) ||
      image.imageRef.includes("@") ||
      image.immutableRef !== `${repository}@${image.digest}`
    ) {
      throw new Error(
        "preview acceptance broker returned an invalid image proof",
      );
    }
  }
  return images as Record<string, unknown>[];
}

function validateAcceptanceVerification(
  value: unknown,
): { ok: boolean } | null {
  if (value === undefined) return null;
  const verification = record(value);
  if (!verification || typeof verification.ok !== "boolean") {
    throw new Error(
      "preview acceptance broker returned invalid verification proof",
    );
  }
  if (!Array.isArray(verification.checks) || verification.checks.length === 0) {
    throw new Error(
      "preview acceptance broker returned empty verification proof",
    );
  }
  const names = new Set<string>();
  let allPassed = true;
  for (const rawCheck of verification.checks) {
    const check = record(rawCheck);
    if (
      !check ||
      typeof check.name !== "string" ||
      !check.name ||
      names.has(check.name) ||
      typeof check.ok !== "boolean" ||
      (check.detail !== undefined && typeof check.detail !== "string")
    ) {
      throw new Error(
        "preview acceptance broker returned invalid verification check",
      );
    }
    names.add(check.name);
    allPassed &&= check.ok;
  }
  if (verification.ok !== allPassed) {
    throw new Error(
      "preview acceptance broker returned inconsistent verification proof",
    );
  }
  return { ok: verification.ok };
}

function validateAcceptanceCleanup(
  value: unknown,
  expectedName: string,
): { complete: boolean } | null {
  if (value === undefined || value === null) return null;
  const cleanup = record(value);
  const checks = record(cleanup?.checks);
  if (
    !cleanup ||
    cleanup.name !== expectedName ||
    cleanup.resourceName !== expectedName ||
    typeof cleanup.complete !== "boolean" ||
    !["pending", "complete", "failed", "timeout"].includes(
      String(cleanup.phase),
    ) ||
    !checks ||
    !sameStrings(Object.keys(checks), CLEANUP_CHECKS) ||
    Object.values(checks).some((check) => typeof check !== "boolean") ||
    (cleanup.message !== null && typeof cleanup.message !== "string")
  ) {
    throw new Error("preview acceptance broker returned invalid cleanup proof");
  }
  const allAbsent = CLEANUP_CHECKS.every((check) => checks[check] === true);
  if (
    cleanup.complete !== allAbsent ||
    (cleanup.complete && cleanup.phase !== "complete") ||
    (!cleanup.complete && cleanup.phase === "complete") ||
    (cleanup.complete && cleanup.message !== null)
  ) {
    throw new Error(
      "preview acceptance broker returned inconsistent cleanup proof",
    );
  }
  return { complete: cleanup.complete };
}

function sameStringSets(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const canonicalLeft = [...left].sort();
  const canonicalRight = [...right].sort();
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index])
  );
}

function validateBrokerResult(
  value: Record<string, unknown>,
  expected: PreviewDevelopmentBrokerRequest,
): PreviewDevelopmentBrokerResult {
  if (
    value.previewName !== expected.previewName ||
    value.catalogDigest !== expected.catalogDigest ||
    (expected.artifactIdentity !== undefined &&
      value.baselineRevision !== expected.artifactIdentity.sourceRevision) ||
    typeof value.branch !== "string" ||
    !/^preview-development-[0-9]{1,20}$/.test(value.branch) ||
    typeof value.sourceRevision !== "string" ||
    !FULL_SHA.test(value.sourceRevision) ||
    typeof value.baselineRevision !== "string" ||
    !FULL_SHA.test(value.baselineRevision) ||
    value.sourceRevision === value.baselineRevision ||
    typeof value.pullRequestBase !== "string" ||
    !Array.isArray(value.changedPaths) ||
    value.changedPaths.length === 0 ||
    new Set(value.changedPaths).size !== value.changedPaths.length ||
    value.changedPaths.some(
      (path) =>
        typeof path !== "string" ||
        !path ||
        path.startsWith("/") ||
        path.split("/").includes(".."),
    ) ||
    !Array.isArray(value.services)
  ) {
    throw new Error(
      "preview control broker returned a mismatched build result",
    );
  }
  const requested = [...expected.services].sort();
  const results = value.services as Array<Record<string, unknown>>;
  const returned = results
    .map((result) => (typeof result.service === "string" ? result.service : ""))
    .sort();
  if (
    returned.length === 0 ||
    new Set(returned).size !== returned.length ||
    returned.some((service) => !service || !requested.includes(service))
  ) {
    throw new Error("preview control broker returned a different service set");
  }
  for (const result of results) {
    if (result.ok === false && typeof result.error === "string") continue;
    const image =
      typeof result.image === "object" && result.image !== null
        ? (result.image as Record<string, unknown>)
        : null;
    if (
      result.ok !== true ||
      !image ||
      image.service !== result.service ||
      image.sourceRevision !== value.sourceRevision ||
      typeof image.digest !== "string" ||
      !SHA256.test(image.digest) ||
      typeof image.immutableRef !== "string" ||
      !image.immutableRef.endsWith(`@${image.digest}`)
    ) {
      throw new Error(
        "preview control broker returned an invalid image result",
      );
    }
  }
  return value as unknown as PreviewDevelopmentBrokerResult;
}
