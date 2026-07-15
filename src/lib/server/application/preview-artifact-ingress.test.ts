import { createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { describe, expect, it, vi } from "vitest";
import { DevPreviewServiceCatalogAdapter } from "$lib/server/application/adapters/dev-preview-service-catalog";
import {
	ApplicationPreviewArtifactIngressService,
	PreviewArtifactIngressError,
} from "$lib/server/application/preview-artifact-ingress";
import type {
	PreviewArtifactTransferEnvelope,
	PreviewControlArtifactStorePort,
	PreviewControlSourceAuthorityPort,
} from "$lib/server/application/ports";

const PLATFORM_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const catalog = new DevPreviewServiceCatalogAdapter();
const CATALOG_DIGEST = catalog.currentDigest();

function sha256(bytes: Buffer): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function tarGzip(entries: Record<string, string | Buffer>): Promise<Buffer> {
	const archive = pack();
	const chunks: Buffer[] = [];
	const completed = new Promise<Buffer>((resolve, reject) => {
		archive.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		archive.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
		archive.on("error", reject);
	});
	for (const [name, content] of Object.entries(entries)) {
		archive.entry({ name, type: "file" }, content);
	}
	archive.finalize();
	return completed;
}

async function strictEnvelope(
	entries: Record<string, string | Buffer>,
	executionId = "execution-1",
): Promise<{ envelope: PreviewArtifactTransferEnvelope; bytes: Buffer }> {
	const contract = catalog.captureContract("workflow-builder");
	if (!contract) throw new Error("workflow-builder capture contract missing");
	const overlay = await tarGzip(entries);
	const overlayDigest = sha256(overlay);
	const captureId = "capture-1";
	const generation = "generation-1";
	const manifest = {
		version: 2,
		tier: "tar-overlay-set",
		captureProtocol: "atomic-generation-v2",
		acceptanceEligible: true,
		captureId,
		capturedAt: "2026-07-09T20:00:00.000Z",
		generation,
		catalogDigest: CATALOG_DIGEST,
		sourceRevision: SOURCE_SHA,
		platformRevision: PLATFORM_SHA,
		repoUrl: contract.repository,
		base: contract.base,
		services: [
			{
				service: contract.service,
				repoSubdir: contract.repoSubdir,
				syncPaths: contract.syncPaths,
				captureMappings: contract.captureMappings,
				contentSha256: overlayDigest,
				tarGzipBase64: overlay.toString("base64"),
			},
		],
	};
	const bytes = gzipSync(Buffer.from(JSON.stringify(manifest), "utf8"));
	const artifact = {
		id: "artifact-1",
		executionId,
		kind: "source-bundle",
		fileId: "preview-file-1",
		inlinePayload: {
			base: contract.base,
			repoUrl: contract.repository,
			manifestVersion: 2,
			captureId,
			capturedAt: manifest.capturedAt,
			serviceCount: 1,
			services: [contract.service],
			captureProtocol: manifest.captureProtocol,
			acceptanceEligible: true,
			generation,
			overlayDigests: { [contract.service]: overlayDigest },
			catalogDigest: CATALOG_DIGEST,
			sourceRevision: SOURCE_SHA,
			platformRevision: PLATFORM_SHA,
		},
		metadata: null,
	} as const;
	return {
		bytes,
		envelope: {
			identity: {
				previewName: "preview-one",
				environmentRequestId: "launch-1",
				environmentPlatformRevision: PLATFORM_SHA,
				environmentSourceRevision: SOURCE_SHA,
				catalogDigest: CATALOG_DIGEST,
			},
			executionId: artifact.executionId,
			artifactId: artifact.id,
			fileDigest: sha256(bytes),
			artifact,
		},
	};
}

function rewriteOverlayEncoding(
	input: { envelope: PreviewArtifactTransferEnvelope; bytes: Buffer },
	rewrite: (encoded: string) => string,
): { envelope: PreviewArtifactTransferEnvelope; bytes: Buffer } {
	const manifest = JSON.parse(gunzipSync(input.bytes).toString("utf8")) as {
		services: Array<{ tarGzipBase64: string }>;
	};
	manifest.services[0].tarGzipBase64 = rewrite(manifest.services[0].tarGzipBase64);
	const bytes = gzipSync(Buffer.from(JSON.stringify(manifest), "utf8"));
	return {
		bytes,
		envelope: { ...input.envelope, fileDigest: sha256(bytes) },
	};
}

function harness() {
	const authority: PreviewControlSourceAuthorityPort = {
		authorize: vi.fn(async (input) => ({
			previewName: input.previewName,
			requestId: input.environmentRequestId,
			owner: "admin-1",
			platformRevision: PLATFORM_SHA as never,
			sourceRevision: SOURCE_SHA as never,
			catalogDigest: CATALOG_DIGEST,
			services: input.requiredServices,
		})),
		authorizeRuntime: vi.fn(),
		authorizeRuntimeTuple: vi.fn(),
		authorizeCurrent: vi.fn(),
	};
	const store: PreviewControlArtifactStorePort = {
		put: vi.fn(async (input) => ({
			id: "central-artifact-1",
			fileId: "central-file-1",
			fileDigest: input.envelope.fileDigest,
			artifact: input.envelope.artifact,
			importIdentity: {
				previewName: input.envelope.identity.previewName,
				requestId: input.envelope.identity.environmentRequestId,
				executionId: input.envelope.executionId,
				sourceArtifactId: input.envelope.artifactId,
				platformRevision: input.envelope.identity.environmentPlatformRevision,
				sourceRevision: input.envelope.identity.environmentSourceRevision,
				catalogDigest: input.envelope.identity.catalogDigest,
				services: input.services,
				captureId: input.captureId,
				generation: input.generation,
				fileDigest: input.envelope.fileDigest,
			},
		})),
		get: vi.fn(),
		fileDigest: vi.fn(),
	};
	return {
		authority,
		store,
		service: new ApplicationPreviewArtifactIngressService({
			authority,
			catalog,
			store,
		}),
	};
}

describe("ApplicationPreviewArtifactIngressService", () => {
	it("cross-binds strict bytes and catalog paths before physical persistence", async () => {
		const h = harness();
		const input = await strictEnvelope({ "src/index.ts": "export const ok = true;" });

		await expect(h.service.ingest(input.envelope, input.bytes)).resolves.toMatchObject({
			id: "central-artifact-1",
			importIdentity: { services: ["workflow-builder"] },
		});
		expect(h.store.put).toHaveBeenCalledOnce();
	});

	it("ingests a strict capture for a URL-safe Nanoid workflow execution", async () => {
		const h = harness();
		const executionId = "_O-r4CT3dAp9CRUi7ImCA";
		const input = await strictEnvelope(
			{ "src/index.ts": "export const ok = true;" },
			executionId,
		);

		await expect(h.service.ingest(input.envelope, input.bytes)).resolves.toMatchObject({
			importIdentity: { executionId },
		});
		expect(h.store.put).toHaveBeenCalledOnce();
	});

	it("accepts a multi-megabyte canonical base64 overlay without recursive regex validation", async () => {
		const h = harness();
		const input = await strictEnvelope({
			"src/large-overlay.bin": randomBytes(4 * 1024 * 1024),
		});
		const manifest = JSON.parse(gunzipSync(input.bytes).toString("utf8")) as {
			services: Array<{ tarGzipBase64: string }>;
		};
		expect(manifest.services[0].tarGzipBase64.length).toBeGreaterThan(5 * 1024 * 1024);

		await expect(h.service.ingest(input.envelope, input.bytes)).resolves.toMatchObject({
			id: "central-artifact-1",
		});
		expect(h.store.put).toHaveBeenCalledOnce();
	});

	it.each([
		["invalid character", (encoded: string) => `!${encoded.slice(1)}`],
		["invalid padding", (encoded: string) => `${encoded.slice(0, -4)}A===`],
		["invalid length", (encoded: string) => encoded.slice(0, -1)],
	])("rejects %s in standard base64 overlays", async (_scenario, rewrite) => {
		const h = harness();
		const valid = await strictEnvelope({ "src/index.ts": "export const ok = true;" });
		const input = rewriteOverlayEncoding(valid, rewrite);

		await expect(h.service.ingest(input.envelope, input.bytes)).rejects.toMatchObject({
			name: PreviewArtifactIngressError.name,
			statusCode: 409,
			message: "overlay tarGzipBase64 is invalid",
		});
		expect(h.authority.authorize).not.toHaveBeenCalled();
		expect(h.store.put).not.toHaveBeenCalled();
	});

	it("rejects an otherwise valid bundle containing a non-catalog GitHub workflow", async () => {
		const h = harness();
		const input = await strictEnvelope({
			"src/index.ts": "export const ok = true;",
			".github/workflows/pwn.yml": "name: pwn",
		});

		await expect(h.service.ingest(input.envelope, input.bytes)).rejects.toMatchObject({
			name: PreviewArtifactIngressError.name,
			statusCode: 409,
			message: expect.stringContaining("outside catalog capture roots"),
		});
		expect(h.authority.authorize).not.toHaveBeenCalled();
		expect(h.store.put).not.toHaveBeenCalled();
	});
});
