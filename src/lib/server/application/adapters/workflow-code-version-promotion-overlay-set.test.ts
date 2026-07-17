import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceBundlePromotionRunnerInput } from "$lib/server/application/ports";
import {
  buildPromotionCommand,
  HelperPodSourceBundlePromotionRunner,
} from "./workflow-code-version-promotion";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function input(
  overrides: Partial<SourceBundlePromotionRunnerInput> = {},
): SourceBundlePromotionRunnerInput {
  return {
    executionId: "exec-1",
    fileId: "file-1",
    repo: "PittampalliOrg/workflow-builder",
    base: "main",
    baseRevision: "a".repeat(40),
    mode: "pr",
    title: "Atomic multi-service change",
    tier: "tar-overlay-set",
    repoSubdir: "",
    syncPaths: [],
    ...overrides,
  };
}

function command(): string {
  return buildPromotionCommand(input(), "token", "http://bff/bundle");
}

it("uses a deterministic commit and reuses the exact-branch pull request", () => {
  const shell = buildPromotionCommand(
    input({ branchName: "preview-feature-pca_deadbeef" }),
    "token",
    "http://bff/bundle",
  );

  expect(shell).toContain("BR='preview-feature-pca_deadbeef'");
  expect(shell).toContain("IDEMPOTENT_BRANCH=1");
  expect(shell).toContain('GIT_AUTHOR_DATE="@$COMMIT_EPOCH +0000"');
  const lookup = shell.indexOf('--data-urlencode "head=$OWNER:$BR"');
  const create = shell.indexOf("curl -fsS -X POST");
  expect(lookup).toBeGreaterThan(0);
  expect(create).toBeGreaterThan(lookup);
});

it("uses a compare-and-swap lease and refuses to create a replacement PR", () => {
  const expectedHead = "b".repeat(40);
  const shell = buildPromotionCommand(
    input({
      branchName: "preview-feature-session",
      branchLease: {
        expectedHeadSha: expectedHead,
        existingPullRequestNumber: 42,
      },
    }),
    "token",
    "http://bff/bundle",
  );

  expect(shell).toContain(`EXPECTED_HEAD='${expectedHead}'`);
  expect(shell).toContain("pull.get(\"draft\") is True");
  expect(shell).toContain(
    'head_ref.get("sha") in (expected, candidate)',
  );
  expect(shell).toContain(
    '--force-with-lease="refs/heads/$BR:$EXPECTED_HEAD"',
  );
  expect(shell.indexOf("existing_pr_preflight_failed")).toBeLessThan(
    shell.indexOf("git push -q --force-with-lease"),
  );
  expect(shell).toContain(
    '[ "$REMOTE_HEAD" = "$CANDIDATE_SHA" ] || { echo "ERR=branch_lease_conflict";',
  );
  expect(shell).toContain('EXPECTED_PR_URL="https://github.com/$REPO/pull/$EXISTING_PR"');
  expect(shell).toContain("PR_STATE='open'");
  expect(shell).toContain('--data-urlencode "state=$PR_STATE"');
  expect(command()).toContain("PR_STATE='all'");
});

it("rejects an existing pull request lease without an expected head", () => {
  expect(() =>
    buildPromotionCommand(
      input({
        branchName: "preview-feature-session",
        branchLease: {
          expectedHeadSha: null,
          existingPullRequestNumber: 42,
        },
      }),
      "token",
      "http://bff/bundle",
    ),
  ).toThrow("invalid_branch_lease");
});

it("rejects unsafe exact branches and exact branches on non-atomic tiers", () => {
  expect(() =>
    buildPromotionCommand(
      input({ branchName: "preview-feature/../escape" }),
      "token",
      "http://bff/bundle",
    ),
  ).toThrow("invalid_branch_name");
  expect(() =>
    buildPromotionCommand(
      input({ tier: "thin", branchName: "preview-feature-safe" }),
      "token",
      "http://bff/bundle",
    ),
  ).toThrow("invalid_idempotent_tier");
});

