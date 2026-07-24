import { afterEach, describe, expect, it, vi } from "vitest";
import { JuiceFsWorkflowWorkspaceSnapshotAdapter } from "$lib/server/application/adapters/workflow-workspace-snapshot";

const DATABASE_URL = "postgres://workflow-builder:test@example.local:5432/app";

function multistatus(hrefs: Array<{ href: string; dir: boolean }>): string {
	return [
		'<D:multistatus xmlns:D="DAV:">',
		...hrefs.map(({ href, dir }) =>
			[
				"<D:response>",
				`<D:href>${href}</D:href>`,
				dir
					? "<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>"
					: "<D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat>",
				"</D:response>",
			].join(""),
		),
		"</D:multistatus>",
	].join("");
}

describe("JuiceFsWorkflowWorkspaceSnapshotAdapter", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("lists snapshot ids from .snapshots/<key>/ (Depth:1)", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				multistatus([
					{ href: "/.snapshots/instance-1/", dir: true }, // self, excluded
					{ href: "/.snapshots/instance-1/planning/", dir: true },
					{ href: "/.snapshots/instance-1/build_ui/", dir: true },
				]),
				{ status: 207 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const adapter = new JuiceFsWorkflowWorkspaceSnapshotAdapter({
			JUICEFS_WEBDAV_URL: "http://webdav.local/",
			JUICEFS_WEBDAV_USER: "webdav-user",
			JUICEFS_WEBDAV_PASSWORD: "secret",
			DATABASE_URL,
		});

		await expect(adapter.listSnapshots("instance-1")).resolves.toEqual([
			"planning",
			"build_ui",
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			"http://webdav.local/.snapshots/instance-1/",
			expect.objectContaining({ method: "PROPFIND" }),
		);
	});

	it("returns [] when the key has no snapshots (404)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 404 })),
		);
		const adapter = new JuiceFsWorkflowWorkspaceSnapshotAdapter({
			JUICEFS_WEBDAV_URL: "http://webdav.local/",
			JUICEFS_WEBDAV_PASSWORD: "secret",
		});
		await expect(adapter.listSnapshots("instance-1")).resolves.toEqual([]);
	});

	it("never throws — a gateway error becomes an empty list (fork falls back)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("gateway down");
			}),
		);
		const adapter = new JuiceFsWorkflowWorkspaceSnapshotAdapter({
			JUICEFS_WEBDAV_URL: "http://webdav.local/",
			JUICEFS_WEBDAV_PASSWORD: "secret",
		});
		await expect(adapter.listSnapshots("instance-1")).resolves.toEqual([]);
	});

	it("returns [] for a blank key without calling the gateway", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const adapter = new JuiceFsWorkflowWorkspaceSnapshotAdapter({
			JUICEFS_WEBDAV_URL: "http://webdav.local/",
			JUICEFS_WEBDAV_PASSWORD: "secret",
		});
		await expect(adapter.listSnapshots("  ")).resolves.toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
