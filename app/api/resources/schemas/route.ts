import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth-helpers";
import { createResourceSchema, listResourceSchemas } from "@/lib/db/resources";

const createSchema = z.object({
	name: z.string().min(1).max(200),
	description: z.string().max(2000).nullable().optional(),
	schema: z.unknown(),
	schemaType: z.enum(["json-schema"]).optional(),
	metadata: z.record(z.string(), z.unknown()).nullable().optional(),
	isEnabled: z.boolean().optional(),
	projectId: z.string().nullable().optional(),
});

export async function GET(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const data = await listResourceSchemas({
			userId: session.user.id,
			projectId: session.user.projectId,
			includeDisabled: true,
		});

		return NextResponse.json({
			data: data.map((row) => ({
				...row,
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
			})),
		});
	} catch (error) {
		console.error("[resources/schemas] GET error:", error);
		return NextResponse.json(
			{ error: "Failed to list schema resources" },
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
		const parsed = createSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Validation failed", details: parsed.error.flatten() },
				{ status: 400 },
			);
		}

		const created = await createResourceSchema({
			userId: session.user.id,
			currentProjectId: session.user.projectId,
			input: parsed.data,
		});

		return NextResponse.json(
			{
				...created,
				createdAt: created.createdAt.toISOString(),
				updatedAt: created.updatedAt.toISOString(),
			},
			{ status: 201 },
		);
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to create schema resource";
		const status = message === "Forbidden" ? 403 : 400;
		return NextResponse.json({ error: message }, { status });
	}
}
