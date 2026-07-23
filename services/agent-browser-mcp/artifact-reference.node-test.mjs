import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	appendPersistedArtifactReference,
	persistedArtifactReferenceFromResponse,
} from "./artifact-reference.mjs";

const EXECUTION_ID = "execution-vision-1";
const ARTIFACT_ID = "bwf_server123";
const STORAGE_REF =
	"workflow-browser-artifacts/execution-vision-1/bwf_server123/screenshot-1.png";

function persistedResponse(overrides = {}) {
	return {
		success: true,
		artifact: {
			id: ARTIFACT_ID,
			workflowExecutionId: EXECUTION_ID,
			manifestJson: {
				assets: [
					{
						kind: "screenshot",
						storageRef: STORAGE_REF,
						contentType: "image/png",
					},
				],
			},
			...overrides,
		},
	};
}

describe("browser artifact reference contract", () => {
	it("preserves every original content block and appends the exact persisted ref", () => {
		const pixels = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
		const textBlock = { type: "text", text: "Screenshot captured" };
		const imageBlock = {
			type: "image",
			data: pixels,
			mimeType: "image/png",
		};
		const result = {
			content: [textBlock, imageBlock],
			structuredContent: { path: "screenshot.png" },
		};
		const reference = persistedArtifactReferenceFromResponse(
			persistedResponse(),
			{ executionId: EXECUTION_ID, expectedKind: "screenshot" },
		);

		const annotated = appendPersistedArtifactReference(result, reference);

		assert.notStrictEqual(annotated, result);
		assert.equal(annotated.content.length, 3);
		assert.strictEqual(annotated.content[0], textBlock);
		assert.strictEqual(annotated.content[1], imageBlock);
		assert.equal(annotated.content[1].data, pixels);
		assert.strictEqual(annotated.structuredContent, result.structuredContent);
		assert.deepEqual(annotated.content[2], {
			type: "text",
			text: `WFB_ARTIFACT_REF=${STORAGE_REF}`,
		});
		assert.deepEqual(result.content, [textBlock, imageBlock]);
	});

	it("accepts only one server-returned reference in the exact execution scope", () => {
		const valid = persistedArtifactReferenceFromResponse(
			persistedResponse(),
			{ executionId: EXECUTION_ID, expectedKind: "screenshot" },
		);
		assert.deepEqual(
			{ artifactId: valid.artifactId, storageRef: valid.storageRef },
			{ artifactId: ARTIFACT_ID, storageRef: STORAGE_REF },
		);

		assert.equal(
			persistedArtifactReferenceFromResponse(
				persistedResponse({ workflowExecutionId: "another-execution" }),
				{ executionId: EXECUTION_ID, expectedKind: "screenshot" },
			),
			null,
		);
		assert.equal(
			persistedArtifactReferenceFromResponse(
				persistedResponse({
					manifestJson: {
						assets: [
							{
								kind: "screenshot",
								storageRef:
									"workflow-browser-artifacts/execution-vision-1/other-artifact/screenshot-1.png",
							},
						],
					},
				}),
				{ executionId: EXECUTION_ID, expectedKind: "screenshot" },
			),
			null,
		);
		assert.equal(
			persistedArtifactReferenceFromResponse(
				persistedResponse({
					manifestJson: {
						assets: [
							{
								kind: "screenshot",
								storageRef: `${STORAGE_REF}\nTOKEN=not-allowed`,
							},
						],
					},
				}),
				{ executionId: EXECUTION_ID, expectedKind: "screenshot" },
			),
			null,
		);
	});

	it("will not annotate from a caller-constructed reference", () => {
		const result = {
			content: [{ type: "image", data: "pixels", mimeType: "image/png" }],
		};
		assert.strictEqual(
			appendPersistedArtifactReference(result, { storageRef: STORAGE_REF }),
			result,
		);
	});
});
