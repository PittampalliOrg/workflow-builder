import { json } from "@sveltejs/kit";
import { db } from "$lib/server/db";
import { users, projects, projectMembers } from "$lib/server/db/schema";

export const GET = async () => {
	try {
		if (!db) {
			return json({ success: false, error: "db is null" });
		}
		const allUsers = await db.select().from(users).limit(10);
		const allProjects = await db.select().from(projects).limit(10);
		const allMembers = await db.select().from(projectMembers).limit(10);

		return json({ success: true, allUsers, allProjects, allMembers });
	} catch (err: any) {
		return json({ success: false, error: err.message });
	}
};
