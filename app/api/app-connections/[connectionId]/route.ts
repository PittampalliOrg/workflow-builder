import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { getSession } from "@/lib/auth-helpers";
import {
	deleteAppConnection,
	getAppConnectionById,
	removeSensitiveData,
	updateAppConnection,
	updateAppConnectionSecretValue,
} from "@/lib/db/app-connections";
import { db } from "@/lib/db";
import { appConnections } from "@/lib/db/schema";
import {
	AppConnectionType,
	AppConnectionStatus,
	type AppConnectionValue,
	type UpdateConnectionValueRequestBody,
} from "@/lib/types/app-connection";
import { deletePieceMcpServer } from "@/lib/k8s/piece-mcp-provisioner";

const ENABLE_LEGACY_MCP_AUTO_CLEANUP =
	process.env.MCP_AUTO_CLEANUP_ON_CONNECTION_DELETE === "true";

type CompatibleUpdateBody = UpdateConnectionValueRequestBody & {
	config?: Record<string, string | undefined>;
};

function valueFromConfig(
	existing: AppConnectionValue,
	config: Record<string, string | undefined>,
): AppConnectionValue {
	switch (existing.type) {
		case AppConnectionType.CUSTOM_AUTH:
			return {
				type: AppConnectionType.CUSTOM_AUTH,
				props: config,
			};
		case AppConnectionType.SECRET_TEXT:
			return {
				type: AppConnectionType.SECRET_TEXT,
				secret_text:
					config.secret_text ?? Object.values(config).find(Boolean) ?? "",
			};
		case AppConnectionType.BASIC_AUTH:
			return {
				type: AppConnectionType.BASIC_AUTH,
				username: config.username ?? "",
				password: config.password ?? "",
			};
		case AppConnectionType.OAUTH2:
			return {
				...existing,
				client_id: config.client_id ?? existing.client_id,
				client_secret: config.client_secret ?? existing.client_secret,
				redirect_url: config.redirect_url ?? existing.redirect_url,
				scope: config.scope ?? existing.scope,
			};
		default:
			return existing;
	}
}

export async function GET(
	request: Request,
	context: { params: Promise<{ connectionId: string }> },
) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { connectionId } = await context.params;
		const connection = await getAppConnectionById(
			connectionId,
			session.user.id,
		);

		if (!connection) {
			return NextResponse.json(
				{ error: "Connection not found" },
				{ status: 404 },
			);
		}

		return NextResponse.json({
			...connection,
			createdAt: connection.createdAt.toISOString(),
			updatedAt: connection.updatedAt.toISOString(),
		});
	} catch (error) {
		return NextResponse.json(
			{
				error: "Failed to fetch app connection",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}

export async function POST(
	request: Request,
	context: { params: Promise<{ connectionId: string }> },
) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { connectionId } = await context.params;
		const body = (await request.json()) as CompatibleUpdateBody;

		const existing = await getAppConnectionById(connectionId, session.user.id);
		if (!existing) {
			return NextResponse.json(
				{ error: "Connection not found" },
				{ status: 404 },
			);
		}

		if (body.config) {
			const updatedValue = valueFromConfig(existing.value, body.config);
			const updated = await updateAppConnectionSecretValue({
				id: connectionId,
				ownerId: session.user.id,
				value: updatedValue,
				displayName: body.displayName || existing.displayName,
			});

			if (!updated) {
				return NextResponse.json(
					{ error: "Connection not found" },
					{ status: 404 },
				);
			}

			return NextResponse.json(removeSensitiveData(updated));
		}

		const updated = await updateAppConnection(connectionId, session.user.id, {
			displayName: body.displayName || existing.displayName,
			metadata: body.metadata,
		});

		if (!updated) {
			return NextResponse.json(
				{ error: "Connection not found" },
				{ status: 404 },
			);
		}

		return NextResponse.json(removeSensitiveData(updated));
	} catch (error) {
		return NextResponse.json(
			{
				error: "Failed to update app connection",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}

export async function DELETE(
	request: Request,
	context: { params: Promise<{ connectionId: string }> },
) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { connectionId } = await context.params;

		// Fetch connection first to get pieceName for cleanup
		const connection = await getAppConnectionById(
			connectionId,
			session.user.id,
		);
		if (!connection) {
			return NextResponse.json(
				{ error: "Connection not found" },
				{ status: 404 },
			);
		}

		const deleted = await deleteAppConnection(connectionId, session.user.id);
		if (!deleted) {
			return NextResponse.json(
				{ error: "Failed to delete connection" },
				{ status: 500 },
			);
		}

		// Legacy-only behavior: keep disabled by default to decouple MCP lifecycle
		// from app connection CRUD.
		if (ENABLE_LEGACY_MCP_AUTO_CLEANUP) {
			(async () => {
				try {
					const remaining = await db
						.select({ id: appConnections.id })
						.from(appConnections)
						.where(
							and(
								eq(appConnections.pieceName, connection.pieceName),
								eq(appConnections.status, AppConnectionStatus.ACTIVE),
							),
						)
						.limit(1);

					if (remaining.length === 0) {
						await deletePieceMcpServer(connection.pieceName);
					}
				} catch (err) {
					console.error(
						`[auto-cleanup] Failed for ${connection.pieceName}:`,
						err instanceof Error ? err.message : err,
					);
				}
			})();
		}

		return NextResponse.json({ success: true });
	} catch (error) {
		return NextResponse.json(
			{
				error: "Failed to delete app connection",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}
