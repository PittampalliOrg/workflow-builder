import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("preview session continuation hexagonal boundary", () => {
  it("keeps public continuation orchestration dependent on application ports", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/server/application/preview-session-continuation.ts",
      ),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );

    expect(imports).toEqual(["$lib/server/application/ports"]);
    expect(source).not.toContain("$lib/server/application/adapters");
    expect(source).not.toContain("$lib/server/workflows");
    expect(source).not.toContain("$lib/server/db");
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
