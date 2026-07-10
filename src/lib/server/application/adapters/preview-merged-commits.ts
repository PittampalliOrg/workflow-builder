import type {
  PreviewGitHubInstallationTokenPort,
  PreviewMergedCommitInspection,
  PreviewMergedCommitInspectionPort,
} from "$lib/server/application/ports";

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type GithubPreviewMergedCommitOptions = Readonly<{
  credentials: PreviewGitHubInstallationTokenPort;
  baseRef?: string;
  fetch?: typeof globalThis.fetch;
}>;

type GithubPull = Readonly<{
  number?: unknown;
  merged_at?: unknown;
  merge_commit_sha?: unknown;
  base?: { ref?: unknown; sha?: unknown };
  head?: { sha?: unknown; repo?: { full_name?: unknown } | null };
}>;

/** GitHub adapter proving merge ancestry, exact PR identity, trees, and complete paths. */
export class GithubPreviewMergedCommitInspectionAdapter implements PreviewMergedCommitInspectionPort {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseRef: string;

  constructor(private readonly options: GithubPreviewMergedCommitOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseRef = options.baseRef ?? "main";
  }

  async inspect(input: {
    repository: string;
    mergeSha: PreviewMergedCommitInspection["mergeSha"];
  }): Promise<PreviewMergedCommitInspection | null> {
    if (!REPOSITORY.test(input.repository) || !FULL_SHA.test(input.mergeSha)) {
      throw new Error("merged commit inspection tuple is invalid");
    }
    const token = await this.options.credentials.token();
    const pulls = await this.json<GithubPull[]>(
      token,
      `/repos/${input.repository}/commits/${input.mergeSha}/pulls?per_page=20`,
    );
    const matches = pulls.filter(
      (pull) =>
        Number.isSafeInteger(pull.number) &&
        Number(pull.number) > 0 &&
        typeof pull.merged_at === "string" &&
        pull.merge_commit_sha === input.mergeSha &&
        pull.base?.ref === this.baseRef &&
        FULL_SHA.test(String(pull.base.sha ?? "")) &&
        FULL_SHA.test(String(pull.head?.sha ?? "")) &&
        pull.head?.repo?.full_name === input.repository,
    );
    if (matches.length !== 1) return null;
    const pull = matches[0]!;
    const number = Number(pull.number);
    const baseSha = String(pull.base!.sha);
    const headSha = String(pull.head!.sha);
    const [headCommit, mergeCommit, comparison, changedPaths] =
      await Promise.all([
        this.json<{ tree?: { sha?: unknown } }>(
          token,
          `/repos/${input.repository}/git/commits/${headSha}`,
        ),
        this.json<{ tree?: { sha?: unknown } }>(
          token,
          `/repos/${input.repository}/git/commits/${input.mergeSha}`,
        ),
        this.json<{ status?: unknown; merge_base_commit?: { sha?: unknown } }>(
          token,
          `/repos/${input.repository}/compare/${input.mergeSha}...${encodeURIComponent(this.baseRef)}`,
        ),
        this.changedPaths(token, input.repository, number),
      ]);
    const headTreeSha = String(headCommit.tree?.sha ?? "");
    const mergeTreeSha = String(mergeCommit.tree?.sha ?? "");
    if (
      !FULL_SHA.test(headTreeSha) ||
      !FULL_SHA.test(mergeTreeSha) ||
      !["ahead", "identical"].includes(String(comparison.status ?? "")) ||
      comparison.merge_base_commit?.sha !== input.mergeSha
    ) {
      return null;
    }
    return Object.freeze({
      repository: input.repository,
      pullRequestNumber: number,
      baseSha: baseSha as PreviewMergedCommitInspection["baseSha"],
      headSha: headSha as PreviewMergedCommitInspection["headSha"],
      mergeSha: input.mergeSha,
      baseRef: this.baseRef,
      headTreeSha: headTreeSha as PreviewMergedCommitInspection["headTreeSha"],
      mergeTreeSha:
        mergeTreeSha as PreviewMergedCommitInspection["mergeTreeSha"],
      changedPaths: Object.freeze(changedPaths),
    });
  }

  private async changedPaths(
    token: string,
    repository: string,
    pullRequestNumber: number,
  ): Promise<string[]> {
    const paths: string[] = [];
    for (let page = 1; page <= 30; page += 1) {
      const files = await this.json<Array<{ filename?: unknown }>>(
        token,
        `/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`,
      );
      for (const file of files) {
        if (typeof file.filename !== "string" || file.filename.length === 0) {
          throw new Error(
            "GitHub returned an invalid merged pull request path",
          );
        }
        paths.push(file.filename);
      }
      if (files.length < 100) return [...new Set(paths)].sort();
    }
    throw new Error(
      "merged pull request path list exceeds GitHub's safe bound",
    );
  }

  private async json<T>(token: string, path: string): Promise<T> {
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        body && typeof body === "object" && "message" in body
          ? String(body.message)
          : `GitHub request failed (HTTP ${response.status})`;
      throw new Error(message);
    }
    return body as T;
  }
}
