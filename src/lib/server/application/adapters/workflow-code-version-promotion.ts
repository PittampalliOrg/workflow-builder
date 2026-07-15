import type {
  SourceBundlePromotionGateInput,
  SourceBundlePromotionGatePort,
  SourceBundlePromotionGateResult,
  SourceBundlePromotionRunnerInput,
  SourceBundlePromotionRunnerPort,
  SourceBundlePromotionRunnerResult,
} from "$lib/server/application/ports";
import { evaluatePromotionGate } from "$lib/server/workflows/promotion-gates";
import {
  internalBffBaseUrl,
  provisionWorkspaceHelperPod,
  runHelperCommand,
} from "$lib/server/workflows/helper-pod";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export class WorkflowPromotionGateAdapter implements SourceBundlePromotionGatePort {
  evaluatePromotionGate(
    input: SourceBundlePromotionGateInput,
  ): SourceBundlePromotionGateResult {
    return evaluatePromotionGate(input);
  }
}

export class HelperPodSourceBundlePromotionRunner implements SourceBundlePromotionRunnerPort {
  constructor(
    private readonly opts: {
      /** D2 (`PROMOTE_AUTO_PREVIEW_LABEL`): add the `preview` label to the
       * opened PR so the label-gated PR-preview loop auto-provisions. */
      addPreviewLabel?: boolean;
      /** Broker-owned write credential. Never resolve mutable preview credentials
       * when requireExplicitGithubToken is set. */
      githubToken?: () => string | null | Promise<string | null>;
      requireExplicitGithubToken?: boolean;
      helperSuffix?: string;
    } = {},
  ) {}

  async promoteSourceBundle(
    input: SourceBundlePromotionRunnerInput,
  ): Promise<SourceBundlePromotionRunnerResult> {
    const inputError = promotionInputError(input);
    if (inputError) {
      return {
        status: "command_error",
        error: inputError,
        output: `ERR=${inputError}\n`,
      };
    }
    const explicitGithubToken = (await this.opts.githubToken?.())?.trim() || null;
    if (this.opts.requireExplicitGithubToken && !explicitGithubToken) {
      return {
        status: "unavailable",
        message: "preview control GitHub write token is not configured",
      };
    }
    const helper = await provisionWorkspaceHelperPod(
      input.executionId,
      this.opts.helperSuffix ?? "promote",
      {
        withGithubToken: !this.opts.requireExplicitGithubToken,
        githubToken: explicitGithubToken,
      },
    );
    if (!helper) {
      return {
        status: "unavailable",
        message: "could not provision a helper pod for promote",
      };
    }

    const bundleUrl = `${internalBffBaseUrl()}/api/internal/files/${input.fileId}/content`;
    const command = buildPromotionCommand(
      input,
      helper.token,
      bundleUrl,
      this.opts,
    );
    const result = await runHelperCommand(
      helper.baseUrl,
      helper.token,
      command,
      "/tmp",
      300_000,
    );
    if (!result) {
      return {
        status: "unavailable",
        message: "promote command failed (no pod response)",
      };
    }

    const output = `${result.stdout}\n${result.stderr}`;
    const errorMatch = output.match(/ERR=(\w+)/);
    const prMatch = output.match(/PR_URL=(\S+)/);
    const branchMatch = output.match(/BRANCH_PUSHED=(\S+)/);
    const commitMatch = output.match(/COMMIT_SHA=([0-9a-f]{40})/);
    const baseRevisionMatch = output.match(/BASE_REVISION=([0-9a-f]{40})/);
    const pullRequestBaseMatch = output.match(/PULL_REQUEST_BASE=(\S+)/);
    const changedPathsMatch = output.match(
      /CHANGED_PATHS_B64=([A-Za-z0-9_-]+)/,
    );
    if (errorMatch) {
      return {
        status: "command_error",
        error: errorMatch[1],
        output,
      };
    }
    if (!commitMatch) {
      return {
        status: "command_error",
        error: "missing_commit_sha",
        output,
      };
    }
    if (
      input.tier === "tar-overlay-set" &&
      (!baseRevisionMatch ||
        baseRevisionMatch[1] !== input.baseRevision ||
        pullRequestBaseMatch?.[1] !== input.base ||
        !changedPathsMatch)
    ) {
      return {
        status: "command_error",
        error: "invalid_materialization_provenance",
        output,
      };
    }
    let changedPaths: readonly string[] = Object.freeze([]);
    if (changedPathsMatch) {
      try {
        changedPaths = decodeChangedPaths(changedPathsMatch[1]);
      } catch {
        return {
          status: "command_error",
          error: "invalid_changed_paths",
          output,
        };
      }
    }
    if (input.tier === "tar-overlay-set" && changedPaths.length === 0) {
      return {
        status: "command_error",
        error: "empty_materialized_diff",
        output,
      };
    }

    const prError = output.match(/PR_ERR=(.+)/);
    return {
      status: "ok",
      output,
      prUrl: prMatch ? prMatch[1] : null,
      branch: branchMatch ? branchMatch[1] : null,
      commitSha: commitMatch[1],
      baseRevision: baseRevisionMatch?.[1] ?? null,
      pullRequestBase: pullRequestBaseMatch?.[1] ?? input.base,
      changedPaths,
      prError: !prMatch && prError ? prError[1].trim() : null,
    };
  }
}

