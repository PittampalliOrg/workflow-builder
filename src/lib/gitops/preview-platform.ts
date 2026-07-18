/**
 * View model for the GitOps "Preview platform" panel: the dev-preview-platform
 * broker (stacks main `Deployment-preview-control-broker.yaml`) vs the
 * release-pins `digests.workflow-builder` digest, plus the live rendered
 * preview pins ConfigMap revision. Pure and unit-tested.
 */
import type { FleetDriftExtras } from "$lib/types/deployment-metadata";
import { shortDigest } from "$lib/utils/gitops-display";

export type PreviewPlatformState = "skew" | "in-sync" | "unknown";

export type PreviewPlatformView = {
	state: PreviewPlatformState;
	headline: string;
	detail: string;
	brokerDigest: string | null;
	brokerDigestShort: string;
	releasePinsDigest: string | null;
	releasePinsDigestShort: string;
	/** Live rendered preview pins ConfigMap revision (`pins-hash`). */
	pinRevision: string | null;
	stacksMainShortSha: string | null;
	stacksMainUrl: string | null;
	/** Concrete operator remedy, only set when skewed. */
	remedy: string | null;
};

export const PREVIEW_PLATFORM_SKEW_REMEDY =
	"Remedy: bump the broker image pointer in stacks main " +
	"(packages/components/workloads/dev-preview-platform/Deployment-preview-control-broker.yaml) " +
	"to the current release-pins workflow-builder digest, then let the hub promote env/hub.";

export function buildPreviewPlatformView(
	extras: FleetDriftExtras | null,
): PreviewPlatformView {
	const platform = extras?.previewPlatform ?? null;
	const brokerDigest = platform?.brokerImageDigest ?? null;
	const releasePinsDigest = platform?.releasePinsWorkflowBuilderDigest ?? null;
	const state: PreviewPlatformState = platform?.skew
		? "skew"
		: brokerDigest && releasePinsDigest
			? "in-sync"
			: "unknown";
	return {
		state,
		headline:
			state === "skew"
				? "Preview-control broker is skewed from release-pins"
				: state === "in-sync"
					? "Preview platform matches release-pins"
					: "Preview platform state unknown",
		detail:
			state === "skew"
				? "The broker runs an older workflow-builder build than the current release pin; " +
					"promotion sandbox cleanup may be degraded until the pointer is bumped."
				: state === "in-sync"
					? "The dev-preview broker image digest matches the release-pins workflow-builder digest."
					: "Broker or release-pins digest could not be read; skew cannot be evaluated.",
		brokerDigest,
		brokerDigestShort: shortDigest(brokerDigest),
		releasePinsDigest,
		releasePinsDigestShort: shortDigest(releasePinsDigest),
		pinRevision: platform?.pinRevision ?? null,
		stacksMainShortSha: extras?.stacksMainHead?.shortSha ?? null,
		stacksMainUrl: extras?.stacksMainHead?.url ?? null,
		remedy: state === "skew" ? PREVIEW_PLATFORM_SKEW_REMEDY : null,
	};
}
