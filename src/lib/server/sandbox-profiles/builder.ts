import type { SandboxProfile } from "$lib/types/sandbox-profiles";
import {
	dockerfilePathForSlug,
	expectedImageTagForSlug,
	generateDockerfile,
	hasAnyPackages,
	type BaseImageResolver,
} from "./dockerfile-gen";
import { upsertDockerfile } from "./gitea-commit";
import {
	getProfile,
	markBuildFailed,
	markBuildStarted,
	markBuildSucceeded,
} from "./registry";

/**
 * Kick off a rebuild for the given profile. Returns as soon as the Gitea
 * commit lands — Tekton picks up the push async and finishes the image
 * build in the cluster. Admin UI polls `GET /[id]` afterwards to watch
 * `lastBuildStatus` transition building → built.
 *
 * We DO NOT wait for the Tekton pipeline here (would hold the HTTP
 * connection for minutes). The pipeline itself is expected to POST back to
 * `/api/internal/sandbox-profiles/[id]/build-result` with the final status,
 * but for the MVP the admin UI can just poll.
 */
export async function triggerProfileBuild(
	profileId: string,
	baseImageResolver?: BaseImageResolver,
): Promise<{
	commitSha: string;
	dockerfilePath: string;
	imageTag: string;
}> {
	const profile = await getProfile(profileId);
	if (!profile) throw new Error(`profile ${profileId} not found`);

	// Profiles with no packages are still valid — they're a rename/metadata
	// mirror of the base. Don't bother regenerating in that case; reuse the
	// base's imageTag. Keeps the registry clean.
	if (!hasAnyPackages(profile.packages)) {
		await markBuildSucceeded(profile.id, {
			sha: profile.baseProfileSlug ?? "root",
			imageTag:
				(profile.baseProfileSlug
					? baseImageResolver?.(profile.baseProfileSlug)
					: null) ?? "gitea-ryzen.tail286401.ts.net/giteaadmin/openshell-sandbox:latest",
			dockerfilePath: "", // no generated file
		});
		return {
			commitSha: "no-op",
			dockerfilePath: "",
			imageTag: expectedImageTagForSlug(profile.slug),
		};
	}

	await markBuildStarted(profile.id);

	try {
		const dockerfile = generateDockerfile(profile, { baseImageResolver });
		const path = dockerfilePathForSlug(profile.slug);
		const result = await upsertDockerfile({
			path,
			content: dockerfile,
			commitMessage: `sandbox-profile(${profile.slug}): regenerate Dockerfile (admin console)`,
		});
		// We can't know the final Tekton imageTag until the pipeline finishes.
		// Stamp the expected tag so consumers can reference it; the pipeline
		// will overwrite with the SHA-pinned one when it completes.
		const expectedTag = expectedImageTagForSlug(profile.slug);
		await markBuildSucceeded(profile.id, {
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
		await markBuildFailed(profile.id, message);
		throw e;
	}
}

/**
 * Helper for the Dockerfile-preview endpoint — used by the admin UI to
 * show users what the generated file will look like before hitting Build.
 */
export async function previewProfileDockerfile(
	profile: SandboxProfile,
	baseImageResolver?: BaseImageResolver,
): Promise<string> {
	if (!hasAnyPackages(profile.packages)) {
		return `# Profile "${profile.slug}" has no declared packages — image reuses the base directly.`;
	}
	return generateDockerfile(profile, { baseImageResolver });
}