/** Exported for tests (the shell is the single source of truth for the PR call). */
export function buildPromotionCommand(
  input: SourceBundlePromotionRunnerInput,
  token: string,
  bundleUrl: string,
  opts: { addPreviewLabel?: boolean } = {},
) {
  const inputError = promotionInputError(input);
  if (inputError) throw new Error(inputError);
  const overlayPaths = input.syncPaths.map(shQuote).join(" ");
  const destSub = input.repoSubdir ? `/${input.repoSubdir}` : "";
  const cloneStep =
    input.tier === "tar-overlay-set"
      ? buildTarOverlaySetCloneStep()
      : input.tier === "tar-overlay"
        ? `git clone -q --depth 1 -b "$PR_BASE" "https://x-access-token:$GH@github.com/${input.repo}.git" /tmp/promote && ` +
          `cd /tmp/promote && git checkout -q -b "$BR" && ` +
          `DEST="/tmp/promote${destSub}" && mkdir -p "$DEST" && ` +
          `for p in ${overlayPaths}; do rm -rf "$DEST/$p"; done && ` +
          `tar -xzf /tmp/v.bundle -C "$DEST" && ` +
          `git config user.email agent@workflow-builder.local && git config user.name 'workflow-builder' && ` +
          `git add -A && git commit -q -m "$TITLE" || { echo "ERR=no_changes"; exit 0; }`
        : input.tier === "thin"
          ? `git clone -q "https://x-access-token:$GH@github.com/${input.repo}.git" /tmp/promote && cd /tmp/promote && ` +
            `git fetch -q /tmp/v.bundle 'refs/*:refs/wfb-bundle/*' >/dev/null 2>&1 || git fetch -q /tmp/v.bundle >/dev/null 2>&1; ` +
            `TGT=$(git bundle list-heads /tmp/v.bundle 2>/dev/null | head -1 | awk '{print $1}'); ` +
            `git checkout -q -b "$BR" "$TGT"`
          : `git clone -q /tmp/v.bundle /tmp/promote && cd /tmp/promote && git checkout -q -b "$BR"`;

  // The preview-control broker supplies an exact broker-owned branch.
  // Other callers retain the legacy timestamped-prefix behavior.
  const branchPrefix =
    sanitizeBranchPrefix(input.branchPrefix) || "wfb-promote";
  const exactBranch = input.branchName ?? "";
  const branchLeaseEnabled = input.branchLease !== undefined;
  const expectedHeadSha = input.branchLease?.expectedHeadSha ?? "";
  const existingPullRequestNumber =
    input.branchLease?.existingPullRequestNumber ?? "";
  const pullRequestLookupState = branchLeaseEnabled ? "open" : "all";
  const commitTitle = exactBranch
    ? `Preview source promotion ${exactBranch}`
    : input.title;
  // PR title/body are embedded inside a JSON payload built in-shell; pre-escape
  // them to valid JSON-inner strings (handles quotes/newlines) so a multi-line
  // markdown body can't break the JSON. TITLE (raw) stays the git commit subject.
  const prTitleJson = jsonInner(input.title);
  const prBodyJson = jsonInner(
    input.prBody ??
      "Promoted from a workflow-builder code version (durable source bundle).",
  );
  const draftFrag = input.draft ? `,\\"draft\\":true` : "";

  return [
    `set -e`,
    `TOK=${shQuote(token)}`,
    `REPO=${shQuote(input.repo)}; PR_BASE=${shQuote(input.base)}; BASE_REVISION=${shQuote(input.baseRevision ?? "")}; MODE=${shQuote(input.mode)}; TITLE=${shQuote(input.title)}; COMMIT_TITLE=${shQuote(commitTitle)}; IDEMPOTENT_BRANCH=${exactBranch ? "1" : "0"}`,
    `BRANCH_LEASE=${branchLeaseEnabled ? "1" : "0"}; EXPECTED_HEAD=${shQuote(expectedHeadSha)}; EXISTING_PR=${shQuote(String(existingPullRequestNumber))}; PR_STATE=${shQuote(pullRequestLookupState)}`,
    `PR_TITLE=${shQuote(prTitleJson)}; PR_BODY=${shQuote(prBodyJson)}`,
    `GH="$GITHUB_TOKEN"`,
    `[ -n "$GH" ] || { echo "ERR=no_github_token"; exit 0; }`,
    `rm -rf /tmp/promote /tmp/v.bundle`,
    `curl -fsS -H "X-Internal-Token: $TOK" ${shQuote(bundleUrl)} -o /tmp/v.bundle || { echo "ERR=bundle_fetch_failed"; exit 0; }`,
    `git config --global --add safe.directory '*' 2>/dev/null || true`,
    `BR=${shQuote(exactBranch)}`,
    `[ -n "$BR" ] || BR="${branchPrefix}-$(date +%s)"`,
    cloneStep,
    `git config user.email agent@workflow-builder.local; git config user.name 'workflow-builder'`,
    `CANDIDATE_SHA=$(git rev-parse HEAD)`,
    `if [ -n "$BASE_REVISION" ]; then`,
    `  [ "$(git rev-parse HEAD^)" = "$BASE_REVISION" ] || { echo "ERR=base_revision_parent_mismatch"; exit 0; }`,
    `  CHANGED_PATHS_B64=$(git diff --name-only -z "$BASE_REVISION" "$CANDIDATE_SHA" | python3 -c 'import base64,json,sys; raw=sys.stdin.buffer.read().split(b"\\0"); print(base64.urlsafe_b64encode(json.dumps([p.decode("utf-8") for p in raw if p], separators=(",", ":")).encode()).decode().rstrip("="))')`,
    `  echo "BASE_REVISION=$BASE_REVISION"`,
    `  echo "CHANGED_PATHS_B64=$CHANGED_PATHS_B64"`,
    `fi`,
    `echo "PULL_REQUEST_BASE=$PR_BASE"`,
    `REMOTE_URL="https://x-access-token:$GH@github.com/$REPO.git"`,
    `if [ "$BRANCH_LEASE" = 1 ] && [ -n "$EXISTING_PR" ]; then`,
    `  PREFLIGHT=$(curl -fsS -H "Authorization: Bearer $GH" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/pulls/$EXISTING_PR") || { echo "ERR=existing_pr_preflight_failed"; exit 0; }`,
    `  printf '%s' "$PREFLIGHT" | python3 -c ${shQuote(LEASED_PULL_REQUEST_PREFLIGHT)} "$REPO" "$PR_BASE" "$BR" "$EXPECTED_HEAD" "$CANDIDATE_SHA" "$EXISTING_PR" || { echo "ERR=existing_pr_not_draft_or_moved"; exit 0; }`,
    `fi`,
    `if [ "$BRANCH_LEASE" = 1 ]; then`,
    `  if ! git push -q --force-with-lease="refs/heads/$BR:$EXPECTED_HEAD" "$REMOTE_URL" HEAD:"$BR"; then`,
    `    REMOTE_HEAD=$(git ls-remote "$REMOTE_URL" "refs/heads/$BR" | awk 'NR == 1 { print $1 }')`,
    `    [ "$REMOTE_HEAD" = "$CANDIDATE_SHA" ] || { echo "ERR=branch_lease_conflict"; exit 0; }`,
    `  fi`,
    `else`,
    `  git push -q "$REMOTE_URL" HEAD:"$BR" || { echo "ERR=push_failed"; exit 0; }`,
    `fi`,
    `echo "COMMIT_SHA=$CANDIDATE_SHA"`,
    `echo "BRANCH_PUSHED=$BR"`,
    `if [ "$MODE" = pr ]; then`,
    `  OWNER=$(printf '%s' "$REPO" | cut -d/ -f1)`,
    `  OPEN=$(curl -fsS -G -H "Authorization: Bearer $GH" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/pulls" --data-urlencode "state=$PR_STATE" --data-urlencode "head=$OWNER:$BR" --data-urlencode "base=$PR_BASE" || echo '[]')`,
    `  URL=$(printf '%s' "$OPEN" | grep -oE 'https://github.com/[^"]+/pull/[0-9]+' | head -1)`,
    `  PR=''`,
    `  if [ -n "$EXISTING_PR" ]; then`,
    `    EXPECTED_PR_URL="https://github.com/$REPO/pull/$EXISTING_PR"`,
    `    [ "$URL" = "$EXPECTED_PR_URL" ] || { echo "ERR=existing_pr_unavailable"; exit 0; }`,
    `  elif [ -z "$URL" ]; then`,
    `    PR=$(curl -fsS -X POST -H "Authorization: Bearer $GH" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/pulls" -d "{\\"title\\":\\"$PR_TITLE\\",\\"head\\":\\"$BR\\",\\"base\\":\\"$PR_BASE\\",\\"body\\":\\"$PR_BODY\\"${draftFrag}}" || echo '{}')`,
    `  fi`,
    `  if [ -z "$URL" ]; then URL=$(printf '%s' "$PR" | grep -oE 'https://github.com/[^"]+/pull/[0-9]+' | head -1); fi`,
    `  if [ -z "$URL" ]; then OPEN=$(curl -fsS -G -H "Authorization: Bearer $GH" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/pulls" --data-urlencode "state=$PR_STATE" --data-urlencode "head=$OWNER:$BR" --data-urlencode "base=$PR_BASE" || echo '[]'); URL=$(printf '%s' "$OPEN" | grep -oE 'https://github.com/[^"]+/pull/[0-9]+' | head -1); fi`,
    `  if [ -n "$URL" ]; then echo "PR_URL=$URL"; else echo "PR_ERR=$(printf '%s' "$PR" | grep -oE '"message"[^,}]*' | head -1)"; fi`,
    // D2 (flagged): label the fresh PR `preview` so the label-gated Tekton
    // pull_request trigger auto-provisions a preview. Best-effort — a label
    // failure must never fail the promote (the PR already exists).
    ...(opts.addPreviewLabel
      ? [
          `  if [ -n "$URL" ]; then`,
          `    NUM="\${URL##*/}"`,
          `    LBL=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $GH" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/issues/$NUM/labels" -d '{"labels":["preview"]}' || echo 000)`,
          `    echo "PREVIEW_LABEL_HTTP=$LBL"`,
          `  fi`,
        ]
      : []),
    `fi`,
  ].join("\n");
}

