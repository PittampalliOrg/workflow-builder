import { describe, expect, it } from "vitest";
import { sanitizeExecutionLogValue } from "./execution-logger.js";

describe("execution log redaction", () => {
  it("redacts sensitive env vars, headers, object keys, and URL auth material", () => {
    const sanitized = sanitizeExecutionLogValue({
      command:
        "OPENAI_API_KEY=sk-live curl 'https://user:pass@example.test/path?token=abc&safe=1' -H 'Authorization: Bearer secret-token'",
      env: {
        openaiApiKey: "sk-camel",
        GITHUB_TOKEN: "ghp_secret",
        NORMAL_FLAG: "1",
      },
      nested: {
        callbackUrl: "https://example.test/hook?api_key=123&name=ok",
        clientSecret: "oauth-secret",
        secretToken: "session-token",
        password: "plain",
      },
    });

    expect(JSON.stringify(sanitized)).not.toContain("sk-live");
    expect(JSON.stringify(sanitized)).not.toContain("sk-camel");
    expect(JSON.stringify(sanitized)).not.toContain("ghp_secret");
    expect(JSON.stringify(sanitized)).not.toContain("oauth-secret");
    expect(JSON.stringify(sanitized)).not.toContain("session-token");
    expect(JSON.stringify(sanitized)).not.toContain("secret-token");
    expect(JSON.stringify(sanitized)).not.toContain("api_key=123");
    expect(sanitized).toMatchObject({
      env: {
        openaiApiKey: "[REDACTED]",
        GITHUB_TOKEN: "[REDACTED]",
        NORMAL_FLAG: "1",
      },
      nested: {
        clientSecret: "[REDACTED]",
        secretToken: "[REDACTED]",
        password: "[REDACTED]",
      },
    });
  });
});
