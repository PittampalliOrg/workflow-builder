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
const cloneCommand = fixture.do.find(
  (entry: Record<string, unknown>) => "clone_repo" in entry,
).clone_repo.with.command as string;
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
    expect(commandText).toContain("https://github.com/$REPOURL.git");
    expect(commandText).toContain(
      'git clone --filter=blob:none "$CLONE_URL" repo',
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
      "git -C repo fetch --no-tags --depth 1 origin",
    );
    expect(commandText).toContain("git -C repo checkout --detach");
    expect(commandText).toContain(
      "ACTUAL_REVISION=$(git -C repo rev-parse HEAD)",
    );
    expect(commandText).toContain(
      'test "$ACTUAL_REVISION" = "$SOURCE_REVISION"',
    );
  });

  it("tells the interactive agent to apply hot-synced schema changes explicitly", () => {
    expect(handoffInstructions).toContain("allowlisted migrate action");
  });

  it("hands off only after every service has a ready sync endpoint", () => {
    expect(commandText).toContain(".ok == true and .info.ready == true");
    expect(commandText).toContain(".info.syncUrl");
    expect(commandText).toContain("full preview service set is not ready");
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