const LEASED_PULL_REQUEST_PREFLIGHT = `import json
import sys

repo, base, branch, expected, candidate, number = sys.argv[1:]
pull = json.load(sys.stdin)

def obj(value):
    return value if isinstance(value, dict) else {}

base_ref = obj(pull.get("base"))
head_ref = obj(pull.get("head"))
valid = (
    pull.get("state") == "open"
    and pull.get("draft") is True
    and pull.get("number") == int(number)
    and base_ref.get("ref") == base
    and obj(base_ref.get("repo")).get("full_name") == repo
    and head_ref.get("ref") == branch
    and obj(head_ref.get("repo")).get("full_name") == repo
    and head_ref.get("sha") in (expected, candidate)
)
raise SystemExit(0 if valid else 1)`;

function buildTarOverlaySetCloneStep(): string {
  return [
    `git clone -q --no-checkout "https://x-access-token:$GH@github.com/$REPO.git" /tmp/promote`,
    `cd /tmp/promote`,
    `git rev-parse --verify "origin/$PR_BASE^{commit}" >/dev/null 2>&1 || { echo "ERR=pr_base_unavailable"; exit 0; }`,
    `git cat-file -e "$BASE_REVISION^{commit}" 2>/dev/null || { echo "ERR=base_revision_unavailable"; exit 0; }`,
    `git merge-base --is-ancestor "$BASE_REVISION" "origin/$PR_BASE" || { echo "ERR=base_revision_not_ancestor"; exit 0; }`,
    `git checkout -q -b "$BR" "$BASE_REVISION"`,
    `[ "$(git rev-parse HEAD)" = "$BASE_REVISION" ] || { echo "ERR=base_revision_checkout_mismatch"; exit 0; }`,
    `python3 - /tmp/v.bundle /tmp/promote <<'PY'`,
    TAR_OVERLAY_SET_APPLIER,
    `PY`,
    `git config user.email agent@workflow-builder.local && git config user.name 'workflow-builder'`,
    `git add -A`,
    `if [ "$IDEMPOTENT_BRANCH" = 1 ]; then`,
    `  COMMIT_EPOCH=$(git show -s --format=%ct "$BASE_REVISION")`,
    `  export GIT_AUTHOR_DATE="@$COMMIT_EPOCH +0000" GIT_COMMITTER_DATE="@$COMMIT_EPOCH +0000"`,
    `fi`,
    `git commit -q -m "$COMMIT_TITLE" || { echo "ERR=no_changes"; exit 0; }`,
  ].join("\n");
}

