import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { GithubPreviewGateBaseCatalogAdapter } from "$lib/server/application/adapters/preview-control";

const BASE_SHA = "a".repeat(40);

describe("GithubPreviewGateBaseCatalogAdapter", () => {
  it("recomputes the exact-base catalog digest instead of trusting its claim", async () => {
    const source = await readFile(
      new URL(
        "../../../../../services/shared/dev-preview-service-catalog.json",
        import.meta.url,
      ),
      "utf8",
    );
    const catalog = JSON.parse(source) as Record<string, unknown>;
    const fetchImpl = vi.fn(async () =>
      Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(source).toString("base64"),
      }),
    );
    const adapter = new GithubPreviewGateBaseCatalogAdapter({
      token: () => "read-token",
      fetch: fetchImpl as typeof fetch,
    });
    await expect(
      adapter.loadAt({
        repository: "PittampalliOrg/workflow-builder",
        baseSha: BASE_SHA as never,
      }),
    ).resolves.toMatchObject({ catalogDigest: catalog.catalogDigest });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.github.com/repos/PittampalliOrg/workflow-builder/contents/services/shared/dev-preview-service-catalog.json?ref=${BASE_SHA}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer read-token",
        }),
      }),
    );

    const tampered = JSON.stringify({
      ...catalog,
      services: [],
    });
    const rejected = new GithubPreviewGateBaseCatalogAdapter({
      token: () => "read-token",
      fetch: vi.fn(async () =>
        Response.json({
          encoding: "base64",
          content: Buffer.from(tampered).toString("base64"),
        }),
      ) as typeof fetch,
    });
    await expect(
      rejected.loadAt({
        repository: "PittampalliOrg/workflow-builder",
        baseSha: BASE_SHA as never,
      }),
    ).rejects.toThrow("base preview catalog digest is invalid");
  });
});
