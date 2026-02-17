import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { listAgentProfileTemplates } from "@/lib/db/agent-profiles";

export async function GET(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const rows = await listAgentProfileTemplates({ includeDisabled: false });
		return NextResponse.json({ data: rows });
	} catch (error) {
		console.error("[resources/agent-profiles] GET error:", error);
		return NextResponse.json(
			{ error: "Failed to list agent profiles" },
			{ status: 500 },
		);
	}
}
