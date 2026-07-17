import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateScript } from "./sandbox.js";

const fixture = readFileSync(
  new URL(
    "../../../scripts/fixtures/dynamic-scripts/kimi-k3-3blue1brown-animation.js",
    import.meta.url,
  ),
  "utf8",
);

describe("fresh Kimi K3 3Blue1Brown animation dynamic script", () => {
  it("validates the rendered Kimi K3 script with one agent call", async () => {
    const script = fixture
      .replaceAll("__KIMI_AGENT_ID_JSON__", JSON.stringify("agent-kimi-k3"))
      .replaceAll("__KIMI_AGENT_VERSION__", "1");

    expect(script).not.toMatch(/__[A-Z0-9_]+__/);
    const result = await validateScript(script);

    expect(result.ok, result.error).toBe(true);
    expect(result.estimatedAgentCalls).toBe(1);
  });
});
