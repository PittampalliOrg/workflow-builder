import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { previewProfileDockerfile } from "$lib/server/sandbox-profiles/builder";
import { getProfile, listProfiles } from "$lib/server/sandbox-profiles/registry";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const profile = await getProfile(params.id);
	if (!profile) return error(404, "Profile not found");
	const all = await listProfiles({ includeArchived: false });
	const bySlug = new Map(all.map((p) => [p.slug, p]));
	const resolver = (slug: string) => bySlug.get(slug)?.imageTag ?? undefined;
	const dockerfile = await previewProfileDockerfile(profile, resolver);
	return json({ dockerfile });
};
