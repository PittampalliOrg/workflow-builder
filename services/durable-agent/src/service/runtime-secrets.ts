const DAPR_HOST = process.env.DAPR_HOST ?? "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT ?? "3500";
const DAPR_SECRET_STORE =
	process.env.DAPR_SECRET_STORE ??
	process.env.DAPR_SECRETS_STORE ??
	"azure-keyvault";

const SECRET_REQUEST_TIMEOUT_MS = Math.max(
	500,
	parseInt(process.env.DAPR_SECRET_TIMEOUT_MS || "3000", 10),
);

type RuntimeSecretMapping = {
	envVar: "ANTHROPIC_API_KEY";
	providers: readonly string[];
	sources: readonly RuntimeSecretSource[];
};

type RuntimeSecretSource = {
	secretName: string;
	valueKeys?: readonly string[];
};

const RUNTIME_SECRET_MAPPINGS: RuntimeSecretMapping[] = [
	{
		envVar: "ANTHROPIC_API_KEY",
		providers: ["anthropic"],
		sources: [
			{ secretName: "workflow-builder-secrets", valueKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC-API-KEY"] },
			{ secretName: "ANTHROPIC-API-KEY" },
			{ secretName: "ANTHROPIC_API_KEY" },
		],
	},
];

function hasValue(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function buildSecretUrl(secretName: string): string {
	const encodedName = encodeURIComponent(secretName);
	return `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/secrets/${DAPR_SECRET_STORE}/${encodedName}`;
}

async function fetchSecretPayload(
	secretName: string,
): Promise<Record<string, unknown> | undefined> {
	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		SECRET_REQUEST_TIMEOUT_MS,
	);
	try {
		const response = await fetch(buildSecretUrl(secretName), {
			method: "GET",
			signal: controller.signal,
		});
		if (!response.ok) {
			const body = (await response.text()).slice(0, 240);
			const normalizedBody = body.toLowerCase();
			const isOptionalMiss =
				response.status === 403 ||
				response.status === 404 ||
				normalizedBody.includes("not found") ||
				normalizedBody.includes("forbidden");
			const log = isOptionalMiss ? console.info : console.warn;
			log(
				isOptionalMiss
					? `[durable-agent] Optional Dapr secret unavailable: store=${DAPR_SECRET_STORE} key=${secretName} status=${response.status} body=${body}`
					: `[durable-agent] Dapr secret fetch failed: store=${DAPR_SECRET_STORE} key=${secretName} status=${response.status} body=${body}`,
			);
			return undefined;
		}

		return (await response.json()) as Record<string, unknown>;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(
			`[durable-agent] Dapr secret fetch error: store=${DAPR_SECRET_STORE} key=${secretName} error=${message}`,
		);
		return undefined;
	} finally {
		clearTimeout(timeoutId);
	}
}

async function resolveSecretValue(
	sources: readonly RuntimeSecretSource[],
): Promise<{ secretName: string; value: string } | undefined> {
	for (const source of sources) {
		const payload = await fetchSecretPayload(source.secretName);
		if (!payload) {
			continue;
		}

		if (source.valueKeys?.length) {
			for (const key of source.valueKeys) {
				const value = payload[key];
				if (typeof value === "string" && value.trim()) {
					return { secretName: `${source.secretName}:${key}`, value: value.trim() };
				}
			}
			continue;
		}

		const directValue = payload[source.secretName];
		if (typeof directValue === "string" && directValue.trim()) {
			return { secretName: source.secretName, value: directValue.trim() };
		}

		// Some secret stores may return a single key/value with a transformed key.
		for (const value of Object.values(payload)) {
			if (typeof value === "string" && value.trim()) {
				return { secretName: source.secretName, value: value.trim() };
			}
		}
	}
	return undefined;
}

/**
 * Populate runtime-only secrets from Dapr secret store so model routing can
 * use provider-specific API keys without requiring direct Kubernetes env vars.
 */
export async function hydrateRuntimeSecretsFromDapr(): Promise<void> {
	for (const mapping of RUNTIME_SECRET_MAPPINGS) {
		if (hasValue(process.env[mapping.envVar])) {
			continue;
		}

		const resolved = await resolveSecretValue(mapping.sources);
		if (!resolved) {
			console.info(
				`[durable-agent] Secret ${mapping.envVar} not found in Dapr store ${DAPR_SECRET_STORE}`,
			);
			continue;
		}

		process.env[mapping.envVar] = resolved.value;
		console.log(
			`[durable-agent] Loaded ${mapping.envVar} from Dapr secret ${resolved.secretName}`,
		);
	}
}

export async function hydrateRuntimeSecretsForModelSpecs(
	modelSpecs: readonly (string | undefined | null)[],
): Promise<void> {
	const requiredProviders = new Set<string>();
	for (const modelSpec of modelSpecs) {
		const normalized = String(modelSpec || "").trim().toLowerCase();
		if (!normalized.includes("/")) {
			continue;
		}
		requiredProviders.add(normalized.split("/", 1)[0] || "");
	}

	if (requiredProviders.size === 0) {
		return;
	}

	for (const mapping of RUNTIME_SECRET_MAPPINGS) {
		if (hasValue(process.env[mapping.envVar])) {
			continue;
		}
		if (!mapping.providers.some((provider) => requiredProviders.has(provider))) {
			continue;
		}

		const resolved = await resolveSecretValue(mapping.sources);
		if (!resolved) {
			console.info(
				`[durable-agent] Secret ${mapping.envVar} not found in Dapr store ${DAPR_SECRET_STORE}`,
			);
			continue;
		}

		process.env[mapping.envVar] = resolved.value;
		console.log(
			`[durable-agent] Loaded ${mapping.envVar} from Dapr secret ${resolved.secretName}`,
		);
	}
}
