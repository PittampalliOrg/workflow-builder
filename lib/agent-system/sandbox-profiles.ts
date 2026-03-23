import { readFileSync } from "node:fs";
import path from "node:path";

export type SandboxBackend = "local" | "openshell";

export type SandboxProfile = {
	id: string;
	backend: SandboxBackend;
	declaredCapabilities: string[];
	sandboxImage: string | null;
};

type SandboxProfileCatalog = {
	version: number;
	profiles: Record<string, SandboxProfile>;
};

let cachedCatalog: SandboxProfileCatalog | null = null;

function normalizeCapabilities(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	return [
		...new Set(
			input
				.map((value) =>
					String(value || "")
						.trim()
						.toLowerCase(),
				)
				.filter(Boolean),
		),
	];
}

function catalogPath() {
	return path.join(process.cwd(), "config", "sandbox-profiles.json");
}

export function getSandboxProfileCatalog(): SandboxProfileCatalog {
	if (cachedCatalog) {
		return cachedCatalog;
	}
	const parsed = JSON.parse(readFileSync(catalogPath(), "utf-8")) as {
		version?: unknown;
		profiles?: Record<string, unknown>;
	};
	const profiles = Object.fromEntries(
		Object.entries(parsed.profiles ?? {}).map(([id, raw]) => {
			const record =
				raw && typeof raw === "object" && !Array.isArray(raw)
					? (raw as Record<string, unknown>)
					: {};
			const backend =
				record.backend === "openshell" || record.backend === "local"
					? record.backend
					: "local";
			return [
				id,
				{
					id,
					backend,
					declaredCapabilities: normalizeCapabilities(
						record.declaredCapabilities,
					),
					sandboxImage:
						typeof record.sandboxImage === "string" &&
						record.sandboxImage.trim()
							? record.sandboxImage.trim()
							: null,
				} satisfies SandboxProfile,
			];
		}),
	);
	cachedCatalog = {
		version:
			typeof parsed.version === "number" && Number.isFinite(parsed.version)
				? parsed.version
				: 1,
		profiles,
	};
	return cachedCatalog;
}

export function resolveSandboxProfile(
	profileRef: string | null | undefined,
): SandboxProfile | null {
	if (!profileRef) {
		return null;
	}
	return getSandboxProfileCatalog().profiles[profileRef] ?? null;
}
