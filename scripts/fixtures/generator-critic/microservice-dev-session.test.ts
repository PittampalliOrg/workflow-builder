import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const fixture = JSON.parse(
  readFileSync(
    new URL("./microservice-dev-session.json", import.meta.url),
    "utf8",
  ),
);
const catalogServices = [
  "workflow-builder",
  "workflow-orchestrator",
  "function-router",
  "mcp-gateway",
  "workflow-mcp-server",
];
const inputProperties = fixture.input.schema.document.properties;
const provision = fixture.do.find(
  (entry: Record<string, unknown>) => "provision_preview" in entry,
).provision_preview;
const cloneStep = fixture.do.find(
  (entry: Record<string, unknown>) => "clone_repo" in entry,
).clone_repo;
const cloneCommand = cloneStep.with.command as string;
const cloneTimeoutMs = cloneStep.with.timeoutMs as number;
const commandText = cloneCommand.replaceAll('\\"', '"');
const handoffInstructions = fixture.do.find(
  (entry: Record<string, unknown>) => "handoff" in entry,
).handoff.with.instructions as string;

function previewActions(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(previewActions);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const current =
    typeof record.call === "string" && record.call.startsWith("dev/preview")
      ? [record]
      : [];
  return [...current, ...Object.values(record).flatMap(previewActions)];
}

