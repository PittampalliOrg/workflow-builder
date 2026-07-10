import { PREVIEW_ACCEPTANCE_ATTESTATION_METADATA_KEY } from "$lib/server/application/ports/preview-acceptance-trust";

const RESERVED_GENERIC_ARTIFACT_KINDS = new Set([
	"source-bundle",
	"preview-acceptance-attestation",
]);

const RESERVED_ACCEPTANCE_FIELDS = new Set([
	"acceptanceEligible",
	"captureProtocol",
	"overlayDigests",
	"promotedCommitSha",
	"acceptanceAttestation",
	PREVIEW_ACCEPTANCE_ATTESTATION_METADATA_KEY,
]);

function reservedField(value: unknown, path: string): string | null {
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) {
			const found = reservedField(entry, `${path}[${index}]`);
			if (found) return found;
		}
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		const fieldPath = `${path}.${key}`;
		if (RESERVED_ACCEPTANCE_FIELDS.has(key)) return fieldPath;
		const found = reservedField(entry, fieldPath);
		if (found) return found;
	}
	return null;
}

/**
 * Generic workflow artifact ingress is intentionally unable to mint the
 * server-owned capture and acceptance records used by privileged replay.
 */
export function genericWorkflowArtifactReservation(input: {
	kind: string;
	inlinePayload: unknown;
	metadata: unknown;
}): string | null {
	if (RESERVED_GENERIC_ARTIFACT_KINDS.has(input.kind)) {
		return `kind:${input.kind}`;
	}
	return (
		reservedField(input.inlinePayload, "inlinePayload") ??
		reservedField(input.metadata, "metadata")
	);
}
