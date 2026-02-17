"use client";

import type { DiffHunk, DiffLine } from "@/lib/diff/types";
import { DiffLineRow } from "./diff-line";

interface UnifiedDiffViewProps {
	hunks: DiffHunk[];
	isLoading?: boolean;
}

export function UnifiedDiffView({ hunks, isLoading }: UnifiedDiffViewProps) {
	if (isLoading) {
		return (
			<div className="bg-[#0d1117] p-6 text-center text-sm text-zinc-500">
				Loading diff...
			</div>
		);
	}

	if (hunks.length === 0) {
		return (
			<div className="bg-[#0d1117] p-6 text-center text-sm text-zinc-500">
				No changes
			</div>
		);
	}

	const allLines: DiffLine[] = hunks.flatMap((hunk) => hunk.lines);

	return (
		<div className="overflow-x-auto bg-[#0d1117]">
			<table className="w-full border-collapse font-mono text-[13px] leading-[1.45] antialiased [font-feature-settings:'liga'_0,'calt'_1]">
				<colgroup>
					<col className="w-12" />
					<col className="w-12" />
					<col />
				</colgroup>
				<tbody>
					{allLines.map((line, index) => (
						<DiffLineRow
							key={`${line.type}-${line.oldLineNum ?? "n"}-${line.newLineNum ?? "n"}-${index}`}
							line={line}
						/>
					))}
				</tbody>
			</table>
		</div>
	);
}
