import type { WorkflowDataService } from "$lib/server/application/ports";

export type WorkflowBrowserScreenshotClaim = Readonly<{
	storageRef: string;
	width: number;
	height: number;
}>;

export type VerifiedWorkflowBrowserScreenshot = WorkflowBrowserScreenshotClaim &
	Readonly<{
		artifactId: string;
		contentType: "image/png";
		sizeBytes: number;
	}>;

export type WorkflowBrowserEvidenceResult =
	| {
			status: "ok";
			body: {
				ok: true;
				executionId: string;
				evidence: VerifiedWorkflowBrowserScreenshot[];
			};
	  }
	| {
			status: "error";
			httpStatus: 400 | 404 | 413 | 422;
			message: string;
	  };

type ManifestAsset = { kind: string; storageRef: string };

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_EVIDENCE_ITEMS = 16;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_PNG_DIMENSION = 16_384;

function manifestAssets(value: unknown): ManifestAsset[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const assets = (value as Record<string, unknown>).assets;
	if (!Array.isArray(assets)) return [];
	return assets.flatMap((asset) => {
		if (!asset || typeof asset !== "object" || Array.isArray(asset)) return [];
		const row = asset as Record<string, unknown>;
		return typeof row.kind === "string" && typeof row.storageRef === "string"
			? [{ kind: row.kind, storageRef: row.storageRef }]
			: [];
	});
}

function safePathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function isOwnedStorageRef(
	executionId: string,
	artifactId: string,
	storageRef: string,
): boolean {
	return storageRef.startsWith(
		`workflow-browser-artifacts/${safePathSegment(executionId)}/${safePathSegment(artifactId)}/`,
	);
}

function pngDimensions(payload: Buffer): { width: number; height: number } | null {
	if (
		payload.length < 58 ||
		!payload.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
	) {
		return null;
	}
	let offset = PNG_SIGNATURE.length;
	let width = 0;
	let height = 0;
	let sawImageData = false;
	let sawEnd = false;
	while (offset + 12 <= payload.length) {
		const length = payload.readUInt32BE(offset);
		const type = payload.toString("ascii", offset + 4, offset + 8);
		const next = offset + 12 + length;
		if (next > payload.length) return null;
		if (offset === PNG_SIGNATURE.length) {
			if (type !== "IHDR" || length !== 13) return null;
			width = payload.readUInt32BE(offset + 8);
			height = payload.readUInt32BE(offset + 12);
		} else if (type === "IHDR") {
			return null;
		}
		if (type === "IDAT" && length > 0) sawImageData = true;
		if (type === "IEND") {
			if (length !== 0 || next !== payload.length) return null;
			sawEnd = true;
			break;
		}
		offset = next;
	}
	if (
		!sawImageData ||
		!sawEnd ||
		width < 1 ||
		height < 1 ||
		width > MAX_PNG_DIMENSION ||
		height > MAX_PNG_DIMENSION
	) {
		return null;
	}
	return { width, height };
}

/** Resolve model-authored refs into facts from the execution-owned artifact store. */
export class ApplicationWorkflowBrowserEvidenceService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				| "listWorkflowBrowserArtifactsByExecutionId"
				| "getWorkflowBrowserBlobPayload"
			>;
		},
	) {}

	async verify(input: {
		executionId: string;
		evidence: readonly WorkflowBrowserScreenshotClaim[];
	}): Promise<WorkflowBrowserEvidenceResult> {
		if (
			!input.executionId ||
			!Array.isArray(input.evidence) ||
			input.evidence.length < 1 ||
			input.evidence.length > MAX_EVIDENCE_ITEMS
		) {
			return {
				status: "error",
				httpStatus: 400,
				message: `evidence must contain 1-${MAX_EVIDENCE_ITEMS} screenshots`,
			};
		}
		const invalidClaim = input.evidence.some(
			(item) =>
				!item ||
				typeof item.storageRef !== "string" ||
				!Number.isSafeInteger(item.width) ||
				!Number.isSafeInteger(item.height) ||
				item.width < 1 ||
				item.height < 1 ||
				item.width > MAX_PNG_DIMENSION ||
				item.height > MAX_PNG_DIMENSION,
		);
		const refs = invalidClaim
			? []
			: input.evidence.map((item) => item.storageRef);
		if (new Set(refs).size !== refs.length || invalidClaim) {
			return {
				status: "error",
				httpStatus: 400,
				message: "screenshot evidence contains duplicate or invalid claims",
			};
		}

		const artifacts =
			await this.deps.workflowData.listWorkflowBrowserArtifactsByExecutionId(
				input.executionId,
			);
		const screenshots = new Map<string, { artifactId: string }>();
		for (const artifact of artifacts) {
			if (artifact.workflowExecutionId !== input.executionId) continue;
			for (const asset of manifestAssets(artifact.manifestJson)) {
				if (
					asset.kind === "screenshot" &&
					isOwnedStorageRef(input.executionId, artifact.id, asset.storageRef)
				) {
					screenshots.set(asset.storageRef, { artifactId: artifact.id });
				}
			}
		}

		const verified: VerifiedWorkflowBrowserScreenshot[] = [];
		for (const expected of input.evidence) {
			const screenshot = screenshots.get(expected.storageRef);
			if (!screenshot) {
				return {
					status: "error",
					httpStatus: 404,
					message: "Screenshot evidence was not found for this execution",
				};
			}
			const stored =
				await this.deps.workflowData.getWorkflowBrowserBlobPayload(
					expected.storageRef,
				);
			if (!stored) {
				return {
					status: "error",
					httpStatus: 404,
					message: "Screenshot evidence payload was not found",
				};
			}
			const payload = Buffer.from(stored.payloadBase64, "base64");
			if (payload.byteLength > MAX_SCREENSHOT_BYTES) {
				return {
					status: "error",
					httpStatus: 413,
					message: "Screenshot evidence exceeds the verification byte limit",
				};
			}
			const dimensions =
				stored.contentType === "image/png" ? pngDimensions(payload) : null;
			if (!dimensions) {
				return {
					status: "error",
					httpStatus: 422,
					message: "Screenshot evidence is not a valid PNG image",
				};
			}
			if (
				dimensions.width !== expected.width ||
				dimensions.height !== expected.height
			) {
				return {
					status: "error",
					httpStatus: 422,
					message: "Screenshot evidence dimensions do not match the claim",
				};
			}
			verified.push({
				...expected,
				artifactId: screenshot.artifactId,
				contentType: "image/png",
				sizeBytes: payload.byteLength,
			});
		}

		return {
			status: "ok",
			body: {
				ok: true,
				executionId: input.executionId,
				evidence: verified,
			},
		};
	}
}
