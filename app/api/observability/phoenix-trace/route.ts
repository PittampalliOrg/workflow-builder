import { NextResponse } from "next/server";
import {
	getDirectPhoenixTraceUrl,
	PHOENIX_BASE_URL,
} from "@/lib/observability/phoenix";

const PHOENIX_TRACE_LINK_QUERY = `
	query ResolvePhoenixTraceLink($id: ID!, $traceId: ID!) {
		project: node(id: $id) {
			__typename
			... on Project {
				trace(traceId: $traceId) {
					rootSpans: spans(
						first: 1
						rootSpansOnly: true
						orphanSpanAsRootSpan: true
					) {
						edges {
							node {
								id
							}
						}
					}
				}
			}
		}
	}
`;

type PhoenixTraceLookupResponse = {
	data?: {
		project?: {
			trace?: {
				rootSpans?: {
					edges?: Array<{
						node?: {
							id?: string | null;
						} | null;
					}> | null;
				} | null;
			} | null;
		} | null;
	};
};

function getFallbackProjectUrl(projectId: string) {
	return `${PHOENIX_BASE_URL}/projects/${projectId}/traces`;
}

export async function GET(request: Request) {
	const { searchParams } = new URL(request.url);
	const traceId = searchParams.get("traceId")?.trim();
	const projectId = searchParams.get("projectId")?.trim();

	if (!traceId || !projectId) {
		return NextResponse.json(
			{ error: "traceId and projectId are required" },
			{ status: 400 },
		);
	}

	try {
		const response = await fetch(`${PHOENIX_BASE_URL}/graphql`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: PHOENIX_TRACE_LINK_QUERY,
				variables: {
					id: projectId,
					traceId,
				},
			}),
			cache: "no-store",
		});

		if (!response.ok) {
			return NextResponse.redirect(getFallbackProjectUrl(projectId), 307);
		}

		const payload = (await response
			.json()
			.catch(() => null)) as PhoenixTraceLookupResponse | null;
		const selectedSpanNodeId =
			payload?.data?.project?.trace?.rootSpans?.edges?.[0]?.node?.id ?? null;

		if (!selectedSpanNodeId) {
			return NextResponse.redirect(getFallbackProjectUrl(projectId), 307);
		}

		return NextResponse.redirect(
			getDirectPhoenixTraceUrl({
				projectId,
				traceId,
				selectedSpanNodeId,
			}),
			307,
		);
	} catch {
		return NextResponse.redirect(getFallbackProjectUrl(projectId), 307);
	}
}
