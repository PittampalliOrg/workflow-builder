import { NextResponse } from "next/server";

export async function POST() {
	return NextResponse.json(
		{
			error:
				"Creating new workflows is disabled after the SW 1.0 cutover. Use the supported workflow instead.",
		},
		{ status: 410 },
	);
}
