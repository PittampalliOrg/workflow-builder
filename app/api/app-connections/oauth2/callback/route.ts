import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.json(
      {
        status: "error",
        error,
        errorDescription: searchParams.get("error_description") ?? "",
      },
      { status: 400 }
    );
  }

  if (!code) {
    return NextResponse.json({ error: "Missing OAuth2 code" }, { status: 400 });
  }

  return NextResponse.json({
    status: "success",
    code,
    state,
  });
}
