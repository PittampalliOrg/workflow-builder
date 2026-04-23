import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { eq } from "drizzle-orm";

import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import {
	enrichLiveCommits,
	getDeploymentMetadata,
} from "$lib/server/gitops/deployment-metadata";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(500, "Database not configured");

	const [user] = await db
		.select({ platformRole: users.platformRole })
		.from(users)
		.where(eq(users.id, locals.session.userId))
		.limit(1);
	if (user?.platformRole !== "ADMIN") return error(403, "Admin access required");

	const metadata = await enrichLiveCommits(await getDeploymentMetadata());
	return json(metadata);
};
