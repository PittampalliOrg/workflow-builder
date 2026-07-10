import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("PR preview hexagonal boundary", () => {
  it("keeps GitHub, SEA, Kubernetes, and persistence behind ports", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/server/application/pr-previews.ts"),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    expect(imports).toEqual(["$lib/server/application/ports"]);
    expect(source).not.toContain("$lib/server/workflows");
    expect(source).not.toContain("$lib/server/kube");
    expect(source).not.toContain("$lib/server/db");
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
