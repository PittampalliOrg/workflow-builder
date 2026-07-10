import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GithubPreviewAcceptanceCommitStatusAdapter } from "$lib/server/application/adapters/preview-control";

const HEAD_SHA = "b".repeat(40) as never;
const BASE_SHA = "a".repeat(40) as never;
const ATTESTATION_ROOT = "r".repeat(64);
const ACCEPTANCE_REQUIREMENT = `sha256:${"c".repeat(64)}` as const;
const ACTIVATION_REQUIREMENT = `sha256:${"d".repeat(64)}` as const;
const ACCEPTANCE_RECEIPT = `sha256:${"e".repeat(64)}` as const;
const ACTIVATION_RECEIPT = `sha256:${"f".repeat(64)}` as const;

function attestedTarget(
  context: "preview/immutable-acceptance" | "preview/activation-images",
  state: "success" | "failure" | "error",
  description: string,
  requirementDigest: `sha256:${string}`,
  evidenceReceiptDigest?: `sha256:${string}`,
) {
  const key = createHmac("sha256", ATTESTATION_ROOT)
    .update("preview-status-attestation-v2")
    .digest();
  const signature = createHmac("sha256", key)
    .update(
      [
        "PittampalliOrg/workflow-builder",
        "42",
        BASE_SHA,
        HEAD_SHA,
        context,
        state,
        description,
        requirementDigest,
        state === "success" ? (evidenceReceiptDigest ?? "") : "",
      ].join("\0"),
    )
    .digest("hex");
  return `https://github.com/PittampalliOrg/workflow-builder/pull/42?preview_attestation=v2.${signature}`;
}

function legacyAttestedTarget(
  context: "preview/immutable-acceptance" | "preview/activation-images",
  state: "success" | "failure" | "error",
  description: string,
) {
  const key = createHmac("sha256", ATTESTATION_ROOT)
    .update("preview-status-attestation-v1")
    .digest();
  const signature = createHmac("sha256", key)
    .update(
      [
        "PittampalliOrg/workflow-builder",
        "42",
        BASE_SHA,
        HEAD_SHA,
        context,
        state,
        description,
      ].join("\0"),
    )
    .digest("hex");
  return `https://github.com/PittampalliOrg/workflow-builder/pull/42?preview_attestation=v1.${signature}`;
}

function observation(
  contexts: readonly (
    | "preview/immutable-acceptance"
    | "preview/activation-images"
  )[],
  receipts: Partial<
    Record<
      "preview/immutable-acceptance" | "preview/activation-images",
      `sha256:${string}` | null
    >
  > = {},
) {
  return {
    repository: "PittampalliOrg/workflow-builder",
    pullRequestNumber: 42,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    contexts,
    requirementDigests: {
      "preview/immutable-acceptance": ACCEPTANCE_REQUIREMENT,
      "preview/activation-images": ACTIVATION_REQUIREMENT,
    },
    evidenceReceiptDigests: {
      "preview/immutable-acceptance":
        receipts["preview/immutable-acceptance"] ?? null,
      "preview/activation-images":
        receipts["preview/activation-images"] ?? null,
    },
  } as const;
}

function input() {
  return {
    repository: "PittampalliOrg/workflow-builder",
    pullRequestNumber: 42,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    context: "preview/immutable-acceptance" as const,
    state: "success" as const,
    description: "Immutable preview acceptance passed for 1 service",
    requirementDigest: ACCEPTANCE_REQUIREMENT,
    evidenceReceiptDigest: ACCEPTANCE_RECEIPT,
  };
}

