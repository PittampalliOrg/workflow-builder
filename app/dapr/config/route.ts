import { NextResponse } from "next/server";
import { getMetadata, isAvailable } from "@/lib/dapr/client";

export async function GET() {
	const available = await isAvailable();
	const metadata = available ? await getMetadata() : null;

	return NextResponse.json(
		{
			available,
			id: metadata?.id ?? null,
			runtimeVersion: metadata?.runtimeVersion ?? null,
			components: (metadata?.components ?? []).map((component) => ({
				name: component.name,
				type: component.type,
			})),
		},
		{
			headers: {
				"Cache-Control": "no-store",
			},
		},
	);
}
