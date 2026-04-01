import { NextResponse } from "next/server";

export async function POST() {
	return NextResponse.json(
		{
			error:
				"Creating workflows from imported specs is disabled after the SW 1.0 cutover. Import SW 1.0 JSON into the supported workflow instead.",
		},
		{ status: 410 },
	);
}
