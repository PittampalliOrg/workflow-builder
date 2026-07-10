export type CaptureDevPreviewSourcesInput = {
	executionId: string;
	nodeId?: string | null;
	iteration?: number | null;
	expectedServices?: readonly string[] | null;
	requireImmutableProvenance?: boolean;
	platformRevision?: string | null;
	sourceRevision?: string | null;
	catalogDigest?: string | null;
};

export type CaptureDevPreviewServiceResult = {
	service: string | null;
	ok: boolean;
	skipped?: string;
};

export type CaptureDevPreviewSourcesResult = {
	ok: boolean;
	artifactId?: string;
	bytes?: number;
	skipped?: string;
	captureId?: string;
	generation?: string | null;
	services: CaptureDevPreviewServiceResult[];
};

/** Outbound port for exporting and persisting one atomic preview source set. */
export interface DevPreviewSourceCapturePort {
	captureAll(
		input: CaptureDevPreviewSourcesInput,
	): Promise<CaptureDevPreviewSourcesResult>;
}

export type CapturePreviewAcceptanceCandidateInput = Omit<
	CaptureDevPreviewSourcesInput,
	"expectedServices" | "requireImmutableProvenance"
> & {
	expectedServices: readonly string[];
};

/** Inbound capture boundary consumed by higher-level preview use cases. */
export interface DevPreviewAcceptanceCapturePort {
	captureAcceptanceCandidate(
		input: CapturePreviewAcceptanceCandidateInput,
	): Promise<CaptureDevPreviewSourcesResult>;
}
