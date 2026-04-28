import { createHash } from "node:crypto";

export function buildStableWorkspaceRef(
	prefix: string,
	parts: Array<string | number | null | undefined>,
): string {
	const raw =
		parts
			.map((part) => (part == null ? "" : String(part).trim()))
			.filter(Boolean)
			.join("-") || prefix;
	const normalizedPrefix = normalizePart(prefix) || "workspace";
	const slug = normalizePart(raw);
	const digest = createHash("sha256").update(raw).digest("hex").slice(0, 10);
	const maxPrefixLength = Math.max(1, 63 - digest.length - 1);
	const trimmedPrefix =
		normalizedPrefix.slice(0, maxPrefixLength).replace(/-+$/g, "") || "workspace";
	const hashPrefix = `${trimmedPrefix}-${digest}`;
	const remaining = 63 - hashPrefix.length - 1;
	if (remaining <= 0) return hashPrefix;
	const trimmedSlug = (slug || "run").slice(0, remaining).replace(/-+$/g, "");
	return trimmedSlug ? `${hashPrefix}-${trimmedSlug}` : hashPrefix;
}

function normalizePart(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
