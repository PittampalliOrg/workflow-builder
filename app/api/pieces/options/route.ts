import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAppConnectionByExternalId } from "@/lib/db/app-connections";
import { resolveConnectionValueForUse } from "@/lib/app-connections/resolve-connection-value";

const FN_ACTIVEPIECES_URL =
  process.env.FN_ACTIVEPIECES_URL ||
  "http://fn-activepieces-standalone.workflow-builder.svc.cluster.local";

interface OptionsRequestBody {
  pieceName: string;
  actionName: string;
  propertyName: string;
  connectionExternalId?: string;
  input?: Record<string, unknown>;
  searchValue?: string;
}

function isValidBody(value: unknown): value is OptionsRequestBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.pieceName === "string" &&
    typeof body.actionName === "string" &&
    typeof body.propertyName === "string"
  );
}

/**
 * POST /api/pieces/options
 *
 * Fetch dynamic dropdown options for an Activepieces action property.
 * Session-authenticated. Proxies to fn-activepieces /options endpoint.
 */
export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody = await request.json();
    if (!isValidBody(rawBody)) {
      return NextResponse.json(
        { error: "Invalid request body. Required: pieceName, actionName, propertyName" },
        { status: 400 }
      );
    }

    // Resolve auth if connectionExternalId is provided
    let authValue: unknown = undefined;
    if (rawBody.connectionExternalId) {
      const connection = await getAppConnectionByExternalId(
        rawBody.connectionExternalId,
        session.user.id
      );
      if (!connection) {
        return NextResponse.json(
          { error: "Connection not found" },
          { status: 404 }
        );
      }

      authValue = await resolveConnectionValueForUse(connection);
    }

    // Forward to fn-activepieces
    const fnResponse = await fetch(`${FN_ACTIVEPIECES_URL}/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pieceName: rawBody.pieceName,
        actionName: rawBody.actionName,
        propertyName: rawBody.propertyName,
        auth: authValue,
        input: rawBody.input || {},
        searchValue: rawBody.searchValue,
      }),
    });

    if (!fnResponse.ok) {
      const errorText = await fnResponse.text();
      console.error(
        `[pieces/options] fn-activepieces returned ${fnResponse.status}: ${errorText}`
      );
      return NextResponse.json(
        { error: "Failed to fetch options from fn-activepieces", details: errorText },
        { status: fnResponse.status }
      );
    }

    const data = await fnResponse.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("[pieces/options] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch dropdown options",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
