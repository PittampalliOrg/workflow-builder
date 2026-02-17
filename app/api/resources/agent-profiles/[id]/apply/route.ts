import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth-helpers";
import { applyAgentProfileToAgent } from "@/lib/db/agent-profiles";

const applySchema = z.object({
	agentId: z.string().min(1),
	version: z.number().int().min(1).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { id } = await params;
		const body = await request.json();
		const parsed = applySchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Validation failed", details: parsed.error.flatten() },
				{ status: 400 },
			);
		}

		const resolved = await applyAgentProfileToAgent({
			agentId: parsed.data.agentId,
			userId: session.user.id,
			templateId: id,
			version: parsed.data.version,
		});
		if (!resolved) {
			return NextResponse.json(
				{ error: "Agent profile not found" },
				{ status: 404 },
			);
		}

		return NextResponse.json({
			templateId: resolved.template.id,
			templateVersion: resolved.templateVersion.version,
			snapshot: resolved.snapshot,
			warnings: resolved.warnings,
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to apply agent profile";
		const status = message === "Agent not found" ? 404 : 500;
		return NextResponse.json({ error: message }, { status });
	}
}
