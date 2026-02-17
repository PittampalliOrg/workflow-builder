"use client";

import type { DiffLine } from "@/lib/diff/types";
import { cn } from "@/lib/utils";

interface DiffLineRowProps {
	line: DiffLine;
	showOldLineNum?: boolean;
	showNewLineNum?: boolean;
}

export function DiffLineRow({
	line,
	showOldLineNum = true,
	showNewLineNum = true,
}: DiffLineRowProps) {
	if (line.type === "header") {
		return (
			<tr className="border-b border-blue-900/40 bg-blue-950/40">
				<td
					colSpan={3}
					className="px-4 py-1.5 font-mono text-[11px] text-blue-300"
				>
					{line.content}
				</td>
			</tr>
		);
	}

	const bgClass = {
		context: "bg-[#0d1117]",
		addition: "bg-emerald-950/50",
		deletion: "bg-rose-950/40",
	}[line.type];

	const textClass = {
		context: "text-zinc-300",
		addition: "text-emerald-200",
		deletion: "text-rose-200",
	}[line.type];

	const lineNumClass = {
		context: "text-zinc-600",
		addition: "text-emerald-700",
		deletion: "text-rose-700",
	}[line.type];

	const prefix = {
		context: " ",
		addition: "+",
		deletion: "-",
	}[line.type];

	const prefixClass = {
		context: "text-zinc-600",
		addition: "text-emerald-500",
		deletion: "text-rose-500",
	}[line.type];

	return (
		<tr
			className={cn(
				bgClass,
				"border-b border-zinc-900 transition-all hover:brightness-110",
			)}
		>
			{showOldLineNum ? (
				<td
					className={cn(
						"w-12 select-none border-r border-zinc-800 px-2 py-0 text-right font-mono text-[12px] tabular-nums",
						lineNumClass,
					)}
				>
					{line.oldLineNum ?? ""}
				</td>
			) : null}
			{showNewLineNum ? (
				<td
					className={cn(
						"w-12 select-none border-r border-zinc-800 px-2 py-0 text-right font-mono text-[12px] tabular-nums",
						lineNumClass,
					)}
				>
					{line.newLineNum ?? ""}
				</td>
			) : null}
			<td
				className={cn(
					"px-3 py-0 font-mono text-[13px] leading-6 whitespace-pre antialiased [font-feature-settings:'liga'_0,'calt'_1]",
					textClass,
				)}
			>
				<span className={cn("mr-2 select-none font-medium", prefixClass)}>
					{prefix}
				</span>
				{line.highlightedHtml ? (
					<span
						className="[&_span]:tracking-tight"
						// biome-ignore lint/security/noDangerouslySetInnerHtml: syntax highlighter output
						dangerouslySetInnerHTML={{ __html: line.highlightedHtml }}
					/>
				) : (
					<span className="tracking-tight">{line.content}</span>
				)}
			</td>
		</tr>
	);
}

interface SplitDiffLineRowProps {
	oldLine: DiffLine | null;
	newLine: DiffLine | null;
}

export function SplitDiffLineRow({ oldLine, newLine }: SplitDiffLineRowProps) {
	if (oldLine?.type === "header" || newLine?.type === "header") {
		const headerLine = oldLine || newLine;
		return (
			<tr className="border-b border-blue-900/40 bg-blue-950/40">
				<td
					colSpan={4}
					className="px-4 py-1.5 font-mono text-[11px] text-blue-300"
				>
					{headerLine?.content ?? ""}
				</td>
			</tr>
		);
	}

	const getBgClass = (line: DiffLine | null) => {
		if (!line) return "bg-[#0d1117]/50";
		return {
			context: "bg-[#0d1117]",
			addition: "bg-emerald-950/50",
			deletion: "bg-rose-950/40",
			header: "bg-blue-950/40",
		}[line.type];
	};

	const getTextClass = (line: DiffLine | null) => {
		if (!line) return "text-zinc-700";
		return {
			context: "text-zinc-300",
			addition: "text-emerald-200",
			deletion: "text-rose-200",
			header: "text-blue-300",
		}[line.type];
	};

	const getLineNumClass = (line: DiffLine | null) => {
		if (!line) return "text-zinc-700";
		return {
			context: "text-zinc-600",
			addition: "text-emerald-700",
			deletion: "text-rose-700",
			header: "text-blue-500",
		}[line.type];
	};

	const getPrefix = (line: DiffLine | null) => {
		if (!line) return " ";
		return {
			context: " ",
			addition: "+",
			deletion: "-",
			header: "@@",
		}[line.type];
	};

	const getPrefixClass = (line: DiffLine | null) => {
		if (!line) return "text-zinc-700";
		return {
			context: "text-zinc-600",
			addition: "text-emerald-500",
			deletion: "text-rose-500",
			header: "text-blue-300",
		}[line.type];
	};

	const renderContent = (line: DiffLine | null) => {
		if (!line) return null;
		if (line.highlightedHtml) {
			return (
				<span
					className="[&_span]:tracking-tight"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: syntax highlighter output
					dangerouslySetInnerHTML={{ __html: line.highlightedHtml }}
				/>
			);
		}
		return <span className="tracking-tight">{line.content}</span>;
	};

	return (
		<tr className="border-b border-zinc-900 transition-all hover:brightness-110">
			<td
				className={cn(
					"w-12 select-none border-r border-zinc-800 px-2 py-0 text-right font-mono text-[12px] tabular-nums",
					getBgClass(oldLine),
					getLineNumClass(oldLine),
				)}
			>
				{oldLine?.oldLineNum ?? ""}
			</td>
			<td
				className={cn(
					"border-r border-zinc-700/50 px-3 py-0 font-mono text-[13px] leading-6 whitespace-pre antialiased [font-feature-settings:'liga'_0,'calt'_1]",
					getBgClass(oldLine),
					getTextClass(oldLine),
				)}
			>
				{oldLine ? (
					<>
						<span
							className={cn(
								"mr-2 select-none font-medium",
								getPrefixClass(oldLine),
							)}
						>
							{getPrefix(oldLine)}
						</span>
						{renderContent(oldLine)}
					</>
				) : null}
			</td>

			<td
				className={cn(
					"w-12 select-none border-r border-zinc-800 px-2 py-0 text-right font-mono text-[12px] tabular-nums",
					getBgClass(newLine),
					getLineNumClass(newLine),
				)}
			>
				{newLine?.newLineNum ?? ""}
			</td>
			<td
				className={cn(
					"px-3 py-0 font-mono text-[13px] leading-6 whitespace-pre antialiased [font-feature-settings:'liga'_0,'calt'_1]",
					getBgClass(newLine),
					getTextClass(newLine),
				)}
			>
				{newLine ? (
					<>
						<span
							className={cn(
								"mr-2 select-none font-medium",
								getPrefixClass(newLine),
							)}
						>
							{getPrefix(newLine)}
						</span>
						{renderContent(newLine)}
					</>
				) : null}
			</td>
		</tr>
	);
}