const TAR_OVERLAY_SET_APPLIER = `import base64
import gzip
import hashlib
import io
import json
import re
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

MAX_MANIFEST_BYTES = 256 * 1024 * 1024
MAX_OVERLAY_BYTES = 25 * 1024 * 1024
MAX_EXTRACTED_BYTES = 512 * 1024 * 1024
MAX_MEMBERS = 20000

def fail(code):
    print("ERR=" + code, flush=True)
    raise SystemExit(1)

def relative_parts(raw, allow_root=False):
    if not isinstance(raw, str) or raw != raw.strip() or "\\x00" in raw or "\\\\" in raw:
        fail("unsafe_overlay_path")
    path = PurePosixPath(raw)
    if path.is_absolute():
        fail("unsafe_overlay_path")
    parts = tuple(part for part in path.parts if part not in ("", "."))
    if any(part == ".." for part in parts) or (not parts and not allow_root):
        fail("unsafe_overlay_path")
    return parts

def under(path_parts, prefix_parts):
    return len(path_parts) >= len(prefix_parts) and path_parts[:len(prefix_parts)] == prefix_parts

def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()

def tree_signature(path):
    if not path.exists():
        return ("missing",)
    if path.is_file():
        return ("file", file_sha256(path))
    if not path.is_dir():
        fail("unsafe_overlay_path")
    entries = []
    for child in sorted(path.rglob("*"), key=lambda item: item.as_posix()):
        relative = child.relative_to(path).as_posix()
        if child.is_symlink():
            fail("unsafe_overlay_path")
        if child.is_dir():
            entries.append(("dir", relative))
        elif child.is_file():
            entries.append(("file", relative, file_sha256(child)))
        else:
            fail("unsafe_overlay_path")
    return ("dir", tuple(entries))

try:
    with gzip.open(sys.argv[1], "rb") as stream:
        raw = stream.read(MAX_MANIFEST_BYTES + 1)
    if len(raw) > MAX_MANIFEST_BYTES:
        fail("malformed_overlay_set")
    manifest = json.loads(raw)
    services = manifest.get("services") if isinstance(manifest, dict) else None
    version = manifest.get("version") if isinstance(manifest, dict) else None
    if (
        version not in (1, 2)
        or manifest.get("tier") != "tar-overlay-set"
        or not isinstance(manifest.get("captureId"), str)
        or not manifest.get("captureId")
        or not isinstance(manifest.get("capturedAt"), str)
        or not manifest.get("capturedAt")
        or not isinstance(manifest.get("repoUrl"), str)
        or not manifest.get("repoUrl")
        or not isinstance(manifest.get("base"), str)
        or not manifest.get("base")
        or not isinstance(services, list)
        or not 1 <= len(services) <= 32
    ):
        fail("malformed_overlay_set")
    if version == 2 and (
        manifest.get("captureProtocol") != "atomic-generation-v2"
        or manifest.get("acceptanceEligible") is not True
        or not isinstance(manifest.get("generation"), str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", manifest.get("generation"))
        or not isinstance(manifest.get("catalogDigest"), str)
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", manifest.get("catalogDigest"))
        or not isinstance(manifest.get("sourceRevision"), str)
        or not re.fullmatch(r"[0-9a-f]{40}", manifest.get("sourceRevision"))
        or not isinstance(manifest.get("platformRevision"), str)
        or not re.fullmatch(r"[0-9a-f]{40}", manifest.get("platformRevision"))
    ):
        fail("malformed_overlay_set")

    prepared = []
    seen_services = set()
    claimed_targets = []
    extracted_bytes = 0
    member_count = 0
    for entry in services:
        if not isinstance(entry, dict):
            fail("malformed_overlay_set")
        service = entry.get("service")
        if (
            not isinstance(service, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", service)
            or service in seen_services
        ):
            fail("malformed_overlay_set")
        seen_services.add(service)
        repo_parts = relative_parts(entry.get("repoSubdir"), allow_root=True)
        sync_raw = entry.get("syncPaths")
        if not isinstance(sync_raw, list) or not 1 <= len(sync_raw) <= 128:
            fail("malformed_overlay_set")
        sync_parts = [relative_parts(value) for value in sync_raw]
        if len(set(sync_parts)) != len(sync_parts):
            fail("malformed_overlay_set")
        mappings_raw = entry.get("captureMappings")
        if mappings_raw is None:
            mappings = [(sync, repo_parts + sync) for sync in sync_parts]
        else:
            if not isinstance(mappings_raw, list) or not 1 <= len(mappings_raw) <= 128:
                fail("malformed_overlay_set")
            mappings = []
            for mapping in mappings_raw:
                if not isinstance(mapping, dict):
                    fail("malformed_overlay_set")
                mappings.append((
                    relative_parts(mapping.get("from")),
                    relative_parts(mapping.get("to")),
                ))
            if len(set(mappings)) != len(mappings):
                fail("malformed_overlay_set")
        for _, target in mappings:
            for other in claimed_targets:
                if target != other and (under(target, other) or under(other, target)):
                    fail("unsafe_overlay_path")
            if target not in claimed_targets:
                claimed_targets.append(target)

        encoded = entry.get("tarGzipBase64")
        if not isinstance(encoded, str) or not encoded:
            fail("malformed_overlay_set")
        try:
            archive = base64.b64decode(encoded, validate=True)
        except Exception:
            fail("malformed_overlay_set")
        if len(archive) > MAX_OVERLAY_BYTES or archive[:2] != b"\\x1f\\x8b":
            fail("malformed_overlay_set")
        declared_digest = entry.get("contentSha256")
        actual_digest = "sha256:" + hashlib.sha256(archive).hexdigest()
        if declared_digest is not None and declared_digest != actual_digest:
            fail("overlay_digest_mismatch")
        if version == 2 and declared_digest != actual_digest:
            fail("malformed_overlay_set")
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
            members = tar.getmembers()
            member_count += len(members)
            if member_count > MAX_MEMBERS:
                fail("malformed_overlay_set")
            for member in members:
                if not (member.isfile() or member.isdir()):
                    fail("unsafe_overlay_path")
                member_parts = relative_parts(member.name, allow_root=True)
                if member_parts and not any(under(member_parts, source) for source, _ in mappings):
                    fail("unsafe_overlay_path")
                extracted_bytes += max(0, member.size)
                if extracted_bytes > MAX_EXTRACTED_BYTES:
                    fail("malformed_overlay_set")
        prepared.append((mappings, archive))

    root = Path(sys.argv[2]).resolve()
    with tempfile.TemporaryDirectory(prefix="wfb-overlay-set-") as staging_raw:
        staging_root = Path(staging_raw)
        staged = []
        for index, (mappings, archive) in enumerate(prepared):
            stage = staging_root / str(index)
            stage.mkdir()
            with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
                tar.extractall(stage, filter="data")
            staged.append((stage, mappings))

        selected = {}
        signatures = {}
        for stage, mappings in staged:
            for source_parts, target_parts in mappings:
                source = stage.joinpath(*source_parts)
                signature = tree_signature(source)
                if target_parts in signatures and signatures[target_parts] != signature:
                    fail("overlay_target_conflict")
                signatures[target_parts] = signature
                selected[target_parts] = source

        for target_parts, source in selected.items():
            target = root.joinpath(*target_parts)
            try:
                target.resolve(strict=False).relative_to(root)
            except ValueError:
                fail("unsafe_overlay_path")
            if target.is_symlink() or target.is_file():
                target.unlink()
            elif target.is_dir():
                shutil.rmtree(target)
            if source.is_dir():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(source, target)
            elif source.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
    print("OVERLAY_SET_APPLIED=" + str(len(prepared)))
except SystemExit:
    raise
except Exception:
    fail("malformed_overlay_set")`;

