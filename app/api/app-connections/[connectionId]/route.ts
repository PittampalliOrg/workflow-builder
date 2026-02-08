import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  deleteAppConnection,
  getAppConnectionById,
  removeSensitiveData,
  updateAppConnection,
  updateAppConnectionSecretValue,
} from "@/lib/db/app-connections";
import {
  AppConnectionType,
  type AppConnectionValue,
  type UpdateConnectionValueRequestBody,
} from "@/lib/types/app-connection";

type CompatibleUpdateBody = UpdateConnectionValueRequestBody & {
  config?: Record<string, string | undefined>;
};

function valueFromConfig(
  existing: AppConnectionValue,
  config: Record<string, string | undefined>
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

    return NextResponse.json(removeSensitiveData(connection));
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to fetch app connection",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

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
    const body = (await request.json()) as CompatibleUpdateBody;

    const existing = await getAppConnectionById(connectionId, session.user.id);
    if (!existing) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
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
          { status: 404 }
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
        { status: 404 }
      );
    }

    return NextResponse.json(removeSensitiveData(updated));
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to update app connection",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ connectionId: string }> }
) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { connectionId } = await context.params;
    const deleted = await deleteAppConnection(connectionId, session.user.id);

    if (!deleted) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to delete app connection",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
