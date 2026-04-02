"use client";

import { useTheme } from "next-themes";
import { PrismAsyncLight as SyntaxHighlighter } from "react-syntax-highlighter";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { cn } from "@/lib/utils";

SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("markdown", markdown);
SyntaxHighlighter.registerLanguage("yaml", yaml);
SyntaxHighlighter.registerLanguage("yml", yaml);

type CodeBlockLanguage = "json" | "yaml" | "yml" | "markdown" | "text";

type CodeBlockProps = {
	code: string;
	language?: CodeBlockLanguage;
	className?: string;
	maxHeightClassName?: string;
};

export function CodeBlock({
	code,
	language = "text",
	className,
	maxHeightClassName,
}: CodeBlockProps) {
	const { resolvedTheme } = useTheme();
	const style = resolvedTheme === "dark" ? oneDark : oneLight;

	return (
		<div
			className={cn(
				"overflow-auto rounded-lg border bg-muted/40",
				maxHeightClassName,
				className,
			)}
		>
			<SyntaxHighlighter
				className="!m-0 !bg-transparent"
				codeTagProps={{
					className: "font-mono text-xs leading-relaxed",
				}}
				customStyle={{
					margin: 0,
					padding: "0.75rem",
					background: "transparent",
					fontSize: "0.75rem",
					lineHeight: 1.6,
				}}
				language={language === "text" ? undefined : language}
				showLineNumbers={false}
				style={style}
				wrapLongLines
			>
				{code}
			</SyntaxHighlighter>
		</div>
	);
}
