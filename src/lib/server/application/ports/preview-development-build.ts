import type { ImmutableGitSha } from "./preview-environments";

export const PREVIEW_DEVELOPMENT_SOURCE_REPOSITORY =
	"PittampalliOrg/workflow-builder";

export type PreviewDevelopmentImage = Readonly<{
	service: string;
	sourceRevision: ImmutableGitSha;
	buildId: string;
	imageRef: string;
	digest: `sha256:${string}`;
	immutableRef: string;
}>;

/** One canonical development image build. Each invocation owns one PipelineRun. */
export interface PreviewEnvironmentDevelopmentImageBuildPort {
	build(input: Readonly<{
		requestId: string;
		sourceRepository: string;
		sourceRevision: ImmutableGitSha;
		catalogDigest: `sha256:${string}`;
		service: string;
	}>): Promise<PreviewDevelopmentImage>;
}
