import { desc, eq, and } from "drizzle-orm";
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

type AgentTypeValue =
	| "general"
	| "code-assistant"
	| "research"
	| "planning"
	| "custom";

const createAgentSchema = z
	.object({
		name: z.string().min(1).max(200),
		description: z.string().max(2000).optional(),
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
		defaultOptions: z.record(z.string(), z.unknown()).optional(),
		memoryConfig: z.record(z.string(), z.unknown()).optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
		instructionsPresetId: z.string().nullable().optional(),
		schemaPresetId: z.string().nullable().optional(),
		modelProfileId: z.string().nullable().optional(),
		agentProfileTemplateId: z.string().nullable().optional(),
		isDefault: z.boolean().default(false),
		isEnabled: z.boolean().default(true),
		projectId: z.string().optional(),
	})
	.superRefine((value, ctx) => {
		if (
			!value.instructions &&
			!value.instructionsPresetId &&
			!value.agentProfileTemplateId
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["instructions"],
				message:
					"instructions, instructionsPresetId, or agentProfileTemplateId is required",
			});
		}
		if (
			!value.model &&
			!value.modelProfileId &&
			!value.agentProfileTemplateId
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["model"],
				message: "model, modelProfileId, or agentProfileTemplateId is required",
			});
		}
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
			{
				error: error instanceof Error ? error.message : "Failed to list agents",
			},
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
		const projectId = data.projectId ?? session.user.projectId;
		let resolvedAgentType: AgentTypeValue = data.agentType ?? "general";
		let resolvedInstructions = data.instructions ?? "";
		let resolvedTools = data.tools ?? [];
		let instructionsPresetVersion: number | null = null;
		let agentProfileTemplateVersion: number | null = null;
		if (data.instructionsPresetId) {
			const preset = await resolvePromptPresetForUse({
				id: data.instructionsPresetId,
				userId: session.user.id,
				projectId,
			});
			if (!preset) {
				return NextResponse.json(
					{ error: "Instructions preset not found" },
					{ status: 404 },
				);
			}
			resolvedInstructions = preset.systemPrompt;
			instructionsPresetVersion = preset.version;
		}

		let resolvedModel = data.model ?? { provider: "openai", name: "gpt-4o" };
		let resolvedDefaultOptions = data.defaultOptions;
		let resolvedMemoryConfig = data.memoryConfig;
		let resolvedMaxTurns = data.maxTurns ?? 50;
		let resolvedTimeoutMinutes = data.timeoutMinutes ?? 30;
		let modelProfileVersion: number | null = null;
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
			if (
				profile.snapshot.agentType === "general" ||
				profile.snapshot.agentType === "code-assistant" ||
				profile.snapshot.agentType === "research" ||
				profile.snapshot.agentType === "planning" ||
				profile.snapshot.agentType === "custom"
			) {
				resolvedAgentType = profile.snapshot.agentType;
			}
			resolvedInstructions = profile.snapshot.instructions;
			resolvedModel = profile.snapshot.model;
			resolvedTools = profile.snapshot.tools;
			resolvedMaxTurns = profile.snapshot.maxTurns;
			resolvedTimeoutMinutes = profile.snapshot.timeoutMinutes;
			resolvedDefaultOptions =
				profile.snapshot.defaultOptions ?? resolvedDefaultOptions;
			resolvedMemoryConfig =
				profile.snapshot.memoryConfig ?? resolvedMemoryConfig;
			agentProfileTemplateVersion = profile.templateVersion.version;
		}

		if (data.modelProfileId) {
			const profile = await resolveModelProfilePresetForUse({
				id: data.modelProfileId,
				userId: session.user.id,
				projectId,
			});
			if (!profile) {
				return NextResponse.json(
					{ error: "Model profile preset not found" },
					{ status: 404 },
				);
			}
			resolvedModel = profile.model;
			resolvedDefaultOptions =
				(profile.defaultOptions as Record<string, unknown> | null) ??
				resolvedDefaultOptions;
			resolvedMaxTurns = profile.maxTurns ?? resolvedMaxTurns;
			resolvedTimeoutMinutes = profile.timeoutMinutes ?? resolvedTimeoutMinutes;
			modelProfileVersion = profile.version;
		}

		let schemaPresetVersion: number | null = null;
		if (data.schemaPresetId) {
			const schemaPreset = await resolveSchemaPresetForUse({
				id: data.schemaPresetId,
				userId: session.user.id,
				projectId,
			});
			if (!schemaPreset) {
				return NextResponse.json(
					{ error: "Schema preset not found" },
					{ status: 404 },
				);
			}
			schemaPresetVersion = schemaPreset.version;
			const existingDefaultOptions =
				(resolvedDefaultOptions as Record<string, unknown>) ?? {};
			resolvedDefaultOptions = {
				...existingDefaultOptions,
				structuredOutput: {
					schema: schemaPreset.schema,
				},
			};
		}

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
				agentType: resolvedAgentType,
				instructions: resolvedInstructions,
				model: resolvedModel,
				tools: resolvedTools,
				maxTurns: resolvedMaxTurns,
				timeoutMinutes: resolvedTimeoutMinutes,
				defaultOptions: resolvedDefaultOptions,
				memoryConfig: resolvedMemoryConfig,
				metadata: data.metadata,
				instructionsPresetId: data.instructionsPresetId ?? null,
				instructionsPresetVersion,
				schemaPresetId: data.schemaPresetId ?? null,
				schemaPresetVersion,
				modelProfileId: data.modelProfileId ?? null,
				modelProfileVersion,
				agentProfileTemplateId: data.agentProfileTemplateId ?? null,
				agentProfileTemplateVersion,
				isDefault: data.isDefault,
				isEnabled: data.isEnabled,
				userId: session.user.id,
				projectId,
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
			{
				error:
					error instanceof Error ? error.message : "Failed to create agent",
			},
			{ status: 500 },
		);
	}
}
