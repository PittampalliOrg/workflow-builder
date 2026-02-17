import {
	createHighlighter,
	type BundledLanguage,
	type BundledTheme,
} from "shiki";
import type { DiffHunk, DiffLine } from "./types";

const EXTENSION_TO_LANGUAGE: Record<string, BundledLanguage> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	py: "python",
	nix: "nix",
	json: "json",
	md: "markdown",
	css: "css",
	scss: "scss",
	html: "html",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "kotlin",
	rb: "ruby",
	php: "php",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	sql: "sql",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	swift: "swift",
	vue: "vue",
	svelte: "svelte",
	xml: "xml",
	dockerfile: "dockerfile",
	graphql: "graphql",
	prisma: "prisma",
};

let highlighterPromise: ReturnType<typeof createHighlighter> | null = null;

function getHighlighter() {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({
			themes: ["github-light", "github-dark-default"],
			langs: Object.values(EXTENSION_TO_LANGUAGE),
		});
	}
	return highlighterPromise;
}

export function getLanguageFromPath(filePath: string): BundledLanguage | null {
	const fileName = filePath.split("/").pop() ?? "";
	const lowerFileName = fileName.toLowerCase();
	if (lowerFileName === "dockerfile") return "dockerfile";

	const ext = fileName.split(".").pop()?.toLowerCase();
	if (!ext) return null;
	return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

async function highlightLine(
	content: string,
	language: BundledLanguage,
	theme: BundledTheme,
): Promise<string> {
	try {
		const highlighter = await getHighlighter();
		const html = highlighter.codeToHtml(content, {
			lang: language,
			theme,
		});
		const match = html.match(/<code[^>]*>([\s\S]*)<\/code>/);
		if (match?.[1]) {
			return match[1].replace(/<span class="line">([\s\S]*)<\/span>/, "$1");
		}
		return content;
	} catch {
		return content;
	}
}

async function highlightDiffLines(
	lines: DiffLine[],
	language: BundledLanguage | null,
	theme: BundledTheme,
): Promise<DiffLine[]> {
	if (!language) {
		return lines;
	}

	return await Promise.all(
		lines.map(async (line) => {
			if (line.type === "header") {
				return line;
			}

			const highlightedHtml = await highlightLine(
				line.content,
				language,
				theme,
			);
			return {
				...line,
				highlightedHtml,
			};
		}),
	);
}

export async function highlightHunks(
	hunks: DiffHunk[],
	filePath: string,
	colorScheme: "light" | "dark",
): Promise<DiffHunk[]> {
	const language = getLanguageFromPath(filePath);
	if (!language) {
		return hunks;
	}

	const theme: BundledTheme =
		colorScheme === "dark" ? "github-dark-default" : "github-light";

	return await Promise.all(
		hunks.map(async (hunk) => ({
			...hunk,
			lines: await highlightDiffLines(hunk.lines, language, theme),
		})),
	);
}
