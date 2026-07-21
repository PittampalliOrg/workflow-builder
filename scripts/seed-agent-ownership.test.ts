import { describe, expect, it } from "vitest";
import { assertSeedAgentOwnership } from "./seed-agent-ownership";

describe("assertSeedAgentOwnership", () => {
  it("allows the targeted owner and project", () => {
    expect(() =>
      assertSeedAgentOwnership(
        "platform-incident-analyst-agent",
        { userId: "user-1", projectId: "project-1" },
        { userId: "user-1", projectId: "project-1" },
      ),
    ).not.toThrow();
  });

  it("fails closed on a cross-project slug collision", () => {
    expect(() =>
      assertSeedAgentOwnership(
        "platform-incident-analyst-agent",
        { userId: "user-2", projectId: "project-2" },
        { userId: "user-1", projectId: "project-1" },
      ),
    ).toThrow(/already exists for user user-2 project project-2/);
  });
});
