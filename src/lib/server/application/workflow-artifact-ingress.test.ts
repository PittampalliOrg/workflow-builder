import { describe, expect, it } from "vitest";
import { genericWorkflowArtifactReservation } from "$lib/server/application/workflow-artifact-ingress";

describe("generic workflow artifact ingress policy", () => {
	it("reserves source bundles for the server capture path", () => {
		expect(
			genericWorkflowArtifactReservation({
				kind: "source-bundle",
				inlinePayload: {},
				metadata: null,
			}),
		).toBe("kind:source-bundle");
	});

	it("rejects nested acceptance and attestation fields on other artifact kinds", () => {
		expect(
			genericWorkflowArtifactReservation({
				kind: "result",
				inlinePayload: { nested: [{ acceptanceEligible: true }] },
				metadata: null,
			}),
		).toBe("inlinePayload.nested[0].acceptanceEligible");
		expect(
			genericWorkflowArtifactReservation({
				kind: "result",
				inlinePayload: {},
				metadata: { previewAcceptanceAttestationV1: "forged" },
			}),
		).toBe("metadata.previewAcceptanceAttestationV1");
	});

	it("allows ordinary artifact payloads", () => {
		expect(
			genericWorkflowArtifactReservation({
				kind: "result",
				inlinePayload: {
					score: 1,
					services: ["workflow-builder"],
					generation: "42",
					sourceRevision: "abc123",
					platformRevision: "def456",
					catalogDigest: "piece-catalog-v2",
				},
				metadata: {
					producer: "workflow-orchestrator",
					promotion: { stage: "dev" },
				},
			}),
		).toBeNull();
	});
});