function promotionInputError(
  input: SourceBundlePromotionRunnerInput,
): string | null {
  if (input.branchLease !== undefined) {
    if (input.branchName === undefined || input.tier !== "tar-overlay-set") {
      return "invalid_branch_lease";
    }
    const expected = input.branchLease.expectedHeadSha;
    if (expected !== null && !FULL_SHA.test(expected)) {
      return "invalid_branch_lease";
    }
    const existing = input.branchLease.existingPullRequestNumber;
    if (
      existing !== undefined &&
      (!Number.isSafeInteger(existing) ||
        existing < 1 ||
        expected === null ||
        input.mode !== "pr")
    ) {
      return "invalid_branch_lease";
    }
  }
  if (input.branchName !== undefined) {
    if (!isSafeExactBranch(input.branchName)) return "invalid_branch_name";
    if (input.tier !== "tar-overlay-set") return "invalid_idempotent_tier";
  }
  if (
    input.tier === "tar-overlay-set" &&
    !FULL_SHA.test(input.baseRevision ?? "")
  ) {
    return "invalid_base_revision";
  }
  if (input.tier !== "tar-overlay") return null;
  if (!isSafeRelativePath(input.repoSubdir, true)) return "unsafe_overlay_path";
  if (
    !Array.isArray(input.syncPaths) ||
    input.syncPaths.length === 0 ||
    input.syncPaths.some((path) => !isSafeRelativePath(path, false))
  ) {
    return "unsafe_overlay_path";
  }
  return null;
}

