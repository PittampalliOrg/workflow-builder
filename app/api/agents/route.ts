import { desc, eq, and } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";

const createAgentSchema = z.object({
	name: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	agentType: z
		.enum(["general", "code-assistant", "research", "planning", "custom"])
		.default("general"),
	instructions: z.string().min(1).max(50000),
	model: z.object({
		provider: z.string().min(1),
		name: z.string().min(1),
	}),
	tools: z
		.array(
			z.object({
				type: z.enum(["workspace", "mcp", "action"]),
				ref: z.string().min(1),
			}),
		)
		.default([]),
	maxTurns: z.number().int().min(1).max(500).default(50),
	timeoutMinutes: z.number().int().min(1).max(480).default(30),
	defaultOptions: z.record(z.string(), z.unknown()).optional(),
	memoryConfig: z.record(z.string(), z.unknown()).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	isDefault: z.boolean().default(false),
	isEnabled: z.boolean().default(true),
	projectId: z.string().optional(),
});

export async function GET(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const userAgents = await db
			.select()
			.from(agents)
			.where(eq(agents.userId, session.user.id))
			.orderBy(desc(agents.updatedAt));

		return NextResponse.json({
			data: userAgents.map((a) => ({
				...a,
				createdAt: a.createdAt.toISOString(),
				updatedAt: a.updatedAt.toISOString(),
			})),
		});
	} catch (error) {
		console.error("[agents] GET error:", error);
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Failed to list agents" },
			{ status: 500 },
		);
	}
}

export async function POST(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body = await request.json();
		const parsed = createAgentSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Validation failed", details: parsed.error.flatten() },
				{ status: 400 },
			);
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

		const [created] = await db
			.insert(agents)
			.values({
				name: data.name,
				description: data.description,
				agentType: data.agentType,
				instructions: data.instructions,
				model: data.model,
				tools: data.tools,
				maxTurns: data.maxTurns,
				timeoutMinutes: data.timeoutMinutes,
				defaultOptions: data.defaultOptions,
				memoryConfig: data.memoryConfig,
				metadata: data.metadata,
				isDefault: data.isDefault,
				isEnabled: data.isEnabled,
				userId: session.user.id,
				projectId: data.projectId,
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
		console.error("[agents] POST error:", error);
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Failed to create agent" },
			{ status: 500 },
		);
	}
}
