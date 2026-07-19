import type {
	WorkflowBrowserArtifactRecord,
	WorkflowDataService,
} from "$lib/server/application/ports";

export type WorkflowBrowserArtifactsInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
};

export type WorkflowBrowserArtifactsResult =
	| {
			status: "ok";
			body: { artifacts: WorkflowBrowserArtifactRecord[] };
	  }
	| { status: "error"; httpStatus: number; message: string };

export type WorkflowBrowserScreenshotInput = WorkflowBrowserArtifactsInput & {
	storageRef: string;
	maxBytes: number;
};

export type WorkflowBrowserScreenshotResult =
	| {
			status: "ok";
			body: {
				storageRef: string;
				contentType: string;
				payloadBase64: string;
				sizeBytes: number;
			};
	  }
	| { status: "error"; httpStatus: number; message: string };

export type WorkflowBrowserAssetResult = WorkflowBrowserScreenshotResult;

type ManifestAsset = { kind: string; storageRef: string };

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

export class ApplicationWorkflowBrowserArtifactsService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				| "getScopedExecutionById"
				| "listWorkflowBrowserArtifactsByExecutionId"
				| "getWorkflowBrowserBlobPayload"
			>;
		},
	) {}

	async listArtifacts(
		input: WorkflowBrowserArtifactsInput,
	): Promise<WorkflowBrowserArtifactsResult> {
		const execution = await this.deps.workflowData.getScopedExecutionById({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		if (!execution) {
			return {
				status: "error",
				httpStatus: 404,
				message: "Execution not found",
			};
		}

		return {
			status: "ok",
			body: {
				artifacts:
					await this.deps.workflowData.listWorkflowBrowserArtifactsByExecutionId(
						input.executionId,
					),
			},
		};
	}

	async getScreenshot(
		input: WorkflowBrowserScreenshotInput,
	): Promise<WorkflowBrowserScreenshotResult> {
		const result = await this.getAssetByKind(input, "screenshot");
		if (
			result.status === "ok" &&
			!result.body.contentType.toLowerCase().startsWith("image/")
		) {
			return { status: "error", httpStatus: 404, message: "Screenshot not found" };
		}
		return result;
	}

	async getAsset(
		input: WorkflowBrowserScreenshotInput,
	): Promise<WorkflowBrowserAssetResult> {
		return this.getAssetByKind(input);
	}

	private async getAssetByKind(
		input: WorkflowBrowserScreenshotInput,
		requiredKind?: string,
	): Promise<WorkflowBrowserAssetResult> {
		const execution = await this.deps.workflowData.getScopedExecutionById({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		if (!execution) {
			return { status: "error", httpStatus: 404, message: "Execution not found" };
		}
		const artifacts =
			await this.deps.workflowData.listWorkflowBrowserArtifactsByExecutionId(
				input.executionId,
			);
		let allowed = false;
		for (const artifact of artifacts) {
			if (artifact.workflowExecutionId !== input.executionId) continue;
			for (const asset of manifestAssets(artifact.manifestJson)) {
				if (
					asset.storageRef === input.storageRef &&
					(!requiredKind || asset.kind === requiredKind) &&
					isOwnedStorageRef(input.executionId, artifact.id, asset.storageRef)
				) {
					allowed = true;
					break;
				}
			}
			if (allowed) break;
		}
		if (!allowed) {
			return {
				status: "error",
				httpStatus: 404,
				message: requiredKind ? "Screenshot not found" : "Browser artifact not found",
			};
		}
		const payload = await this.deps.workflowData.getWorkflowBrowserBlobPayload(
			input.storageRef,
		);
		if (!payload) {
			return { status: "error", httpStatus: 404, message: "Browser artifact not found" };
		}
		const sizeBytes = Buffer.byteLength(payload.payloadBase64, "base64");
		if (sizeBytes > input.maxBytes) {
			return {
				status: "error",
				httpStatus: 413,
				message: `Browser artifact exceeds the ${input.maxBytes}-byte response limit`,
			};
		}
		return {
			status: "ok",
			body: {
				storageRef: input.storageRef,
				contentType: payload.contentType,
				payloadBase64: payload.payloadBase64,
				sizeBytes,
			},
		};
	}
}
