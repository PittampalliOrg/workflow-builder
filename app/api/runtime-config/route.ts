import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth-helpers";
import {
	createRuntimeConfigAuditLog,
	listRuntimeConfigAuditLogs,
} from "@/lib/db/runtime-config-audit";
import {
	getRuntimeConfigDefaults,
	normalizeRuntimeConfigMetadata,
	readRuntimeConfigValue,
	writeRuntimeConfigValue,
} from "@/lib/runtime-config-service";
import { getUserProjectRole } from "@/lib/project-service";

function canRead(role: string) {
	return (
		role === "ADMIN" ||
		role === "EDITOR" ||
		role === "OPERATOR" ||
		role === "VIEWER"
	);
}

function canWrite(role: string) {
	return role === "ADMIN";
}

const WriteBody = z.object({
	projectId: z.string().optional(),
	storeName: z.string().min(1).optional(),
	configKey: z.string().min(1),
	value: z.string(),
	metadata: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.optional(),
});

function parseQueryMetadata(value: string | null) {
	if (!value) return undefined;
	try {
		return normalizeRuntimeConfigMetadata(JSON.parse(value));
	} catch {
		return undefined;
	}
}

export async function GET(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { searchParams } = new URL(request.url);
		const projectId = searchParams.get("projectId") ?? session.user.projectId;
		const role = await getUserProjectRole(session.user.id, projectId);
		if (!(role && canRead(role))) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

		const limit = Number.parseInt(searchParams.get("limit") || "30", 10);
		const logs = await listRuntimeConfigAuditLogs({
			projectId,
			limit: Number.isFinite(limit) ? limit : 30,
		});

		const configKey = searchParams.get("configKey")?.trim();
		const storeName = searchParams.get("storeName")?.trim() || undefined;
		const metadata = parseQueryMetadata(searchParams.get("metadata"));
		const current = configKey
			? await readRuntimeConfigValue({
					storeName,
					configKey,
					metadata,
				})
			: null;

		return NextResponse.json({
			data: {
				defaults: getRuntimeConfigDefaults(),
				writerEnabled: Boolean(process.env.RUNTIME_CONFIG_WRITER_URL),
				current,
				logs,
			},
		});
	} catch (error) {
		console.error("[runtime-config GET] Error:", error);
		return NextResponse.json(
			{ error: "Failed to load runtime config" },
			{ status: 500 },
		);
	}
}

export async function POST(request: Request) {
	const session = await getSession(request);
	if (!session?.user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const body = WriteBody.safeParse(await request.json().catch(() => null));
	if (!body.success) {
		return NextResponse.json(
			{ error: "Invalid request body", details: body.error.message },
			{ status: 400 },
		);
	}

	const projectId = body.data.projectId ?? session.user.projectId;
	const role = await getUserProjectRole(session.user.id, projectId);
	if (!(role && canWrite(role))) {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	const metadata = normalizeRuntimeConfigMetadata(body.data.metadata);
	const storeName = body.data.storeName;
	const configKey = body.data.configKey;
	const value = body.data.value;

	try {
		const write = await writeRuntimeConfigValue({
			storeName,
			configKey,
			value,
			metadata,
		});
		const current = await readRuntimeConfigValue({
			storeName: write.storeName,
			configKey: write.configKey,
			metadata,
		});

		await createRuntimeConfigAuditLog({
			projectId,
			userId: session.user.id,
			storeName: write.storeName,
			configKey: write.configKey,
			value,
			metadata,
			status: "success",
			provider: write.provider,
			providerResponse: write.response,
		});

		return NextResponse.json({
			success: true,
			data: {
				storeName: write.storeName,
				configKey: write.configKey,
				current,
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await createRuntimeConfigAuditLog({
			projectId,
			userId: session.user.id,
			storeName: storeName?.trim() || getRuntimeConfigDefaults().storeName,
			configKey,
			value,
			metadata,
			status: "error",
			error: message,
			provider: "external-writer",
		}).catch((auditError) => {
			console.error(
				"[runtime-config POST] Failed writing audit log:",
				auditError,
			);
		});
		return NextResponse.json(
			{ error: "Failed to write runtime config", details: message },
			{ status: 502 },
		);
	}
}
