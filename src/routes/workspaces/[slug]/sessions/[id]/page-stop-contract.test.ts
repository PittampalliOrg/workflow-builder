import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("session stop UI contract", () => {
  it("uses nondestructive terminate for Stop run and reserves reset for cleanup", () => {
    const source = readFileSync(
      new URL("./+page.svelte", import.meta.url),
      "utf8",
    );
    const stopSurface = source.slice(
      source.indexOf("async function pollStopStatus"),
      source.indexOf("// Pause / Resume"),
    );

    expect(source).toContain("stopRun('terminate')");
    expect(source).toContain("stopRun('reset')");
    expect(source).not.toContain("stopRun('purge')");
    expect(stopSurface.match(/await initialLoad\(\);/g)).toHaveLength(2);
    expect(stopSurface.match(/await checkSandboxLiveness\(\);/g)).toHaveLength(
      2,
    );
  });
});
