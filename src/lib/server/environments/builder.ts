import type { EnvironmentDetail } from "$lib/types/environments";
import {
	generateDockerfile,
	hasAnyPackages,
	type BaseImageResolver,
} from "./dockerfile-gen";

/**
 * Helper for the Dockerfile-preview endpoint — used by the admin UI to
 * show users what the generated file will look like before hitting Build.
 */
export async function previewEnvironmentDockerfile(
	env: EnvironmentDetail,
	baseImageResolver?: BaseImageResolver,
): Promise<string> {
	if (!hasAnyPackages(env.config.packages ?? {})) {
		return `# Environment "${env.slug}" has no declared packages — image reuses the base directly.`;
	}
	const baseEnvSlug = env.baseEnvSlug ?? null;
	return generateDockerfile(
		{
			slug: env.slug,
			name: env.name,
			baseEnvSlug,
			packages: env.config.packages ?? {},
		},
		{ baseImageResolver },
	);
}
