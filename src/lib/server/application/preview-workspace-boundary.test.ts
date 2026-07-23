import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("preview workspace hexagonal boundary", () => {
  it("keeps framework, auth, and composition concerns out of the use case", () => {
    const source = readFileSync(
      new URL("./preview-workspace.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/@sveltejs\/kit|\$app\//);
    expect(source).not.toContain("getApplicationAdapters");
    expect(source).not.toContain("internal-auth");
  });

  it("keeps exact source authorization in an application use case behind narrow ports", () => {
    const sourceBroker = readFileSync(
      resolve(
        repoRoot,
        "src/lib/server/application/preview-workspace-source-broker.ts",
      ),
      "utf8",
    );
    const port = readFileSync(
      resolve(
        repoRoot,
        "src/lib/server/application/ports/preview-workspace.ts",
      ),
      "utf8",
    );
    const importTargets = [
      ...sourceBroker.matchAll(/from\s+["']([^"']+)["']/g),
    ].map((match) => match[1]);
    const sourceRequest = port.match(
      /export type PreviewWorkspaceSourceBundleRequest = Readonly<\{[\s\S]*?\}>;/,
    )?.[0];
    const seedCommand = port.match(
      /export type PreviewWorkspaceSeedCommand = Readonly<\{[\s\S]*?\}>;/,
    )?.[0];

    expect(new Set(importTargets)).toEqual(
      new Set(["$lib/server/application/ports"]),
    );
    expect(sourceBroker).toContain("authorizeRuntime");
    expect(sourceBroker).toContain("catalog.resolve");
    expect(sourceBroker).toContain("git.fetchExact");
    expect(port).toContain("interface PreviewWorkspaceSourceBundlePort");
    expect(port).toContain("interface PreviewWorkspaceGitBundlePort");
    expect(sourceRequest).toContain("identity: PreviewControlIdentity");
    expect(sourceRequest).toContain("service: string");
    expect(sourceRequest).not.toContain("repository");
    expect(sourceRequest).not.toContain("sourceRevision");
    expect(sourceRequest).not.toContain("token");
    expect(seedCommand).toContain("sourceBundle: Uint8Array");
    expect(seedCommand).toContain("sourceBundleSha256");
    expect(seedCommand).not.toContain("token");
    expect(seedCommand).not.toContain("secret");

    for (const source of [sourceBroker, port]) {
      expect(source).not.toContain("$lib/server/application/adapters");
      expect(source).not.toContain("$lib/server/internal-auth");
      expect(source).not.toContain("$lib/server/workflows");
      expect(source).not.toContain("$env/");
      expect(source).not.toContain("GITHUB_TOKEN");
      expect(source).not.toMatch(/\bfetch\s*\(/);
    }
    expect(sourceBroker).not.toContain("getApplicationAdapters");
    expect(sourceBroker).not.toContain("node:");
  });

  it("keeps the workspace source route as a thin authenticated inbound adapter", () => {
    const route = readFileSync(
      resolve(
        repoRoot,
        "src/routes/api/internal/preview-control/environment/workspace-source/+server.ts",
      ),
      "utf8",
    );

    expect(route).toContain("requirePreviewControlCapability");
    expect(route).toContain("previewWorkspaceSourceBroker.fetchExact");
    expect(route).toContain("readBoundedJsonObject");
    expect(route).toContain('"Cache-Control": "no-store"');
    expect(route).not.toContain("$lib/server/application/adapters");
    expect(route).not.toContain("$lib/server/workflows");
    expect(route).not.toContain("$lib/server/kube");
    expect(route).not.toContain("GITHUB_TOKEN");
    expect(route).not.toContain("getPreviewGithubReadToken");
    expect(route).not.toMatch(/\bfetch\s*\(/);
  });
});
