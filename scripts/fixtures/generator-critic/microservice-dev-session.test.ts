import { readFileSync } from "node:fs";
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
});
