import type { EnvironmentDetail } from "$lib/types/environments";
import {
	dockerfilePathForSlug,
	expectedImageTagForSlug,
	generateDockerfile,
	hasAnyPackages,
	type BaseImageResolver,
	type DockerfileInputs,
} from "./dockerfile-gen";
import { upsertDockerfile } from "./gitea-commit";
import {
	getEnvironment,
	markEnvironmentBuildFailed,
	markEnvironmentBuildStarted,
	markEnvironmentBuildSucceeded,
} from "./registry";

/**
 * Kick off a rebuild for the given environment. Returns as soon as the Gitea
 * commit lands — Tekton picks up the push async and finishes the image
 * build in-cluster. Admin UI polls the env detail endpoint afterwards to
 * watch lastBuildStatus transition building → built.
 *
 * We DO NOT wait for the Tekton pipeline here (would hold the HTTP
 * connection for minutes). The pipeline itself is expected to POST back
 * with the final status via a Tekton result or webhook; for the MVP the
 * admin UI polls.
 */
export async function triggerEnvironmentBuild(
	envId: string,
	baseImageResolver?: BaseImageResolver,
): Promise<{
	commitSha: string;
	dockerfilePath: string;
	imageTag: string;
}> {
	const env = await getEnvironment(envId);
	if (!env) throw new Error(`environment ${envId} not found`);

	const baseEnvSlug = env.baseEnvSlug ?? null;

	// Envs with no declared packages don't need a Dockerfile — they reuse the
	// base image directly. Stamp the build as "succeeded" pointing at the
	// parent's imageTag so lookups resolve cleanly.
	if (!hasAnyPackages(env.config.packages ?? {})) {
		await markEnvironmentBuildSucceeded(env.id, {
			sha: baseEnvSlug ?? "root",
			imageTag:
				(baseEnvSlug ? baseImageResolver?.(baseEnvSlug) : null) ??
				"gitea-ryzen.tail286401.ts.net/giteaadmin/openshell-sandbox:latest",
			dockerfilePath: "",
		});
		return {
			commitSha: "no-op",
			dockerfilePath: "",
			imageTag: expectedImageTagForSlug(env.slug),
		};
	}

	await markEnvironmentBuildStarted(env.id);

	try {
		const inputs: DockerfileInputs = {
			slug: env.slug,
			name: env.name,
			baseEnvSlug,
			packages: env.config.packages ?? {},
		};
		const dockerfile = generateDockerfile(inputs, { baseImageResolver });
		const path = dockerfilePathForSlug(env.slug);
		const result = await upsertDockerfile({
			path,
			content: dockerfile,
			commitMessage: `environment(${env.slug}): regenerate Dockerfile (admin console)`,
		});
		// We can't know the final Tekton imageTag until the pipeline finishes.
		// Stamp the expected `:latest` tag so consumers can reference it; the
		// pipeline will overwrite with the SHA-pinned one when it completes.
		const expectedTag = expectedImageTagForSlug(env.slug);
		await markEnvironmentBuildSucceeded(env.id, {
			sha: result.commitSha,
			imageTag: expectedTag,
			dockerfilePath: path,
		});
		return {
			commitSha: result.commitSha,
			dockerfilePath: path,
			imageTag: expectedTag,
		};
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		await markEnvironmentBuildFailed(env.id, message);
		throw e;
	}
}

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
