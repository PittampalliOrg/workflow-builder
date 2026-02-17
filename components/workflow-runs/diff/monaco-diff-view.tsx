"use client";

import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { useTheme } from "next-themes";
import { useMemo } from "react";
import { vercelDarkTheme } from "@/lib/monaco-theme";

type MonacoDiffViewProps = {
	original: string;
	modified: string;
	language?: string;
	splitView: boolean;
	height?: number | string;
};

export function MonacoDiffView({
	original,
	modified,
	language = "plaintext",
	splitView,
	height = "560px",
}: MonacoDiffViewProps) {
	const { resolvedTheme } = useTheme();
	const isDark = resolvedTheme === "dark";

	const handleEditorMount: DiffOnMount = (_, monaco) => {
		monaco.editor.defineTheme("vercel-dark", vercelDarkTheme);
		monaco.editor.setTheme(isDark ? "vercel-dark" : "light");
	};

	const options = useMemo(
		() => ({
			automaticLayout: true,
			codeLens: false,
			diffCodeLens: false,
			fontLigatures: true,
			fontSize: 13,
			hideUnchangedRegions: {
				enabled: false,
			},
			lineNumbers: "on" as const,
			minimap: { enabled: false },
			readOnly: true,
			renderOverviewRuler: false,
			renderSideBySide: splitView,
			scrollBeyondLastLine: false,
			wordWrap: "off" as const,
		}),
		[splitView],
	);

	return (
		<DiffEditor
			height={height}
			language={language}
			modified={modified}
			onMount={handleEditorMount}
			options={options}
			original={original}
			theme={isDark ? "vercel-dark" : "light"}
		/>
	);
}
