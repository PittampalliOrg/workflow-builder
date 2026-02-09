import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { userIdentities, users } from "@/lib/db/schema";

export async function GET(request: Request) {
  try {
    const session = await getSession(request);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userData = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
      columns: {
        id: true,
        name: true,
        email: true,
        image: true,
      },
    });

    if (!userData) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Get the user's identity to determine auth provider
    const identity = await db.query.userIdentities.findFirst({
      where: eq(userIdentities.userId, session.user.id),
      columns: {
        provider: true,
      },
    });

    return NextResponse.json({
      ...userData,
      providerId: identity?.provider ?? null,
    });
  } catch (error) {
    console.error("Failed to get user:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to get user",
      },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await getSession(request);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is an OAuth user (can't update profile)
    const identity = await db.query.userIdentities.findFirst({
      where: eq(userIdentities.userId, session.user.id),
      columns: {
        provider: true,
      },
    });

    // Block updates for OAuth users (vercel, github, google, etc.)
    const oauthProviders = ["vercel", "github", "google"];
    if (identity && oauthProviders.includes(identity.provider)) {
      return NextResponse.json(
        { error: "Cannot update profile for OAuth users" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const updates: { name?: string; email?: string } = {};

    if (body.name !== undefined) {
      updates.name = body.name;
    }
    if (body.email !== undefined) {
      updates.email = body.email;
    }

    await db.update(users).set(updates).where(eq(users.id, session.user.id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to update user:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to update user",
      },
      { status: 500 }
    );
  }
}
