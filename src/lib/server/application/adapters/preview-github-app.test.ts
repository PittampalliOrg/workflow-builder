import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createGithubAppJwt,
  GithubAppInstallationTokenAdapter,
} from "$lib/server/application/adapters/preview-github-app";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("GithubAppInstallationTokenAdapter", () => {
  it("signs a bounded JWT and exchanges it for one scoped installation token", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        token: "installation-token",
        expires_at: "2026-07-10T13:00:00.000Z",
      }),
    );
    const adapter = new GithubAppInstallationTokenAdapter({
      appId: () => "2970091",
      installationId: () => "112998814",
      privateKey: () => privateKey,
      repositories: ["workflow-builder", "stacks"],
      permissions: {
        contents: "read",
        pull_requests: "read",
        statuses: "write",
      },
      now: () => NOW,
      fetch: fetchImpl as typeof fetch,
    });

    await expect(adapter.token()).resolves.toBe("installation-token");
    await expect(adapter.token()).resolves.toBe("installation-token");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.github.com/app/installations/112998814/access_tokens",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      repositories: ["workflow-builder", "stacks"],
      permissions: {
        contents: "read",
        pull_requests: "read",
        statuses: "write",
      },
    });
    const authorization = String(
      (init.headers as Record<string, string>).Authorization,
    );
    const jwt = authorization.replace(/^Bearer /, "");
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      iat: Math.floor(NOW.getTime() / 1_000) - 60,
      exp: Math.floor(NOW.getTime() / 1_000) + 8 * 60,
      iss: "2970091",
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(
      true,
    );
  });

  it("rejects missing credentials and an over-broad or malformed scope", async () => {
    expect(
      () =>
        new GithubAppInstallationTokenAdapter({
          repositories: ["PittampalliOrg/workflow-builder"],
          permissions: { contents: "read" },
        }),
    ).toThrow("token scope is invalid");
    const adapter = new GithubAppInstallationTokenAdapter({
      appId: () => null,
      installationId: () => null,
      privateKey: () => null,
      repositories: ["workflow-builder"],
      permissions: { contents: "read" },
      fetch: vi.fn() as typeof fetch,
    });
    await expect(adapter.token()).rejects.toThrow("credentials are not configured");
  });

  it("rejects malformed JWT inputs before any network exchange", () => {
    expect(() => createGithubAppJwt("not-an-id", privateKey, NOW)).toThrow(
      "identity is invalid",
    );
  });
});
