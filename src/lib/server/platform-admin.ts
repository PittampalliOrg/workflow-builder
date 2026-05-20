import { error } from "@sveltejs/kit";
import { eq } from "drizzle-orm";

import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";

export async function isPlatformAdmin(userId: string | null | undefined): Promise<boolean> {
	if (!userId || !db) return false;
	const [row] = await db
		.select({ platformRole: users.platformRole })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return row?.platformRole === "ADMIN";
}

export async function requirePlatformAdmin(locals: App.Locals): Promise<void> {
	if (!locals.session?.userId) {
		throw error(401, "Authentication required");
	}
	if (!(await isPlatformAdmin(locals.session.userId))) {
		throw error(403, "Admin access required");
	}
}
