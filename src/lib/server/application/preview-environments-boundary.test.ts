import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("preview environment hexagonal boundary", () => {
  it("keeps the application service independent of infrastructure and legacy clients", () => {
    const source = readFileSync(
      resolve(repoRoot, "src/lib/server/application/preview-environments.ts"),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );

    expect(imports).toEqual([
      "$lib/server/application/ports/preview-environments",
    ]);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain("$lib/server/workflows");
    expect(source).not.toContain("$lib/server/kubernetes");
    expect(source).not.toContain("@kubernetes");
    expect(source).not.toContain("github.com");
    expect(source).not.toMatch(/https?:\/\//);
  });

  it("owns the compatibility provisioner in the preview port, not benchmarks", () => {
    const modelPort = readFileSync(
      resolve(
        repoRoot,
        "src/lib/server/application/ports/preview-environments.ts",
      ),
      "utf8",
    );
    const compatibilityPort = readFileSync(
      resolve(
        repoRoot,
        "src/lib/server/application/ports/dev-preview-provisioner.ts",
      ),
      "utf8",
    );
    const benchmarkPort = readFileSync(
      resolve(repoRoot, "src/lib/server/application/ports/benchmarks.ts"),
      "utf8",
    );
    const barrel = readFileSync(
      resolve(repoRoot, "src/lib/server/application/ports.ts"),
      "utf8",
    );

    expect(compatibilityPort).toContain(
      "export interface PreviewEnvironmentProvisioner",
    );
    expect(compatibilityPort).not.toMatch(/^import /m);
    expect(compatibilityPort).not.toContain("$lib/server/workflows");
    expect(modelPort).not.toMatch(/^import /m);
    expect(benchmarkPort).not.toContain("PreviewEnvironmentProvisioner");
    expect(benchmarkPort).not.toContain("$lib/server/workflows/dev-preview");
    expect(barrel).toContain('export * from "./ports/dev-preview-provisioner"');
    expect(barrel).toContain('export * from "./ports/preview-environments"');
  });
});
