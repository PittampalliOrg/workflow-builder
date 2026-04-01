import { NextResponse } from "next/server";

export async function POST() {
	return NextResponse.json(
		{
			error:
				"AI workflow creation is disabled after the SW 1.0 cutover. Edit the supported workflow directly instead.",
		},
		{ status: 410 },
	);
}
