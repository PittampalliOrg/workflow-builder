import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth-helpers";
import { getResolvedAgentProfileTemplate } from "@/lib/db/agent-profiles";

const querySchema = z.object({
	version: z.coerce.number().int().min(1).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { id } = await params;
		const parsedQuery = querySchema.safeParse(
			Object.fromEntries(new URL(request.url).searchParams),
		);
		if (!parsedQuery.success) {
			return NextResponse.json(
				{ error: "Validation failed", details: parsedQuery.error.flatten() },
				{ status: 400 },
			);
		}

		const resolved = await getResolvedAgentProfileTemplate({
			templateId: id,
			version: parsedQuery.data.version,
			includeDisabled: false,
		});
		if (!resolved) {
			return NextResponse.json(
				{ error: "Agent profile not found" },
				{ status: 404 },
			);
		}

		return NextResponse.json({
			template: {
				...resolved.template,
				createdAt: resolved.template.createdAt.toISOString(),
				updatedAt: resolved.template.updatedAt.toISOString(),
			},
			templateVersion: {
				...resolved.templateVersion,
				createdAt: resolved.templateVersion.createdAt.toISOString(),
				updatedAt: resolved.templateVersion.updatedAt.toISOString(),
			},
			snapshot: resolved.snapshot,
			warnings: resolved.warnings,
			examples: resolved.examples.map((example) => ({
				...example,
				createdAt: example.createdAt.toISOString(),
				updatedAt: example.updatedAt.toISOString(),
			})),
		});
	} catch (error) {
		console.error("[resources/agent-profiles/:id] GET error:", error);
		return NextResponse.json(
			{ error: "Failed to get agent profile" },
			{ status: 500 },
		);
	}
}
