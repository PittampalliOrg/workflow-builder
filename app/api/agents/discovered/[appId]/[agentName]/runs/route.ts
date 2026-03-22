import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { workflowAgentRuns } from "@/lib/db/schema";

export async function GET(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const runs = await db
			.select()
			.from(workflowAgentRuns)
			.orderBy(desc(workflowAgentRuns.createdAt))
			.limit(20);

		return NextResponse.json({ runs });
	} catch (error) {
		console.error("Failed to fetch agent runs:", error);
		return NextResponse.json(
			{ error: "Failed to fetch agent runs" },
			{ status: 500 },
		);
	}
}
