import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./action-properties.svelte", import.meta.url),
  "utf8",
);

describe("action properties structured-output provider resolution", () => {
  it("resolves the shared structured-output call to its Kimi K3 catalog action", () => {
    expect(source).toContain(
      "componentName.includes('kimi') && haystack.includes('kimi')",
    );
    expect(source).toContain(
      "a.id === 'system-dapr-converse-kimi-k3-structured'",
    );
    expect(source).toContain("if (kimiK3Default) return kimiK3Default");
  });
});
