import type { EnvironmentConfig } from "$lib/types/environments";

export type SandboxImageSource = "stored" | "translated" | "unconfigured";

export type SandboxImageResolution = {
	imageTag: string | null;
	imageSource: SandboxImageSource;
	imageResolutionWarning?: string;
};

type ResolveSandboxImageInput = {
	environmentName?: string | null;
	envSlug: string;
	config: EnvironmentConfig;
	storedImageTag: string | null;
	templateResolution?: SandboxImageResolution | null;
	translatedImageMap?: Record<string, string>;
};

const SPOKE_ENVIRONMENTS = new Set(["dev", "staging"]);
const GITEA_RYZEN_SANDBOX_PREFIX =
	"gitea-ryzen.tail286401.ts.net/giteaadmin/openshell-sandbox";

export function inferWorkflowBuilderEnvironmentName(
	env: Record<string, string | undefined> = process.env,
): string {
	const explicit = readFirstEnv(
		env,
		"WORKFLOW_BUILDER_ENV",
		"CLUSTER_NAME",
		"PUBLIC_CLUSTER_NAME",
	);
	if (explicit) return explicit;

	const appUrl =
		readFirstEnv(env, "APP_PUBLIC_URL", "APP_URL", "ORIGIN", "NEXT_PUBLIC_APP_URL") ??
		"";
	for (const name of ["dev", "staging", "ryzen", "hub"]) {
		if (appUrl.includes(`workflow-builder-${name}`) || appUrl.includes(`${name}.`)) {
			return name;
		}
	}
	return "unknown";
}

export function loadSandboxTemplateImageMap(
	env: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const raw = env.SANDBOX_TEMPLATE_IMAGES_JSON?.trim();
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			const normalizedKey = normalizeSandboxImageKey(key);
			const normalizedValue = typeof value === "string" ? value.trim() : "";
			if (normalizedKey && normalizedValue) out[normalizedKey] = normalizedValue;
		}
		return out;
	} catch {
		return {};
	}
}

export function resolveSandboxImage(
	input: ResolveSandboxImageInput,
): SandboxImageResolution {
	const environmentName = normalizeEnvironmentName(input.environmentName);
	const translatedImageMap = input.translatedImageMap ?? {};
	const templateKeys = sandboxImageKeysForEnvironment(input.envSlug, input.config);
	const directTranslatedImage =
		translatedImageMap[normalizeSandboxImageKey(input.envSlug)]?.trim() || null;
	const translatedImage = findMappedSandboxImage(templateKeys, translatedImageMap);
	const storedImageTag = normalizeImageTag(input.storedImageTag);
	const templateResolution = input.templateResolution ?? null;

	if (isSpokeEnvironment(environmentName) && directTranslatedImage) {
		return {
			imageTag: directTranslatedImage,
			imageSource: "translated",
		};
	}

	if (storedImageTag) {
		return resolveConcreteImage({
			environmentName,
			imageTag: storedImageTag,
			templateKeys,
			translatedImage,
		});
	}

	if (templateResolution?.imageTag) {
		return resolveConcreteImage({
			environmentName,
			imageTag: templateResolution.imageTag,
			templateKeys,
			translatedImage,
			fallbackSource: templateResolution.imageSource,
			fallbackWarning: templateResolution.imageResolutionWarning,
		});
	}

	if (translatedImage) {
		return {
			imageTag: translatedImage,
			imageSource: isSpokeEnvironment(environmentName) ? "translated" : "stored",
		};
	}

	if (isSpokeEnvironment(environmentName) && templateKeys.length > 0) {
		const template = templateKeys[0];
		return {
			imageTag: null,
			imageSource: "unconfigured",
			imageResolutionWarning: `No spoke image configured for sandbox template "${template}" in ${environmentName}.`,
		};
	}

	return { imageTag: null, imageSource: "unconfigured" };
}

export function isRyzenLocalSandboxImage(imageTag: string | null | undefined): boolean {
	const normalized = normalizeImageTag(imageTag);
	return Boolean(
		normalized && normalized.startsWith(GITEA_RYZEN_SANDBOX_PREFIX),
	);
}

function resolveConcreteImage(input: {
	environmentName: string;
	imageTag: string;
	templateKeys: string[];
	translatedImage: string | null;
	fallbackSource?: SandboxImageSource;
	fallbackWarning?: string;
}): SandboxImageResolution {
	if (!isSpokeEnvironment(input.environmentName)) {
		return {
			imageTag: input.imageTag,
			imageSource: input.fallbackSource ?? "stored",
			...(input.fallbackWarning
				? { imageResolutionWarning: input.fallbackWarning }
				: {}),
		};
	}

	if (!isRyzenLocalSandboxImage(input.imageTag)) {
		return {
			imageTag: input.imageTag,
			imageSource: input.fallbackSource ?? "stored",
			...(input.fallbackWarning
				? { imageResolutionWarning: input.fallbackWarning }
				: {}),
		};
	}

	if (input.translatedImage) {
		return {
			imageTag: input.translatedImage,
			imageSource: "translated",
		};
	}

	const template = input.templateKeys[0] ?? "unknown";
	return {
		imageTag: null,
		imageSource: "unconfigured",
		imageResolutionWarning:
			`No spoke image configured for sandbox template "${template}" in ${input.environmentName}. ` +
			`Stored image "${input.imageTag}" is ryzen-local and cannot be used there.`,
	};
}

function findMappedSandboxImage(
	keys: string[],
	translatedImageMap: Record<string, string>,
): string | null {
	for (const key of keys) {
		const match = translatedImageMap[key];
		if (typeof match === "string" && match.trim()) return match.trim();
	}
	return null;
}

function sandboxImageKeysForEnvironment(
	envSlug: string,
	config: EnvironmentConfig,
): string[] {
	const out = new Set<string>();
	for (const raw of [envSlug, config.sandboxTemplate]) {
		const key = normalizeSandboxImageKey(raw);
		if (!key) continue;
		out.add(key);
		if (key === "dapr-agent-xlsx") out.add("xlsx");
		if (key === "xlsx") out.add("dapr-agent-xlsx");
		if (key === "default-sandbox") out.add("dapr-agent");
	}
	return Array.from(out);
}

function normalizeSandboxImageKey(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeEnvironmentName(value: string | null | undefined): string {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized || "unknown";
}

function normalizeImageTag(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized || null;
}

function isSpokeEnvironment(name: string): boolean {
	return SPOKE_ENVIRONMENTS.has(name);
}

function readFirstEnv(
	env: Record<string, string | undefined>,
	...names: string[]
): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}
