import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import {
	deleteMcpConnection,
	getMcpConnectionById,
} from "@/lib/db/mcp-connections";
import { deletePieceServer } from "@/lib/mcp-runtime/service";
import { getUserProjectRole } from "@/lib/project-service";

function canWrite(role: string) {
	return role === "ADMIN" || role === "EDITOR";
}

export async function DELETE(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const session = await getSession(request);
	if (!session?.user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const role = await getUserProjectRole(
		session.user.id,
		session.user.projectId,
	);
	if (!(role && canWrite(role))) {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	const { id } = await params;
	const row = await getMcpConnectionById({
		id,
		projectId: session.user.projectId,
	});
	if (!row) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}
	if (row.sourceType === "hosted_workflow") {
		return NextResponse.json(
			{ error: "Hosted workflow MCP connection cannot be deleted" },
			{ status: 409 },
		);
	}

	const deleted = await deleteMcpConnection({
		id,
		projectId: session.user.projectId,
	});

	if (deleted && row.sourceType === "nimble_piece" && row.pieceName) {
		deletePieceServer(row.pieceName).catch((error) => {
			console.error(
				"[mcp-connections DELETE] Failed to cleanup runtime:",
				error,
			);
		});
	}

	return NextResponse.json({ success: deleted });
}
