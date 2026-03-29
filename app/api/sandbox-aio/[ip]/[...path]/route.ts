import { NextResponse } from "next/server";

export async function GET() {
	return NextResponse.json(
		{
			error:
				"The legacy sandbox-aio proxy has been retired. OpenShell workflows no longer expose AIO browser sandboxes.",
		},
		{ status: 410 },
	);
}

export async function POST() {
	return GET();
}
