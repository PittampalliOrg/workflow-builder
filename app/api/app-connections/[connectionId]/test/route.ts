import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getAppConnectionById } from "@/lib/db/app-connections";

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> }
) {
  try {
    const session = await getSession(request);
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
