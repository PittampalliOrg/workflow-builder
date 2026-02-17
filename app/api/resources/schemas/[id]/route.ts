import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth-helpers";
import {
	deleteResourceSchemaById,
	getResourceSchemaByIdForRead,
	updateResourceSchemaById,
} from "@/lib/db/resources";

const updateSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).nullable().optional(),
	schema: z.unknown().optional(),
	schemaType: z.enum(["json-schema"]).optional(),
	metadata: z.record(z.string(), z.unknown()).nullable().optional(),
	isEnabled: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { id } = await params;
		const row = await getResourceSchemaByIdForRead({
			id,
			userId: session.user.id,
			projectId: session.user.projectId,
		});
		if (!row) {
			return NextResponse.json(
				{ error: "Resource not found" },
				{ status: 404 },
			);
		}

		return NextResponse.json({
			...row,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to get resource";
		const status = message === "Not found" ? 404 : 500;
		return NextResponse.json({ error: message }, { status });
	}
}

export async function PATCH(request: Request, { params }: RouteParams) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body = await request.json();
		const parsed = updateSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Validation failed", details: parsed.error.flatten() },
				{ status: 400 },
			);
		}

		const { id } = await params;
		const updated = await updateResourceSchemaById({
			id,
			userId: session.user.id,
			projectId: session.user.projectId,
			input: parsed.data,
		});

		return NextResponse.json({
			...updated,
			createdAt: updated.createdAt.toISOString(),
			updatedAt: updated.updatedAt.toISOString(),
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to update resource";
		const status =
			message === "Not found" ? 404 : message === "Forbidden" ? 403 : 400;
		return NextResponse.json({ error: message }, { status });
	}
}

export async function DELETE(request: Request, { params }: RouteParams) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { id } = await params;
		const ok = await deleteResourceSchemaById({
			id,
			userId: session.user.id,
			projectId: session.user.projectId,
		});
		if (!ok) {
			return NextResponse.json(
				{ error: "Resource not found" },
				{ status: 404 },
			);
		}

		return NextResponse.json({ success: true });
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to delete resource";
		const status = message === "Forbidden" ? 403 : 500;
		return NextResponse.json({ error: message }, { status });
	}
}