describe("microservice dev session source checkout", () => {
  it("defaults to the five-service preview-native baseline", () => {
    expect(inputProperties.mode.default).toBe("preview-native");
    expect(inputProperties.services.default).toEqual(catalogServices);
    expect(provision.with.mode).toContain('.trigger.mode // "preview-native"');
    expect(provision.with.services).toContain("workflow-mcp-server");
    for (const service of catalogServices) {
      expect(fixture.document.summary).toContain(service);
      expect(inputProperties.service.description).toContain(service);
    }
  });

  it("leaves preview execution authority to the trusted workflow context", () => {
    expect(provision.with).not.toHaveProperty("executionId");
  });

  it("keeps every fixture preview action bound to the activity envelope", () => {
    const actions = readdirSync(new URL(".", import.meta.url))
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) =>
        previewActions(
          JSON.parse(
            readFileSync(new URL(name, import.meta.url), "utf8"),
          ) as unknown,
        ),
      );
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.with).not.toHaveProperty("executionId");
    }
  });

  it("exports preview-native by default and keeps host throwaway explicit", () => {
    expect(cloneCommand).toContain('.trigger.mode // "preview-native"');
    expect(cloneCommand).toContain("export MODE=");
    expect(commandText).toContain("host-throwaway|preview-native");
    expect(commandText).toContain("${GITHUB_TOKEN:-}");
    expect(commandText).toContain(
      'test "$REPOURL" = PittampalliOrg/workflow-builder',
    );
    expect(commandText).toContain(
      'CLONE_URL="https://github.com/$REPOURL.git"',
    );
    expect(commandText).not.toContain("https://x-access-token:");
    expect(commandText).toContain(
      'git clone --filter=blob:none --no-checkout --depth 1 --single-branch "$CLONE_URL" "$LOCAL_REPO"',
    );
  });

  it("fails closed on preview-native runs without an immutable source revision", () => {
    expect(commandText).toContain('[ "$MODE" = preview-native ]');
    expect(commandText).toContain(
      "preview-native requires a lowercase 40-hex sourceRevision",
    );
    expect(commandText).toContain("grep -Eq '^[0-9a-f]{40}$'");
  });

  it("checks out the exact detached commit and proves the resulting HEAD", () => {
    expect(commandText).toContain(
      'git -C "$LOCAL_REPO" fetch --no-tags --depth 1 origin',
    );
    expect(commandText).toContain(
      'git -C "$LOCAL_REPO" checkout --detach "$TARGET_REVISION"',
    );
    expect(commandText).toContain(
      'ACTUAL_REVISION=$(git -C "$LOCAL_REPO" rev-parse HEAD)',
    );
    expect(commandText).toContain(
      'test "$ACTUAL_REVISION" = "$SOURCE_REVISION"',
    );
    expect(commandText).toContain(
      '"$ACTUAL_REVISION" > "$LOCAL_REPO/.git/wfb-preview-source-revision"',
    );
  });

  it("uses one bounded Python stdlib metadata materializer without jq", () => {
    expect(commandText).toContain("python3 - <<'PY_PREVIEW_METADATA'");
    expect(commandText).toContain("base64.b64decode(encoded, validate=True)");
    expect(commandText).toContain("shlex.quote(value)");
    expect(commandText).toContain("repository_path(repo_subdir, source)");
    expect(commandText).toContain("os.chmod(path, 0o600)");
    expect(commandText).toContain("PY_PREVIEW_METADATA");
    expect(commandText).not.toContain("jq");
  });

  it("establishes tokenless Git authentication before sparse operations", () => {
    const askpass = commandText.indexOf('export GIT_ASKPASS');
    const clone = commandText.indexOf('git clone --filter=blob:none');
    const credential = commandText.indexOf('config credential.helper');
    const fetch = commandText.indexOf('fetch --no-tags --depth 1');
    const sparse = commandText.indexOf('sparse-checkout init --cone');
    expect(askpass).toBeGreaterThan(-1);
    expect(askpass).toBeLessThan(clone);
    expect(credential).toBeGreaterThan(clone);
    expect(credential).toBeLessThan(fetch);
    expect(credential).toBeLessThan(sparse);
    expect(commandText).not.toContain("http.extraHeader");
  });

  it("moves one verified archive onto shared storage without extracting the repo there", () => {
    expect(commandText).toContain(
      "LOCAL_ROOT=$(mktemp -d /tmp/wfb-preview-checkout.XXXXXX)",
    );
    expect(commandText).toContain(
      'TREE_ENTRY=$(git -C "$LOCAL_REPO" ls-tree "$TARGET_REVISION" -- "$path")',
    );
    expect(commandText).not.toContain("cat-file -t");
    expect(commandText).toContain(
      'git -C "$LOCAL_REPO" sparse-checkout init --cone',
    );
    expect(commandText).toContain(
      'git -C "$LOCAL_REPO" sparse-checkout set --stdin < .sparse-cones',
    );
    expect(commandText).toContain(
      'tar -C "$LOCAL_REPO" -cf "$LOCAL_ROOT/repo.tar" .',
    );
    expect(commandText).toContain(
      'ARCHIVE_DIGEST=$(sha256sum "$LOCAL_ROOT/repo.tar")',
    );
    expect(commandText).toContain(
      'cp "$LOCAL_ROOT/repo.tar" "$SHARED_ARCHIVE_TMP"',
    );
    expect(commandText).toContain('chmod 600 "$SHARED_ARCHIVE_TMP"');
    expect(commandText).toContain(
      'mv -f "$SHARED_ARCHIVE_TMP" /sandbox/work/repo.tar',
    );
    expect(commandText).not.toContain("mkdir repo");
    expect(commandText).not.toContain("tar -C repo -xf");
  });

  it("activates the archive exactly once on pod-local storage and safely reuses edits", () => {
    expect(commandText).toContain("cat <<'ACTIVATE_REPO'");
    expect(commandText).toContain("WORKSPACE=/sandbox/work");
    expect(commandText).toContain("LOCAL_REPO=/tmp/wfb-dev-repo");
    expect(commandText).toContain('[ ! -L "$LOCAL_REPO" ] || fail');
    expect(commandText).toContain(
      "REPO_STAGING=$(mktemp -d /tmp/wfb-dev-repo.activate.XXXXXX)",
    );
    expect(commandText).toContain(
      "LOCAL_ARCHIVE=$(mktemp /tmp/wfb-dev-repo.archive.XXXXXX)",
    );
    expect(commandText).toContain('cp "$ARCHIVE" "$LOCAL_ARCHIVE"');
    expect(commandText).toContain('chmod 600 "$LOCAL_ARCHIVE"');
    expect(commandText).not.toContain(".archive.$$");
    expect(commandText).toContain(
      'test "$ACTUAL_DIGEST" = "$EXPECTED_DIGEST"',
    );
    expect(commandText).toContain(
      'tar -C "$REPO_STAGING" -xf "$LOCAL_ARCHIVE"',
    );
    expect(commandText).toContain(
      'test -z "$(git -C "$REPO_STAGING" status --porcelain --untracked-files=all)"',
    );
    expect(commandText).toContain(
      'mv -Tf "$LINK_STAGING" "$REPO_LINK"',
    );
    expect(commandText).toContain("wfb-preview-archive-sha256");
    expect(commandText).toContain('echo REUSED "$ACTIVE_REVISION"');
    expect(commandText).not.toContain('rm -rf "$LOCAL_REPO"');
    expect(commandText).toContain('chmod 700 "$SHARED_ACTIVATOR_TMP"');
  });

  it("keeps every transport and capability path outside the generic root diff", () => {
    expect(commandText).toContain("cat > .gitignore <<'WFB_ROOT_GITIGNORE'");
    for (const path of [
      "/repo",
      "/repo.tar",
      "/repo.tar.sha256",
      "/activate-repo.sh",
      "/sync.sh",
      "/.syncenv",
      "/.syncenv.d",
      "/.preview-services.json",
      "/.preview-services-summary",
      "/.sparse-paths",
      "/.sparse-cones",
      "/.sparse-cones.unsorted",
      "/.syncdeps.*",
      "/.repo.tar.tmp.*",
      "/.repo.tar.sha256.tmp.*",
      "/.activate-repo.tmp.*",
    ]) {
      expect(commandText).toContain(`${path}\\n`);
      expect(commandText).not.toContain(`${path}/\\n`);
    }
    expect(commandText).toContain("rm -f repo.tar repo.tar.sha256 activate-repo.sh sync.sh .syncdeps.*");
  });

  it("allows the bounded shared-storage cold checkout to finish", () => {
    expect(cloneTimeoutMs).toBe(1_500_000);
  });

  it("tells the interactive agent to apply hot-synced schema changes explicitly", () => {
    expect(handoffInstructions).toContain("allowlisted migrate action");
  });

  it("requires local activation before readiness and documents the POC capture boundary", () => {
    const activate = handoffInstructions.indexOf(
      "run /sandbox/work/activate-repo.sh once",
    );
    const ready = handoffInstructions.indexOf("reply 'ready'");
    expect(activate).toBeGreaterThan(-1);
    expect(activate).toBeLessThan(ready);
    expect(handoffInstructions).toContain(
      "receiver-owned preview continuation capture is authoritative",
    );
    expect(handoffInstructions).toContain(
      "Generic CLI diff/source-bundle finalizers intentionally do not follow",
    );
  });

  it("hands off only after every service has a ready sync endpoint", () => {
    expect(commandText).toContain('entry.get("ok") is not True');
    expect(commandText).toContain('info.get("ready") is not True');
    expect(commandText).toContain('sync_url = safe_text(info.get("syncUrl")');
    expect(commandText).toContain("failed to materialize trusted preview service metadata");
  });

  it("uses the orchestrator's bounded durable activation poll", () => {
    expect(provision.with).toMatchObject({
      timeoutMs: 600_000,
      activationTimeoutSeconds: 300,
      activationPollSeconds: 2,
      activationMaxAttempts: 151,
    });
  });
});
