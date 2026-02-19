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
	secretNames: readonly string[];
};

const RUNTIME_SECRET_MAPPINGS: RuntimeSecretMapping[] = [
	{
		envVar: "ANTHROPIC_API_KEY",
		secretNames: ["ANTHROPIC-API-KEY", "ANTHROPIC_API_KEY"],
	},
];

function hasValue(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function buildSecretUrl(secretName: string): string {
	const encodedName = encodeURIComponent(secretName);
	return `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/secrets/${DAPR_SECRET_STORE}/${encodedName}`;
}

async function fetchSecretValue(
	secretName: string,
): Promise<string | undefined> {
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
			console.warn(
				`[durable-agent] Dapr secret fetch failed: store=${DAPR_SECRET_STORE} key=${secretName} status=${response.status} body=${body}`,
			);
			return undefined;
		}

		const payload = (await response.json()) as Record<string, unknown>;
		const directValue = payload[secretName];
		if (typeof directValue === "string" && directValue.trim()) {
			return directValue.trim();
		}

		// Some secret stores may return a single key/value with a transformed key.
		for (const value of Object.values(payload)) {
			if (typeof value === "string" && value.trim()) {
				return value.trim();
			}
		}
		return undefined;
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
	secretNames: readonly string[],
): Promise<{ secretName: string; value: string } | undefined> {
	for (const secretName of secretNames) {
		const value = await fetchSecretValue(secretName);
		if (hasValue(value)) {
			return { secretName, value };
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

		const resolved = await resolveSecretValue(mapping.secretNames);
		if (!resolved) {
			console.warn(
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
