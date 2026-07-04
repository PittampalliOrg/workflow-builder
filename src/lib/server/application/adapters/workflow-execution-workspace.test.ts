import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JuiceFsWorkflowExecutionWorkspaceAdapter,
  resolveJuiceFsWebdavPassword,
} from "$lib/server/application/adapters/workflow-execution-workspace";

describe("JuiceFsWorkflowExecutionWorkspaceAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("derives the legacy WebDAV password from databaseUrl inside the adapter", () => {
    const databaseUrl =
      "postgres://workflow-builder:test@example.local:5432/app";

    expect(resolveJuiceFsWebdavPassword({ databaseUrl, password: null })).toBe(
      createHash("sha256")
        .update(`webdav:wfbcli:${databaseUrl}`)
        .digest("hex")
        .slice(0, 32),
    );
    expect(
      resolveJuiceFsWebdavPassword({ databaseUrl, password: "explicit" }),
    ).toBe("explicit");
  });

  it("injects WebDAV Authorization from adapter configuration", async () => {
    const databaseUrl =
      "postgres://workflow-builder:test@example.local:5432/app";
    const expectedPassword = resolveJuiceFsWebdavPassword({
      databaseUrl,
      password: null,
    });
    const fetchMock = vi.fn(async () => {
      return new Response(
        [
          '<D:multistatus xmlns:D="DAV:">',
          "<D:response>",
          "<D:href>/instance-1/src/</D:href>",
          "<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>",
          "</D:response>",
          "</D:multistatus>",
        ].join(""),
        { status: 207 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new JuiceFsWorkflowExecutionWorkspaceAdapter({
      baseUrl: "http://webdav.local/",
      username: "webdav-user",
      databaseUrl,
    });

    await expect(adapter.listTree("instance-1")).resolves.toEqual({
      entries: [{ path: "src", isDir: true, sizeBytes: 0 }],
      truncated: false,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://webdav.local/instance-1/",
      expect.objectContaining({
        method: "PROPFIND",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from(
            `webdav-user:${expectedPassword}`,
          ).toString("base64")}`,
        }),
      }),
    );
  });
});
