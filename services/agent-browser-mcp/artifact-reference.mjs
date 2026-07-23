export const WFB_ARTIFACT_REF_PREFIX = "WFB_ARTIFACT_REF=";

const VALIDATED_ARTIFACT_REFERENCE = Symbol("validated-artifact-reference");
const MAX_ARTIFACT_ID_LENGTH = 128;
const MAX_STORAGE_REF_LENGTH = 512;
const SAFE_ARTIFACT_ID = /^[a-zA-Z0-9._-]+$/;
const SAFE_ASSET_FILE = /^[a-z][a-z0-9-]{0,63}-[1-9][0-9]*\.[a-z0-9]{1,8}$/;

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safePathSegment(value) {
	return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/**
 * Accept only the execution-scoped reference produced by the browser-artifact
 * application boundary. Request data is never used to construct this result.
 */
export function persistedArtifactReferenceFromResponse(
	responseBody,
	{ executionId, expectedKind },
) {
	if (
		!isRecord(responseBody) ||
		responseBody.success !== true ||
		typeof executionId !== "string" ||
		executionId.length === 0 ||
		typeof expectedKind !== "string" ||
		expectedKind.length === 0
	) {
		return null;
	}
	const artifact = responseBody.artifact;
	if (
		!isRecord(artifact) ||
		artifact.workflowExecutionId !== executionId ||
		typeof artifact.id !== "string" ||
		artifact.id.length === 0 ||
		artifact.id.length > MAX_ARTIFACT_ID_LENGTH ||
		!SAFE_ARTIFACT_ID.test(artifact.id) ||
		!isRecord(artifact.manifestJson) ||
		!Array.isArray(artifact.manifestJson.assets)
	) {
		return null;
	}

	const scope =
		`workflow-browser-artifacts/${safePathSegment(executionId)}/` +
		`${artifact.id}/`;
	const matches = artifact.manifestJson.assets.filter((asset) => {
		if (
			!isRecord(asset) ||
			asset.kind !== expectedKind ||
			typeof asset.storageRef !== "string" ||
			asset.storageRef.length <= scope.length ||
			asset.storageRef.length > MAX_STORAGE_REF_LENGTH ||
			!asset.storageRef.startsWith(scope)
		) {
			return false;
		}
		return SAFE_ASSET_FILE.test(asset.storageRef.slice(scope.length));
	});
	if (matches.length !== 1) return null;

	return Object.freeze({
		artifactId: artifact.id,
		storageRef: matches[0].storageRef,
		[VALIDATED_ARTIFACT_REFERENCE]: true,
	});
}

/** Append a stable machine contract without rewriting any child content block. */
export function appendPersistedArtifactReference(result, reference) {
	if (
		!isRecord(result) ||
		!Array.isArray(result.content) ||
		!isRecord(reference) ||
		reference[VALIDATED_ARTIFACT_REFERENCE] !== true
	) {
		return result;
	}
	return {
		...result,
		content: [
			...result.content,
			{
				type: "text",
				text: `${WFB_ARTIFACT_REF_PREFIX}${reference.storageRef}`,
			},
		],
	};
}
