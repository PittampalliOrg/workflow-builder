import { describe, expect, it } from "vitest";

import {
  buildSpec,
  KIMI_AGENT_CONFIG,
  KIMI_AGENT_SLUG,
  parseArgs,
} from "./upsert-3b1b-animation-workflow";

describe("3B1B Kimi K3 workflow upsert", () => {
  it("defines a dapr-agent-py Kimi K3 agent at max reasoning and 1M context", () => {
    expect(KIMI_AGENT_SLUG).toBe("kimi-k3-3b1b-animation-builder");
    expect(KIMI_AGENT_CONFIG).toMatchObject({
      runtime: "dapr-agent-py",
      modelSpec: "kimi/kimi-k3",
      reasoningEffort: "max",
      contextWindowTokens: 1_048_576,
      builtinTools: [
        "execute_command",
        "read_file",
        "write_file",
        "edit_file",
        "list_files",
        "glob_files",
        "grep_search",
      ],
    });
  });

  it("binds the durable animation step to the exact published agent version", () => {
    const agentRef = { id: "agnt_kimi_k3_3b1b", version: 3 };
    const spec = buildSpec(agentRef) as {
      do: Array<Record<string, { with: { body: { agentRef: unknown } } }>>;
    };

    expect(spec.do[1].build_3b1b_animation.with.body.agentRef).toEqual(
      agentRef,
    );
    expect(JSON.stringify(spec)).not.toContain("agnt_claude_code_sdk_smoke");
  });

  it("uses the managed Kimi agent by default and preserves explicit overrides", () => {
    expect(parseArgs([])).toEqual({ userEmail: "" });
    expect(
      parseArgs(["--agent-id", "agnt_override", "--agent-version", "4"]),
    ).toEqual({
      userEmail: "",
      agentOverride: { id: "agnt_override", version: 4 },
    });
  });

  it("rejects an agent version without an agent id", () => {
    expect(() => parseArgs(["--agent-version", "1"])).toThrow(
      "--agent-version requires --agent-id",
    );
  });
});
