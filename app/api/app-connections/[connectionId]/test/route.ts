import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAppConnectionById } from "@/lib/db/app-connections";

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> }
) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { connectionId } = await context.params;
    const connection = await getAppConnectionById(
      connectionId,
      session.user.id
    );

    if (!connection) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      status: "success",
      message: "Connection exists and is accessible",
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Connection failed",
      },
      { status: 400 }
    );
  }
}