it("fails closed before helper provisioning without the broker write token", async () => {
  const runner = new HelperPodSourceBundlePromotionRunner({
    githubToken: () => null,
    requireExplicitGithubToken: true,
    helperSuffix: "preview-development-materialize",
  });

  await expect(
    runner.promoteSourceBundle(input({ mode: "branch" })),
  ).resolves.toEqual({
    status: "unavailable",
    message: "preview control GitHub write token is not configured",
  });
});

function pythonApplier(shell: string): string {
  const match = shell.match(
    /python3 - "\$BUNDLE" "\$PROMOTE" <<'PY'\n([\s\S]*?)\nPY/,
  );
  if (!match?.[1]) throw new Error("overlay-set Python applier missing");
  return match[1];
}

function makeTar(
  root: string,
  name: string,
  files: Record<string, string>,
  members?: string[],
): Buffer {
  const source = join(root, `${name}-source`);
  mkdirSync(source, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(source, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  const archive = join(root, `${name}.tar.gz`);
  const tops = members ?? [
    ...new Set(Object.keys(files).map((path) => path.split("/")[0])),
  ];
  const result = spawnSync("tar", ["-czf", archive, "-C", source, ...tops], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "tar failed");
  return readFileSync(archive);
}

function runApplier(
  manifest: unknown,
  root: string,
  initialFiles: Record<string, string> = {},
) {
  const bundle = join(root, "overlay-set.json.gz");
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  for (const [path, content] of Object.entries(initialFiles)) {
    const target = join(repo, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  writeFileSync(bundle, gzipSync(Buffer.from(JSON.stringify(manifest))));
  return {
    repo,
    result: spawnSync("python3", ["-", bundle, repo], {
      input: pythonApplier(command()),
      encoding: "utf8",
    }),
  };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

describe("tar-overlay-set promotion shell", () => {
  it("isolates concurrent helper invocations and converges on a raced PR", () => {
    const shell = command();

    expect(shell).toContain("WORK=$(mktemp -d /tmp/wfb-promote.XXXXXX)");
    expect(shell).toContain('BUNDLE="$WORK/v.bundle"; PROMOTE="$WORK/promote"');
    expect(shell).toContain("trap 'rm -rf \"$WORK\"' EXIT");
    expect(shell).not.toContain("rm -rf /tmp/promote /tmp/v.bundle");
    expect(shell).not.toContain("cd /tmp/promote");
    expect(shell).toContain('[ "$LOOKUP_ATTEMPT" -lt 5 ]');
    expect(shell).toContain("LOOKUP_ATTEMPT=$((LOOKUP_ATTEMPT + 1))");
  });

  it("validates and applies every overlay before one commit and push", () => {
    const root = mkdtempSync(join(tmpdir(), "wfb-overlay-set-"));
    roots.push(root);
    const builder = makeTar(root, "builder", { "src/a.ts": "builder\n" });
    const orchestrator = makeTar(root, "orchestrator", {
      "app.py": "orchestrator\n",
      ".contract-fixtures/schema.json": '{"version":2}\n',
    });
    const { repo, result } = runApplier(
      {
        version: 1,
        tier: "tar-overlay-set",
        captureId: "capture-1",
        capturedAt: "2026-07-09T12:00:00.000Z",
        repoUrl: "PittampalliOrg/workflow-builder",
        base: "main",
        services: [
          {
            service: "workflow-builder",
            repoSubdir: ".",
            syncPaths: ["src"],
            captureMappings: [{ from: "src", to: "src" }],
            tarGzipBase64: builder.toString("base64"),
          },
          {
            service: "workflow-orchestrator",
            repoSubdir: "services/workflow-orchestrator",
            syncPaths: ["app.py"],
            captureMappings: [
              {
                from: "app.py",
                to: "services/workflow-orchestrator/app.py",
              },
              {
                from: ".contract-fixtures",
                to: "services/shared/workflow-data-contract",
              },
            ],
            tarGzipBase64: orchestrator.toString("base64"),
          },
        ],
      },
      root,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OVERLAY_SET_APPLIED=2");
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("builder\n");
    expect(
      readFileSync(join(repo, "services/workflow-orchestrator/app.py"), "utf8"),
    ).toBe("orchestrator\n");
    expect(
      readFileSync(
        join(repo, "services/shared/workflow-data-contract/schema.json"),
        "utf8",
      ),
    ).toBe('{"version":2}\n');
    expect(() =>
      readFileSync(
        join(
          repo,
          "services/workflow-orchestrator/.contract-fixtures/schema.json",
        ),
      ),
    ).toThrow();

    const shell = command();
    expect(shell.match(/git clone /g)).toHaveLength(1);
    expect(shell.match(/git commit -q /g)).toHaveLength(1);
    expect(shell.match(/git push -q /g)).toHaveLength(2);
  });

  it("accepts provenance-complete v2 sets and verifies each archive digest", () => {
    const root = mkdtempSync(join(tmpdir(), "wfb-overlay-v2-"));
    roots.push(root);
    const archive = makeTar(root, "v2", {
      "src/version.ts": "export const version = 2;\n",
    });
    const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
    const manifest = {
      version: 2,
      tier: "tar-overlay-set",
      captureProtocol: "atomic-generation-v2",
      acceptanceEligible: true,
      captureId: "capture-v2",
      capturedAt: "2026-07-09T12:00:00.000Z",
      generation: "generation-1",
      catalogDigest: `sha256:${"c".repeat(64)}`,
      sourceRevision: "a".repeat(40),
      platformRevision: "b".repeat(40),
      repoUrl: "PittampalliOrg/workflow-builder",
      base: "main",
      services: [
        {
          service: "workflow-builder",
          repoSubdir: ".",
          syncPaths: ["src"],
          captureMappings: [{ from: "src", to: "src" }],
          contentSha256: digest,
          tarGzipBase64: archive.toString("base64"),
        },
      ],
    };

    const accepted = runApplier(manifest, root);
    expect(accepted.result.status, accepted.result.stderr).toBe(0);
    expect(
      readFileSync(join(accepted.repo, "src/version.ts"), "utf8"),
    ).toContain("2");

    const rejectedRoot = mkdtempSync(join(tmpdir(), "wfb-overlay-v2-bad-"));
    roots.push(rejectedRoot);
    const rejected = runApplier(
      {
        ...manifest,
        services: [
          {
            ...manifest.services[0],
            contentSha256: `sha256:${"0".repeat(64)}`,
          },
        ],
      },
      rejectedRoot,
    );
    expect(rejected.result.status).not.toBe(0);
    expect(rejected.result.stdout).toContain("ERR=overlay_digest_mismatch");
  });

  it("roots the overlay at the captured SHA even after main advances", () => {
    const root = mkdtempSync(join(tmpdir(), "wfb-exact-baseline-"));
    roots.push(root);
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    mkdirSync(work, { recursive: true });
    git(root, ["init", "--bare", origin]);
    git(work, ["init", "-b", "main"]);
    git(work, ["config", "user.email", "test@example.invalid"]);
    git(work, ["config", "user.name", "test"]);
    mkdirSync(join(work, "services/function-router/src"), { recursive: true });
    writeFileSync(
      join(work, "services/function-router/src/index.ts"),
      "export const version = 1;\n",
    );
    git(work, ["add", "."]);
    git(work, ["commit", "-m", "baseline"]);
    const capturedSha = git(work, ["rev-parse", "HEAD"]);
    git(work, ["remote", "add", "origin", origin]);
    git(work, ["push", "-u", "origin", "main"]);
    git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);

    writeFileSync(join(work, "README.md"), "main advanced\n");
    git(work, ["add", "README.md"]);
    git(work, ["commit", "-m", "advance main"]);
    const advancedSha = git(work, ["rev-parse", "HEAD"]);
    git(work, ["push", "origin", "main"]);

    const archive = makeTar(root, "exact", {
      "src/index.ts": "export const version = 2;\n",
    });
    const archiveDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
    const bundle = join(root, "exact.json.gz");
    writeFileSync(
      bundle,
      gzipSync(
        Buffer.from(
          JSON.stringify({
            version: 2,
            tier: "tar-overlay-set",
            captureProtocol: "atomic-generation-v2",
            acceptanceEligible: true,
            captureId: "capture-exact",
            capturedAt: "2026-07-09T12:00:00.000Z",
            generation: "generation-1",
            catalogDigest: `sha256:${"c".repeat(64)}`,
            sourceRevision: capturedSha,
            platformRevision: "b".repeat(40),
            repoUrl: "PittampalliOrg/workflow-builder",
            base: "main",
            services: [
              {
                service: "function-router",
                repoSubdir: "services/function-router",
                syncPaths: ["src"],
                captureMappings: [
                  { from: "src", to: "services/function-router/src" },
                ],
                contentSha256: archiveDigest,
                tarGzipBase64: archive.toString("base64"),
              },
            ],
          }),
        ),
      ),
    );
    const remoteLiteral = '"https://x-access-token:$GH@github.com/$REPO.git"';
    const shell = buildPromotionCommand(
      input({
        mode: "branch",
        baseRevision: capturedSha,
        branchName: "preview-feature-exact-baseline",
      }),
      "token",
      `file://${bundle}`,
    ).replaceAll(remoteLiteral, JSON.stringify(origin));
    const result = spawnSync("bash", ["-c", shell], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_TOKEN: "test-token" },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const branch = /BRANCH_PUSHED=(\S+)/.exec(result.stdout)?.[1];
    expect(branch).toBe("preview-feature-exact-baseline");
    expect(git(origin, ["rev-parse", `refs/heads/${branch}^`])).toBe(
      capturedSha,
    );
    expect(git(origin, ["rev-parse", "refs/heads/main"])).toBe(advancedSha);
    expect(result.stdout).toContain(`BASE_REVISION=${capturedSha}`);
    expect(result.stdout).toContain("PULL_REQUEST_BASE=main");
    const encoded = /CHANGED_PATHS_B64=([A-Za-z0-9_-]+)/.exec(
      result.stdout,
    )?.[1];
    expect(
      JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8")),
    ).toEqual(["services/function-router/src/index.ts"]);

    const retried = spawnSync("bash", ["-c", shell], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_TOKEN: "test-token" },
    });
    expect(retried.status, `${retried.stdout}\n${retried.stderr}`).toBe(0);
    expect(/COMMIT_SHA=([0-9a-f]{40})/.exec(retried.stdout)?.[1]).toBe(
      /COMMIT_SHA=([0-9a-f]{40})/.exec(result.stdout)?.[1],
    );
  });

  it("materializes a staged dev Dockerfile at its canonical branch path", () => {
    const root = mkdtempSync(join(tmpdir(), "wfb-overlay-build-input-"));
    roots.push(root);
    const archive = makeTar(
      root,
      "build-input",
      {
        "src/index.ts": "export const value = 1;\n",
        ".preview-capture/development.Dockerfile":
          "FROM node:22-alpine\nRUN echo changed\n",
      },
      ["src", ".preview-capture/development.Dockerfile"],
    );
    const { repo, result } = runApplier(
      {
        version: 1,
        tier: "tar-overlay-set",
        captureId: "capture-build-input",
        capturedAt: "2026-07-09T12:00:00.000Z",
        repoUrl: "PittampalliOrg/workflow-builder",
        base: "main",
        services: [
          {
            service: "workflow-builder",
            repoSubdir: ".",
            syncPaths: ["src"],
            captureMappings: [
              { from: "src", to: "src" },
              {
                from: ".preview-capture/development.Dockerfile",
                to: "skaffold/dev/workflow-builder/Dockerfile.dev",
              },
            ],
            tarGzipBase64: archive.toString("base64"),
          },
        ],
      },
      root,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(
      readFileSync(
        join(repo, "skaffold/dev/workflow-builder/Dockerfile.dev"),
        "utf8",
      ),
    ).toBe("FROM node:22-alpine\nRUN echo changed\n");
    expect(() =>
      readFileSync(join(repo, ".preview-capture/development.Dockerfile")),
    ).toThrow();
  });

  it("does not delete canonical files when optional staged capture inputs are absent", () => {
    const root = mkdtempSync(join(tmpdir(), "wfb-overlay-missing-capture-"));
    roots.push(root);
    const archive = makeTar(root, "missing-capture", {
      "src/index.ts": "export const value = 2;\n",
    });
    const { repo, result } = runApplier(
      {
        version: 1,
        tier: "tar-overlay-set",
        captureId: "capture-missing-build-input",
        capturedAt: "2026-07-09T12:00:00.000Z",
        repoUrl: "PittampalliOrg/workflow-builder",
        base: "main",
        services: [
          {
            service: "workflow-builder",
            repoSubdir: ".",
            syncPaths: ["src"],
            captureMappings: [
              { from: "src", to: "src" },
              {
                from: ".preview-capture/production.Dockerfile",
                to: "Dockerfile",
              },
              {
                from: ".preview-capture/development.Dockerfile",
                to: "skaffold/dev/workflow-builder/Dockerfile.dev",
              },
            ],
            tarGzipBase64: archive.toString("base64"),
          },
        ],
      },
      root,
      {
        Dockerfile: "FROM node:22-alpine\n",
        "skaffold/dev/workflow-builder/Dockerfile.dev":
          "FROM node:22-alpine\nRUN echo dev\n",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(repo, "src/index.ts"), "utf8")).toBe(
      "export const value = 2;\n",
    );
    expect(readFileSync(join(repo, "Dockerfile"), "utf8")).toBe(
      "FROM node:22-alpine\n",
    );
    expect(
      readFileSync(
        join(repo, "skaffold/dev/workflow-builder/Dockerfile.dev"),
        "utf8",
      ),
    ).toBe("FROM node:22-alpine\nRUN echo dev\n");
  });

  it("rejects malformed sets and unsafe paths before extraction", () => {
    const malformedRoot = mkdtempSync(join(tmpdir(), "wfb-overlay-bad-"));
    roots.push(malformedRoot);
    const malformed = runApplier({ version: 99 }, malformedRoot).result;
    expect(malformed.status).not.toBe(0);
    expect(malformed.stdout).toContain("ERR=malformed_overlay_set");

    const unsafeRoot = mkdtempSync(join(tmpdir(), "wfb-overlay-unsafe-"));
    roots.push(unsafeRoot);
    const unsafe = runApplier(
      {
        version: 1,
        tier: "tar-overlay-set",
        captureId: "capture-2",
        capturedAt: "2026-07-09T12:00:00.000Z",
        repoUrl: "PittampalliOrg/workflow-builder",
        base: "main",
        services: [
          {
            service: "workflow-builder",
            repoSubdir: "../escape",
            syncPaths: ["src"],
            tarGzipBase64: gzipSync(Buffer.from("x")).toString("base64"),
          },
        ],
      },
      unsafeRoot,
    ).result;
    expect(unsafe.status).not.toBe(0);
    expect(unsafe.stdout).toContain("ERR=unsafe_overlay_path");
  });

  it("keeps single-overlay path validation at the runner boundary", () => {
    expect(() =>
      buildPromotionCommand(
        input({
          tier: "tar-overlay",
          repoSubdir: "../../escape",
          syncPaths: ["src"],
        }),
        "token",
        "http://bff/bundle",
      ),
    ).toThrow("unsafe_overlay_path");
  });
});
