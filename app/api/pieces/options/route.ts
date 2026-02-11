import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { resolveConnectionValueForUse } from "@/lib/app-connections/resolve-connection-value";
import { getSession } from "@/lib/auth-helpers";
import { getAppConnectionByExternalId } from "@/lib/db/app-connections";

type RegistryEntry = { appId?: string; type?: string };
type FunctionRegistry = Record<string, RegistryEntry>;

const REGISTRY_FILE_PATH =
	process.env.REGISTRY_FILE_PATH || "/config/functions.json";
const DEFAULT_NAMESPACE = process.env.FUNCTIONS_NAMESPACE || "workflow-builder";
const DEFAULT_APP_IDS = ["fn-activepieces", "fn-activepieces-standalone"];
const OPTIONS_REQUEST_TIMEOUT_MS = Number.parseInt(
	process.env.PIECES_OPTIONS_TIMEOUT_MS || "25000",
	10,
);

function normalizePieceName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/^@activepieces\/piece-/, "")
		.replace(/[_\s]+/g, "-")
		.replace(/-+/g, "-");
}

function dedupe(values: string[]): string[] {
	return Array.from(new Set(values.filter(Boolean)));
}

function getAppIdsFromRegistry(registry: FunctionRegistry): string[] {
	const appIds: string[] = [];

	if (registry._default?.appId) {
		appIds.push(registry._default.appId);
	}

	for (const [slug, entry] of Object.entries(registry)) {
		if (!entry?.appId) continue;
		if (entry.appId.includes("activepieces") || slug.includes("activepieces")) {
			appIds.push(entry.appId);
		}
	}

	return dedupe(appIds);
}

async function getRegistryAppIds(): Promise<string[]> {
	const ids: string[] = [];

	if (process.env.FUNCTION_REGISTRY) {
		try {
			const parsed = JSON.parse(
				process.env.FUNCTION_REGISTRY,
			) as FunctionRegistry;
			ids.push(...getAppIdsFromRegistry(parsed));
		} catch {
			// Ignore malformed FUNCTION_REGISTRY env.
		}
	}

	if (existsSync(REGISTRY_FILE_PATH)) {
		try {
			const content = await readFile(REGISTRY_FILE_PATH, "utf-8");
			const parsed = JSON.parse(content) as FunctionRegistry;
			ids.push(...getAppIdsFromRegistry(parsed));
		} catch {
			// Ignore unreadable/invalid registry file.
		}
	}

	return dedupe(ids);
}

async function getFnActivepiecesUrls(): Promise<string[]> {
	const envUrl = process.env.FN_ACTIVEPIECES_URL?.trim();
	const envAppIds = (process.env.FN_ACTIVEPIECES_APP_ID || "")
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
	const registryAppIds = await getRegistryAppIds();

	const appIds = dedupe([
		...envAppIds,
		...registryAppIds,
		...DEFAULT_APP_IDS,
	]).filter((id) => id.includes("activepieces"));

	const namespaces = dedupe([DEFAULT_NAMESPACE, "workflow-builder", "default"]);

	const derivedUrls = appIds.flatMap((appId) =>
		namespaces.map(
			(namespace) => `http://${appId}.${namespace}.svc.cluster.local`,
		),
	);

	return dedupe([envUrl || "", ...derivedUrls]);
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeoutId);
	}
}

type OptionsRequestBody = {
	pieceName: string;
	actionName: string;
	propertyName: string;
	connectionExternalId?: string;
	input?: Record<string, unknown>;
	searchValue?: string;
};

function isValidBody(value: unknown): value is OptionsRequestBody {
	if (typeof value !== "object" || value === null) {
		return false;
	}
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
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const rawBody = await request.json();
		if (!isValidBody(rawBody)) {
			return NextResponse.json(
				{
					error:
						"Invalid request body. Required: pieceName, actionName, propertyName",
				},
				{ status: 400 },
			);
		}

		// Resolve auth if connectionExternalId is provided
		let authValue: unknown;
		if (rawBody.connectionExternalId) {
			const connection = await getAppConnectionByExternalId(
				rawBody.connectionExternalId,
				session.user.id,
			);
			if (!connection) {
				return NextResponse.json(
					{ error: "Connection not found" },
					{ status: 404 },
				);
			}

			authValue = await resolveConnectionValueForUse(connection);
		}

		const urls = await getFnActivepiecesUrls();
		const requestBody = {
			pieceName: normalizePieceName(rawBody.pieceName),
			actionName: rawBody.actionName,
			propertyName: rawBody.propertyName,
			auth: authValue,
			input: rawBody.input || {},
			searchValue: rawBody.searchValue,
		};

		let lastError: string | null = null;
		for (const baseUrl of urls) {
			try {
				const fnResponse = await fetchWithTimeout(
					`${baseUrl}/options`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(requestBody),
					},
					OPTIONS_REQUEST_TIMEOUT_MS,
				);

				if (fnResponse.ok) {
					const data = await fnResponse.json();
					return NextResponse.json(data);
				}

				const errorText = await fnResponse.text();
				lastError =
					errorText || `HTTP ${fnResponse.status} from ${baseUrl}/options`;

				// A reachable fn-activepieces endpoint responded; return its business
				// error directly instead of masking it with fallback URL retries.
				return NextResponse.json(
					{
						error: "Failed to fetch options from fn-activepieces",
						details: lastError,
					},
					{ status: fnResponse.status },
				);
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					lastError = `Timed out after ${OPTIONS_REQUEST_TIMEOUT_MS}ms calling ${baseUrl}/options`;
					continue;
				}
				lastError = error instanceof Error ? error.message : String(error);
			}
		}

		const timedOut = lastError?.includes("Timed out after") ?? false;
		return NextResponse.json(
			{
				error: timedOut
					? "Options request to fn-activepieces timed out"
					: "Failed to fetch options from fn-activepieces",
				details: lastError || "All fn-activepieces endpoints failed",
			},
			{ status: timedOut ? 504 : 502 },
		);
	} catch (error) {
		console.error("[pieces/options] Error:", error);
		return NextResponse.json(
			{
				error: "Failed to fetch dropdown options",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}
