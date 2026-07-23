import { gzipSync } from "node:zlib";
import * as tar from "tar-stream";
import { describe, expect, it, vi } from "vitest";
import {
  runOneShotPreviewWorkspaceHelper,
  validatePreviewWorkspaceArchive,
} from "./preview-workspace";

async function archive(
  entries: Array<{
    name: string;
    type?: "file" | "directory" | "symlink";
    body?: string;
    linkname?: string;
  }>,
): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    pack.entry(
      {
        name: entry.name,
        type: entry.type ?? "file",
        size: entry.type === "directory" ? 0 : body.byteLength,
        linkname: entry.linkname,
      },
      entry.type === "directory" ? undefined : body,
    );
  }
  const ended = new Promise<void>((resolve, reject) => {
    pack.on("end", resolve);
    pack.on("error", reject);
  });
  pack.finalize();
  await ended;
  return gzipSync(Buffer.concat(chunks));
}

describe("validatePreviewWorkspaceArchive", () => {
  it("accepts current SvelteKit route path syntax", async () => {
    const bytes = await archive([
      {
        name: "src/routes/(admin)/executions/[executionId]/+page.svelte",
        body: "page",
      },
    ]);
    await expect(validatePreviewWorkspaceArchive(bytes)).resolves.toEqual({
      fileCount: 1,
      memberCount: 1,
      expandedBytes: 4,
    });
  });

  it.each([
    { entries: [{ name: "src\\escape.ts", body: "bad" }] },
    { entries: [{ name: "../escape.ts", body: "bad" }] },
    {
      entries: [
        {
          name: "src/link",
          type: "symlink" as const,
          linkname: "/tmp/target",
        },
      ],
    },
    {
      entries: [
        { name: "src/duplicate.ts", body: "one" },
        { name: "src/duplicate.ts", body: "two" },
      ],
    },
  ])("rejects unsafe archive entries", async ({ entries }) => {
    await expect(
      validatePreviewWorkspaceArchive(await archive(entries)),
    ).rejects.toThrow("unsafe entry");
  });
});

describe("runOneShotPreviewWorkspaceHelper", () => {
  const request = {
    executionId: "exec-1",
    workspaceKey: "ws_script_exec-1",
    secretEnv: { GITHUB_TOKEN: "not-logged" },
  };

  it("cleans the expected generation when provisioning throws ambiguously", async () => {
    const destroy = vi.fn(async (name: string) => ({
      name,
      kind: "runtime" as const,
      status: "missing" as const,
    }));
    await expect(
      runOneShotPreviewWorkspaceHelper(request, async () => "unused", {
        provision: vi.fn(async () => {
          throw new Error("provision response was lost");
        }),
        wait: vi.fn(),
        destroy,
      }),
    ).rejects.toThrow("provision response was lost");
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith(
      expect.stringMatching(/^agent-host-agent-session-/),
    );
  });

  it("rejects a mismatched provision receipt and never cleans its claimed name", async () => {
    const destroy = vi.fn(async (name: string) => ({
      name,
      kind: "runtime" as const,
      status: "deleted" as const,
    }));
    const wait = vi.fn();
    await expect(
      runOneShotPreviewWorkspaceHelper(request, async () => "unused", {
        provision: vi.fn(async () => ({
          agentAppId: "agent-attacker",
          sandboxName: "agent-host-agent-attacker",
          status: "ready",
        })),
        wait,
        destroy,
      }),
    ).rejects.toThrow("mismatched identity");
    expect(wait).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalledWith("agent-host-agent-attacker");
  });
});
