import { eq, and } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { getResolvedAgentProfileTemplate } from "@/lib/db/agent-profiles";
import {
	resolveModelProfilePresetForUse,
	resolvePromptPresetForUse,
	resolveSchemaPresetForUse,
} from "@/lib/db/resources";
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
	instructionsPresetId: z.string().nullable().optional(),
	schemaPresetId: z.string().nullable().optional(),
	modelProfileId: z.string().nullable().optional(),
	agentProfileTemplateId: z.string().nullable().optional(),
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
			.where(and(eq(agents.id, agentId), eq(agents.userId, session.user.id)))
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
			.select({ id: agents.id, defaultOptions: agents.defaultOptions })
			.from(agents)
			.where(and(eq(agents.id, agentId), eq(agents.userId, session.user.id)))
			.limit(1);

		if (!existing) {
			return NextResponse.json({ error: "Agent not found" }, { status: 404 });
		}

		const data = parsed.data;
		const targetProjectId =
			(data.projectId === undefined
				? session.user.projectId
				: data.projectId) ?? session.user.projectId;
		const updateData: Record<string, unknown> = { updatedAt: new Date() };

		// If setting as default, unset any existing default for this user
		if (data.isDefault) {
			await db
				.update(agents)
				.set({ isDefault: false, updatedAt: new Date() })
				.where(
					and(eq(agents.userId, session.user.id), eq(agents.isDefault, true)),
				);
		}

		if (data.name !== undefined) updateData.name = data.name;
		if (data.description !== undefined)
			updateData.description = data.description;
		if (data.agentType !== undefined) updateData.agentType = data.agentType;
		if (data.instructions !== undefined)
			updateData.instructions = data.instructions;
		if (data.model !== undefined) updateData.model = data.model;
		if (data.tools !== undefined) updateData.tools = data.tools;
		if (data.maxTurns !== undefined) updateData.maxTurns = data.maxTurns;
		if (data.timeoutMinutes !== undefined)
			updateData.timeoutMinutes = data.timeoutMinutes;
		if (data.defaultOptions !== undefined)
			updateData.defaultOptions = data.defaultOptions;
		if (data.memoryConfig !== undefined)
			updateData.memoryConfig = data.memoryConfig;
		if (data.metadata !== undefined) updateData.metadata = data.metadata;
		if (data.instructionsPresetId !== undefined)
			updateData.instructionsPresetId = data.instructionsPresetId;
		if (data.schemaPresetId !== undefined)
			updateData.schemaPresetId = data.schemaPresetId;
		if (data.modelProfileId !== undefined)
			updateData.modelProfileId = data.modelProfileId;
		if (data.agentProfileTemplateId !== undefined) {
			updateData.agentProfileTemplateId = data.agentProfileTemplateId;
		}
		if (data.isDefault !== undefined) updateData.isDefault = data.isDefault;
		if (data.isEnabled !== undefined) updateData.isEnabled = data.isEnabled;
		if (data.projectId !== undefined) updateData.projectId = data.projectId;

		if (data.instructionsPresetId !== undefined) {
			if (data.instructionsPresetId) {
				const preset = await resolvePromptPresetForUse({
					id: data.instructionsPresetId,
					userId: session.user.id,
					projectId: targetProjectId,
				});
				if (!preset) {
					return NextResponse.json(
						{ error: "Instructions preset not found" },
						{ status: 404 },
					);
				}
				updateData.instructions = preset.systemPrompt;
				updateData.instructionsPresetVersion = preset.version;
			} else {
				updateData.instructionsPresetVersion = null;
			}
		}

		if (data.modelProfileId !== undefined) {
			if (data.modelProfileId) {
				const profile = await resolveModelProfilePresetForUse({
					id: data.modelProfileId,
					userId: session.user.id,
					projectId: targetProjectId,
				});
				if (!profile) {
					return NextResponse.json(
						{ error: "Model profile preset not found" },
						{ status: 404 },
					);
				}
				updateData.model = profile.model;
				updateData.modelProfileVersion = profile.version;
				if (data.maxTurns === undefined && profile.maxTurns != null) {
					updateData.maxTurns = profile.maxTurns;
				}
				if (
					data.timeoutMinutes === undefined &&
					profile.timeoutMinutes != null
				) {
					updateData.timeoutMinutes = profile.timeoutMinutes;
				}
				if (data.defaultOptions === undefined) {
					updateData.defaultOptions = profile.defaultOptions ?? null;
				}
			} else {
				updateData.modelProfileVersion = null;
			}
		}

		if (data.schemaPresetId !== undefined) {
			if (data.schemaPresetId) {
				const schemaPreset = await resolveSchemaPresetForUse({
					id: data.schemaPresetId,
					userId: session.user.id,
					projectId: targetProjectId,
				});
				if (!schemaPreset) {
					return NextResponse.json(
						{ error: "Schema preset not found" },
						{ status: 404 },
					);
				}
				updateData.schemaPresetVersion = schemaPreset.version;
				const mergedDefaultOptions: Record<string, unknown> =
					(data.defaultOptions as Record<string, unknown> | undefined) ??
					(existing.defaultOptions as Record<string, unknown> | null) ??
					{};
				updateData.defaultOptions = {
					...mergedDefaultOptions,
					structuredOutput: {
						schema: schemaPreset.schema,
					},
				};
			} else {
				updateData.schemaPresetVersion = null;
			}
		}

		if (data.agentProfileTemplateId !== undefined) {
			if (data.agentProfileTemplateId) {
				const profile = await getResolvedAgentProfileTemplate({
					templateId: data.agentProfileTemplateId,
					includeDisabled: false,
				});
				if (!profile) {
					return NextResponse.json(
						{ error: "Agent profile template not found" },
						{ status: 404 },
					);
				}
				updateData.agentType = profile.snapshot.agentType;
				updateData.instructions = profile.snapshot.instructions;
				updateData.model = profile.snapshot.model;
				updateData.tools = profile.snapshot.tools;
				updateData.maxTurns = profile.snapshot.maxTurns;
				updateData.timeoutMinutes = profile.snapshot.timeoutMinutes;
				updateData.defaultOptions = profile.snapshot.defaultOptions;
				updateData.memoryConfig = profile.snapshot.memoryConfig;
				updateData.agentProfileTemplateVersion =
					profile.templateVersion.version;
			} else {
				updateData.agentProfileTemplateVersion = null;
			}
		}

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
			{
				error:
					error instanceof Error ? error.message : "Failed to update agent",
			},
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
			.where(and(eq(agents.id, agentId), eq(agents.userId, session.user.id)))
			.returning({ id: agents.id });

		if (result.length === 0) {
			return NextResponse.json({ error: "Agent not found" }, { status: 404 });
		}

		return NextResponse.json({ success: true });
	} catch (error) {
		console.error("[agents] DELETE error:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Failed to delete agent",
			},
			{ status: 500 },
		);
	}
}
