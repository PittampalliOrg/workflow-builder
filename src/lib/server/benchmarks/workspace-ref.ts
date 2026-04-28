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
	const base = `${normalizedPrefix}-${slug || "run"}`;
	const maxBaseLength = Math.max(1, 63 - digest.length - 1);
	const trimmedBase = base.slice(0, maxBaseLength).replace(/-+$/g, "") || normalizedPrefix;
	return `${trimmedBase}-${digest}`;
}

function normalizePart(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