describe("GithubPreviewAcceptanceCommitStatusAdapter", () => {
  it("publishes a receipt-bound status on the exact verified head SHA", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    const adapter = new GithubPreviewAcceptanceCommitStatusAdapter({
      token: () => "write-token",
      attestationRoot: () => ATTESTATION_ROOT,
      fetch: fetchImpl as typeof fetch,
    });

    await adapter.publish(input());

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(url).toBe(
      `https://api.github.com/repos/PittampalliOrg/workflow-builder/statuses/${HEAD_SHA}`,
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer write-token",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      state: "success",
      context: "preview/immutable-acceptance",
      description: "Immutable preview acceptance passed for 1 service",
    });
    expect(body.target_url).toMatch(
      /^https:\/\/github\.com\/PittampalliOrg\/workflow-builder\/pull\/42\?preview_attestation=v2\.[0-9a-f]{64}$/,
    );
  });

  it("requires the physical GitHub App credential", async () => {
    const adapter = new GithubPreviewAcceptanceCommitStatusAdapter({
      token: () => null,
      fetch: vi.fn() as typeof fetch,
    });
    await expect(adapter.publish(input())).rejects.toThrow(
      "preview control GitHub App token is not configured",
    );
    await expect(
      adapter.latest(observation(["preview/immutable-acceptance"])),
    ).rejects.toThrow("preview control GitHub App token is not configured");
  });

  it("fails closed on an invalid tuple before network access", async () => {
    const fetchImpl = vi.fn();
    const adapter = new GithubPreviewAcceptanceCommitStatusAdapter({
      token: () => "write-token",
      attestationRoot: () => ATTESTATION_ROOT,
      fetch: fetchImpl as typeof fetch,
    });
    await expect(
      adapter.publish({ ...input(), headSha: "main" as never }),
    ).rejects.toThrow("commit status is invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("restricts publication to the preview governance contexts", async () => {
    const fetchImpl = vi.fn();
    const adapter = new GithubPreviewAcceptanceCommitStatusAdapter({
      token: () => "write-token",
      fetch: fetchImpl as typeof fetch,
    });
    await expect(
      adapter.publish({ ...input(), context: "checks" as never }),
    ).rejects.toThrow("commit status is invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires subordinate success to bind a durable receipt", async () => {
    const fetchImpl = vi.fn();
    const adapter = new GithubPreviewAcceptanceCommitStatusAdapter({
      token: () => "write-token",
      fetch: fetchImpl as typeof fetch,
    });
    const { evidenceReceiptDigest: _receipt, ...withoutReceipt } = input();
    await expect(adapter.publish(withoutReceipt)).rejects.toThrow(
      "commit status is invalid",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces GitHub rejection rather than treating an absent gate as success", async () => {
    const adapter = new GithubPreviewAcceptanceCommitStatusAdapter({
      token: () => "write-token",
      attestationRoot: () => ATTESTATION_ROOT,
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "Resource not accessible" }), {
            status: 403,
          }),
      ) as typeof fetch,
    });
    await expect(adapter.publish(input())).rejects.toThrow(
      "Resource not accessible",
    );
  });

  it("reads only exact-requirement, exact-receipt subordinate evidence", async () => {
    const activationDescription = "Activation image is pinned";
    const fetchImpl = vi.fn(async () =>
      Response.json([
        {
          sha: HEAD_SHA,
          context: "preview/activation-images",
          state: "success",
          description: activationDescription,
          target_url: attestedTarget(
            "preview/activation-images",
            "success",
            activationDescription,
            ACTIVATION_REQUIREMENT,
            ACTIVATION_RECEIPT,
          ),
        },
        {
          sha: HEAD_SHA,
          context: "preview/immutable-acceptance",
          state: "pending",
        },
        {
          sha: HEAD_SHA,
          context: "preview/activation-images",
          state: "failure",
        },
      ]),
    );
    const adapter = new GithubPreviewAcceptanceCommitStatusAdapter({
      token: () => "read-token",
      attestationRoot: () => ATTESTATION_ROOT,
      fetch: fetchImpl as typeof fetch,
    });
    await expect(
      adapter.latest(
        observation(
          ["preview/immutable-acceptance", "preview/activation-images"],
          { "preview/activation-images": ACTIVATION_RECEIPT },
        ),
      ),
    ).resolves.toEqual({
      "preview/immutable-acceptance": "pending",
      "preview/activation-images": "success",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.github.com/repos/PittampalliOrg/workflow-builder/commits/${HEAD_SHA}/statuses?per_page=100&page=1`,
      expect.any(Object),
    );
  });

  it("ignores an attestation for a different receipt", async () => {
    const description = "Activation images passed for 1 artifact";
    const adapter = new GithubPreviewAcceptanceCommitStatusAdapter({
      token: () => "read-token",
      attestationRoot: () => ATTESTATION_ROOT,
      fetch: vi.fn(async () =>
        Response.json([
          {
            sha: HEAD_SHA,
            context: "preview/activation-images",
            state: "success",
            description,
            target_url: attestedTarget(
              "preview/activation-images",
              "success",
              description,
              ACTIVATION_REQUIREMENT,
              `sha256:${"0".repeat(64)}`,
            ),
          },
        ]),
      ) as typeof fetch,
    });
    await expect(
      adapter.latest(
        observation(["preview/activation-images"], {
          "preview/activation-images": ACTIVATION_RECEIPT,
        }),
      ),
    ).resolves.toEqual({
      "preview/immutable-acceptance": null,
      "preview/activation-images": null,
    });
  });

  it("does not let an unsigned terminal status satisfy physical evidence", async () => {
    const adapter = new GithubPreviewAcceptanceCommitStatusAdapter({
      token: () => "read-token",
      attestationRoot: () => ATTESTATION_ROOT,
      fetch: vi.fn(async () =>
        Response.json([
          {
            sha: HEAD_SHA,
            context: "preview/activation-images",
            state: "success",
            description: "spoofed success",
            target_url:
              "https://github.com/PittampalliOrg/workflow-builder/pull/42",
          },
        ]),
      ) as typeof fetch,
    });
    await expect(
      adapter.latest(
        observation(["preview/activation-images"], {
          "preview/activation-images": ACTIVATION_RECEIPT,
        }),
      ),
    ).resolves.toEqual({
      "preview/immutable-acceptance": null,
      "preview/activation-images": null,
    });
  });

  it("does not accept legacy v1 evidence after the catalog contract changes", async () => {
    const description = "Activation images passed for 1 artifact";
    const adapter = new GithubPreviewAcceptanceCommitStatusAdapter({
      token: () => "read-token",
      attestationRoot: () => ATTESTATION_ROOT,
      fetch: vi.fn(async () =>
        Response.json([
          {
            sha: HEAD_SHA,
            context: "preview/activation-images",
            state: "success",
            description,
            target_url: legacyAttestedTarget(
              "preview/activation-images",
              "success",
              description,
            ),
          },
        ]),
      ) as typeof fetch,
    });
    await expect(
      adapter.latest(
        observation(["preview/activation-images"], {
          "preview/activation-images": ACTIVATION_RECEIPT,
        }),
      ),
    ).resolves.toEqual({
      "preview/immutable-acceptance": null,
      "preview/activation-images": null,
    });
  });

  it("does not let a later initializer pending erase signed terminal evidence", async () => {
    const description = "Activation images passed for 1 artifact";
    const adapter = new GithubPreviewAcceptanceCommitStatusAdapter({
      token: () => "read-token",
      attestationRoot: () => ATTESTATION_ROOT,
      fetch: vi.fn(async () =>
        Response.json([
          {
            sha: HEAD_SHA,
            context: "preview/activation-images",
            state: "pending",
            description: "Preview evidence required",
          },
          {
            sha: HEAD_SHA,
            context: "preview/activation-images",
            state: "success",
            description,
            target_url: attestedTarget(
              "preview/activation-images",
              "success",
              description,
              ACTIVATION_REQUIREMENT,
              ACTIVATION_RECEIPT,
            ),
          },
        ]),
      ) as typeof fetch,
    });
    await expect(
      adapter.latest(
        observation(["preview/activation-images"], {
          "preview/activation-images": ACTIVATION_RECEIPT,
        }),
      ),
    ).resolves.toEqual({
      "preview/immutable-acceptance": null,
      "preview/activation-images": "success",
    });
  });
});