function isSafeExactBranch(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw === raw.trim() &&
    SAFE_BRANCH.test(raw) &&
    !raw.includes("..") &&
    !raw.includes("@{") &&
    !raw.endsWith("/") &&
    !raw.endsWith(".") &&
    !raw.endsWith(".lock")
  );
}

function decodeChangedPaths(encoded: string): readonly string[] {
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > 10_000 ||
    parsed.some(
      (path) =>
        typeof path !== "string" ||
        !path ||
        path.startsWith("/") ||
        path.includes("\0") ||
        path.split("/").includes(".."),
    )
  ) {
    throw new Error("invalid changed paths");
  }
  return Object.freeze([...new Set(parsed as string[])].sort());
}

function isSafeRelativePath(raw: unknown, allowRoot: boolean): boolean {
  if (
    typeof raw !== "string" ||
    raw !== raw.trim() ||
    raw.includes("\\") ||
    raw.includes("\0")
  ) {
    return false;
  }
  if (raw.startsWith("/")) return false;
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) return false;
  return allowRoot || parts.length > 0;
}

function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** Escape a string to a JSON-inner literal (no surrounding quotes) so it can be
 * safely spliced into a JSON payload assembled in-shell (quotes/newlines handled). */
function jsonInner(value: string): string {
  const encoded = JSON.stringify(String(value ?? ""));
  return encoded.slice(1, -1);
}

/** Reduce a caller-supplied branch prefix to a safe git ref segment. */
function sanitizeBranchPrefix(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 80);
}
