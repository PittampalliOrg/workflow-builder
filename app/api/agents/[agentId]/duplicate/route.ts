import { eq, and } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";

type RouteParams = { params: Promise<{ agentId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { agentId } = await params;

		const [source] = await db
			.select()
			.from(agents)
			.where(and(eq(agents.id, agentId), eq(agents.userId, session.user.id)))
			.limit(1);

		if (!source) {
			return NextResponse.json({ error: "Agent not found" }, { status: 404 });
		}

		const [created] = await db
			.insert(agents)
			.values({
				name: `${source.name} (copy)`,
				description: source.description,
				agentType: source.agentType,
				instructions: source.instructions,
				model: source.model,
				tools: source.tools,
				maxTurns: source.maxTurns,
				timeoutMinutes: source.timeoutMinutes,
				defaultOptions: source.defaultOptions,
				memoryConfig: source.memoryConfig,
				metadata: source.metadata,
				instructionsPresetId: source.instructionsPresetId,
				instructionsPresetVersion: source.instructionsPresetVersion,
				schemaPresetId: source.schemaPresetId,
				schemaPresetVersion: source.schemaPresetVersion,
				modelProfileId: source.modelProfileId,
				modelProfileVersion: source.modelProfileVersion,
				agentProfileTemplateId: source.agentProfileTemplateId,
				agentProfileTemplateVersion: source.agentProfileTemplateVersion,
				isDefault: false,
				isEnabled: source.isEnabled,
				userId: session.user.id,
				projectId: source.projectId,
			})
			.returning();

		return NextResponse.json(
			{
				...created,
				createdAt: created.createdAt.toISOString(),
				updatedAt: created.updatedAt.toISOString(),
			},
			{ status: 201 },
		);
	} catch (error) {
		console.error("[agents] duplicate error:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Failed to duplicate agent",
			},
			{ status: 500 },
		);
	}
}
