import { createHash } from "node:crypto";
import type {
	PreviewArtifactIngressPort,
	PreviewArtifactCaptureCatalogPort,
	PreviewArtifactTransferEnvelope,
	PreviewControlArtifactStorePort,
	PreviewControlSourceAuthorityPort,
} from "$lib/server/application/ports";
import { parseStrictPreviewCapture } from "$lib/server/application/preview-acceptance-trust";
import {
	PreviewArtifactBundleError,
	validatePreviewArtifactBundle,
} from "$lib/server/application/preview-artifact-bundle";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export class PreviewArtifactIngressError extends Error {
	constructor(message: string, public readonly statusCode: 400 | 409 = 400) {
		super(message);
		this.name = "PreviewArtifactIngressError";
	}
}

/** Physical ingestion of immutable strict captures from an isolated preview DB. */
export class ApplicationPreviewArtifactIngressService
	implements PreviewArtifactIngressPort
{
	constructor(
		private readonly deps: Readonly<{
				authority: PreviewControlSourceAuthorityPort;
				catalog: PreviewArtifactCaptureCatalogPort;
				store: PreviewControlArtifactStorePort;
		}>,
	) {}

	async ingest(envelope: PreviewArtifactTransferEnvelope, bytes: Buffer) {
		if (
			!SAFE_ID.test(envelope.executionId) ||
			!SAFE_ID.test(envelope.artifactId) ||
			envelope.artifact.id !== envelope.artifactId ||
			envelope.artifact.executionId !== envelope.executionId ||
			!envelope.artifact.fileId
		) {
			throw new PreviewArtifactIngressError("artifact transfer identity is invalid");
		}
		const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
		if (digest !== envelope.fileDigest) {
			throw new PreviewArtifactIngressError("artifact bytes do not match fileDigest", 409);
		}
		const capture = parseStrictPreviewCapture(envelope.artifact);
		if (!capture) {
			throw new PreviewArtifactIngressError("artifact is not a strict atomic capture", 409);
		}
		if (
			capture.platformRevision !== envelope.identity.environmentPlatformRevision ||
			capture.capturedSourceRevision !== envelope.identity.environmentSourceRevision ||
			capture.catalogDigest !== envelope.identity.catalogDigest
		) {
			throw new PreviewArtifactIngressError(
				"artifact provenance does not match the preview capability",
				409,
			);
		}
		let validatedBundle;
		try {
			validatedBundle = await validatePreviewArtifactBundle({
				bytes,
				artifact: envelope.artifact,
				capture,
				catalog: this.deps.catalog,
			});
		} catch (cause) {
			throw new PreviewArtifactIngressError(
				cause instanceof PreviewArtifactBundleError
					? cause.message
					: "artifact bundle validation failed",
				409,
			);
		}
		const authorized = await this.deps.authority.authorize({
			previewName: envelope.identity.previewName,
			environmentRequestId: envelope.identity.environmentRequestId,
			environmentPlatformRevision: envelope.identity.environmentPlatformRevision,
			environmentSourceRevision: envelope.identity.environmentSourceRevision,
			catalogDigest: envelope.identity.catalogDigest,
			requiredServices: validatedBundle.services,
		});
		return this.deps.store.put({
			envelope,
			bytes,
			ownerId: authorized.owner,
			captureId: validatedBundle.captureId,
			generation: validatedBundle.generation,
			services: validatedBundle.services,
		});
	}
}
