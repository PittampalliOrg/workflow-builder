import { error } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";

export async function isPlatformAdmin(userId: string | null | undefined): Promise<boolean> {
	if (!userId) return false;
	return getApplicationAdapters().workflowData.isPlatformAdmin(userId);
}

export async function requirePlatformAdmin(locals: App.Locals): Promise<void> {
	if (!locals.session?.userId) {
		throw error(401, "Authentication required");
	}
	if (!(await isPlatformAdmin(locals.session.userId))) {
		throw error(403, "Admin access required");
	}
}
