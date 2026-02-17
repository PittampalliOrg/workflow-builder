import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth-helpers";
import { getResolvedAgentProfileTemplate } from "@/lib/db/agent-profiles";

const previewSchema = z.object({
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
		const body = await request.json().catch(() => ({}));
		const parsed = previewSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Validation failed", details: parsed.error.flatten() },
				{ status: 400 },
			);
		}

		const resolved = await getResolvedAgentProfileTemplate({
			templateId: id,
			version: parsed.data.version,
			includeDisabled: false,
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
		console.error("[resources/agent-profiles/:id/preview] POST error:", error);
		return NextResponse.json(
			{ error: "Failed to preview agent profile" },
			{ status: 500 },
		);
	}
}
