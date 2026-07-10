import type {
	CapturePreviewAcceptanceCandidateInput,
	CaptureDevPreviewSourcesResult,
	DevPreviewAcceptanceCapturePort,
	DevPreviewSourceCapturePort,
} from "$lib/server/application/ports/dev-preview-source-capture";

export type DevPreviewSourceCaptureServiceDeps = {
	capture: DevPreviewSourceCapturePort;
};

/** Application use case for creating an atomic, promotable preview source bundle. */
export class ApplicationDevPreviewSourceCaptureService
	implements DevPreviewAcceptanceCapturePort
{
	constructor(private readonly deps: DevPreviewSourceCaptureServiceDeps) {}

	captureAcceptanceCandidate(
		input: CapturePreviewAcceptanceCandidateInput,
	): Promise<CaptureDevPreviewSourcesResult> {
		return this.deps.capture.captureAll({
			...input,
			requireImmutableProvenance: true,
		});
	}
}
