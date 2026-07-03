export const EMBED_CHROME_QUERY_PARAM = "wb_chrome";
export const EMBED_CHROME_UNIFIED = "unified";
export const EMBED_CHROME_NATIVE = "native";

export const DEFAULT_ARGOCD_URL = "https://argocd-hub.tail286401.ts.net";
export const DEFAULT_ARGOCD_EMBED_BASE = "/argocd";

export type EmbedChrome = typeof EMBED_CHROME_UNIFIED | typeof EMBED_CHROME_NATIVE;

function trimBase(base: string | null | undefined, fallback: string): string | null {
	const value = (base ?? fallback).trim().replace(/\/+$/, "");
	return value || null;
}

function trimEmbedBase(base: string | null | undefined, fallback: string): string {
	const value = (base ?? fallback).trim().replace(/\/+$/, "");
	return value || fallback;
}

function stripEmbedBase(pathname: string, embedBase: string): string {
	const normalizedBase = embedBase.replace(/\/+$/, "") || "/";
	if (normalizedBase === "/") return pathname || "/";
	if (pathname === normalizedBase) return "/";
	if (pathname.startsWith(`${normalizedBase}/`)) {
		return pathname.slice(normalizedBase.length) || "/";
	}
	return pathname || "/";
}

function sanitizedSearch(parsed: URL): string {
	parsed.searchParams.delete(EMBED_CHROME_QUERY_PARAM);
	const search = parsed.searchParams.toString();
	return search ? `?${search}` : "";
}

function sanitizedHash(hash: string): string {
	if (!hash.includes("?")) return hash;
	const [path, query] = hash.split("?", 2);
	const params = new URLSearchParams(query);
	params.delete(EMBED_CHROME_QUERY_PARAM);
	const search = params.toString();
	return search ? `${path}?${search}` : path;
}

function normalizedPathFromUrl(parsed: URL, embedBase: string): string {
	const pathname = stripEmbedBase(parsed.pathname || "/", embedBase);
	return `${pathname || "/"}${sanitizedSearch(parsed)}${sanitizedHash(parsed.hash)}`;
}

export function normalizeEmbeddedAppPath(input: {
	value: string | null | undefined;
	embedBase: string;
}): string {
	const raw = (input.value ?? "/").trim();
	if (!raw || raw.startsWith("//") || raw.includes("\\")) return "/";

	let parsed: URL;
	try {
		if (/^https?:\/\//i.test(raw)) {
			parsed = new URL(raw);
		} else if (raw.startsWith("/")) {
			parsed = new URL(raw, "http://workflow-builder.local");
		} else {
			return "/";
		}
	} catch {
		return "/";
	}

	return normalizedPathFromUrl(parsed, input.embedBase);
}

function appendPath(base: string, path: string): string {
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	if (normalizedPath === "/") return `${base}/`;
	return `${base}${normalizedPath}`;
}

export function embeddedAppSrc(input: {
	embedBase?: string | null;
	defaultEmbedBase: string;
	path: string | null | undefined;
}): string {
	const embedBase = trimEmbedBase(input.embedBase, input.defaultEmbedBase);
	const path = normalizeEmbeddedAppPath({ value: input.path, embedBase });
	return appendPath(embedBase, path);
}

export function externalAppUrl(input: {
	externalBase?: string | null;
	defaultExternalBase: string;
	embedBase: string;
	path: string | null | undefined;
}): string | null {
	const base = trimBase(input.externalBase, input.defaultExternalBase);
	if (!base) return null;
	const path = normalizeEmbeddedAppPath({ value: input.path, embedBase: input.embedBase });
	return appendPath(base, path);
}

export function withEmbeddedAppChrome(input: { src: string; chrome: EmbedChrome }): string {
	const parsed = new URL(input.src, "http://workflow-builder.local");
	parsed.searchParams.set(EMBED_CHROME_QUERY_PARAM, input.chrome);
	return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function embeddedWorkspaceAppUrl(input: {
	workspaceSlug: string | null | undefined;
	appRoute: "argocd";
	embedBase: string;
	path: string | null | undefined;
}): string | null {
	const workspaceSlug = input.workspaceSlug?.trim();
	if (!workspaceSlug) return null;
	const path = normalizeEmbeddedAppPath({ value: input.path, embedBase: input.embedBase });
	const params = new URLSearchParams({ path });
	return `/workspaces/${encodeURIComponent(workspaceSlug)}/${input.appRoute}?${params.toString()}`;
}

export function argocdEmbedSrc(input: {
	embedBase?: string | null;
	path: string | null | undefined;
}): string {
	return embeddedAppSrc({
		embedBase: input.embedBase,
		defaultEmbedBase: DEFAULT_ARGOCD_EMBED_BASE,
		path: input.path,
	});
}

export function argocdExternalUrl(input: {
	argocdBase?: string | null;
	embedBase?: string | null;
	path: string | null | undefined;
}): string | null {
	return externalAppUrl({
		externalBase: input.argocdBase,
		defaultExternalBase: DEFAULT_ARGOCD_URL,
		embedBase: input.embedBase ?? DEFAULT_ARGOCD_EMBED_BASE,
		path: input.path,
	});
}
