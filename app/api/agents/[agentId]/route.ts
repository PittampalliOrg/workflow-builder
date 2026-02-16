import { eq, and } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";

const updateAgentSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).nullable().optional(),
	agentType: z
		.enum(["general", "code-assistant", "research", "planning", "custom"])
		.optional(),
	instructions: z.string().min(1).max(50000).optional(),
	model: z
		.object({
			provider: z.string().min(1),
			name: z.string().min(1),
		})
		.optional(),
	tools: z
		.array(
			z.object({
				type: z.enum(["workspace", "mcp", "action"]),
				ref: z.string().min(1),
			}),
		)
		.optional(),
	maxTurns: z.number().int().min(1).max(500).optional(),
	timeoutMinutes: z.number().int().min(1).max(480).optional(),
	defaultOptions: z.record(z.string(), z.unknown()).nullable().optional(),
	memoryConfig: z.record(z.string(), z.unknown()).nullable().optional(),
	metadata: z.record(z.string(), z.unknown()).nullable().optional(),
	isDefault: z.boolean().optional(),
	isEnabled: z.boolean().optional(),
	projectId: z.string().nullable().optional(),
});

type RouteParams = { params: Promise<{ agentId: string }> };

export async function GET(request: Request, { params }: RouteParams) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { agentId } = await params;

		const [agent] = await db
			.select()
			.from(agents)
			.where(
				and(eq(agents.id, agentId), eq(agents.userId, session.user.id)),
			)
			.limit(1);

		if (!agent) {
			return NextResponse.json({ error: "Agent not found" }, { status: 404 });
		}

		return NextResponse.json({
			...agent,
			createdAt: agent.createdAt.toISOString(),
			updatedAt: agent.updatedAt.toISOString(),
		});
	} catch (error) {
		console.error("[agents] GET error:", error);
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Failed to get agent" },
			{ status: 500 },
		);
	}
}

export async function PATCH(request: Request, { params }: RouteParams) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { agentId } = await params;
		const body = await request.json();
		const parsed = updateAgentSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Validation failed", details: parsed.error.flatten() },
				{ status: 400 },
			);
		}

		// Verify ownership
		const [existing] = await db
			.select({ id: agents.id })
			.from(agents)
			.where(
				and(eq(agents.id, agentId), eq(agents.userId, session.user.id)),
			)
			.limit(1);

		if (!existing) {
			return NextResponse.json({ error: "Agent not found" }, { status: 404 });
		}

		const data = parsed.data;

		// If setting as default, unset any existing default for this user
		if (data.isDefault) {
			await db
				.update(agents)
				.set({ isDefault: false, updatedAt: new Date() })
				.where(
					and(eq(agents.userId, session.user.id), eq(agents.isDefault, true)),
				);
		}

		const updateData: Record<string, unknown> = { updatedAt: new Date() };
		if (data.name !== undefined) updateData.name = data.name;
		if (data.description !== undefined) updateData.description = data.description;
		if (data.agentType !== undefined) updateData.agentType = data.agentType;
		if (data.instructions !== undefined) updateData.instructions = data.instructions;
		if (data.model !== undefined) updateData.model = data.model;
		if (data.tools !== undefined) updateData.tools = data.tools;
		if (data.maxTurns !== undefined) updateData.maxTurns = data.maxTurns;
		if (data.timeoutMinutes !== undefined) updateData.timeoutMinutes = data.timeoutMinutes;
		if (data.defaultOptions !== undefined) updateData.defaultOptions = data.defaultOptions;
		if (data.memoryConfig !== undefined) updateData.memoryConfig = data.memoryConfig;
		if (data.metadata !== undefined) updateData.metadata = data.metadata;
		if (data.isDefault !== undefined) updateData.isDefault = data.isDefault;
		if (data.isEnabled !== undefined) updateData.isEnabled = data.isEnabled;
		if (data.projectId !== undefined) updateData.projectId = data.projectId;

		const [updated] = await db
			.update(agents)
			.set(updateData)
			.where(eq(agents.id, agentId))
			.returning();

		return NextResponse.json({
			...updated,
			createdAt: updated.createdAt.toISOString(),
			updatedAt: updated.updatedAt.toISOString(),
		});
	} catch (error) {
		console.error("[agents] PATCH error:", error);
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Failed to update agent" },
			{ status: 500 },
		);
	}
}

export async function DELETE(request: Request, { params }: RouteParams) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { agentId } = await params;

		const result = await db
			.delete(agents)
			.where(
				and(eq(agents.id, agentId), eq(agents.userId, session.user.id)),
			)
			.returning({ id: agents.id });

		if (result.length === 0) {
			return NextResponse.json({ error: "Agent not found" }, { status: 404 });
		}

		return NextResponse.json({ success: true });
	} catch (error) {
		console.error("[agents] DELETE error:", error);
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Failed to delete agent" },
			{ status: 500 },
		);
	}
}
