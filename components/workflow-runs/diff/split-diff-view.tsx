"use client";

import { useMemo } from "react";
import type { DiffHunk, DiffLine } from "@/lib/diff/types";
import { SplitDiffLineRow } from "./diff-line";

interface SplitDiffViewProps {
	hunks: DiffHunk[];
	isLoading?: boolean;
}

interface SplitLinePair {
	oldLine: DiffLine | null;
	newLine: DiffLine | null;
	isHeader?: boolean;
}

function convertToSplitPairs(hunks: DiffHunk[]): SplitLinePair[] {
	const pairs: SplitLinePair[] = [];

	for (const hunk of hunks) {
		const pendingDeletions: DiffLine[] = [];
		const pendingAdditions: DiffLine[] = [];

		const flushPending = () => {
			const maxLen = Math.max(pendingDeletions.length, pendingAdditions.length);
			for (let idx = 0; idx < maxLen; idx += 1) {
				pairs.push({
					oldLine: pendingDeletions[idx] ?? null,
					newLine: pendingAdditions[idx] ?? null,
				});
			}
			pendingDeletions.length = 0;
			pendingAdditions.length = 0;
		};

		for (const line of hunk.lines) {
			if (line.type === "header") {
				flushPending();
				pairs.push({ oldLine: line, newLine: null, isHeader: true });
			} else if (line.type === "context") {
				flushPending();
				pairs.push({ oldLine: line, newLine: line });
			} else if (line.type === "deletion") {
				pendingDeletions.push(line);
			} else if (line.type === "addition") {
				pendingAdditions.push(line);
			}
		}

		flushPending();
	}

	return pairs;
}

export function SplitDiffView({ hunks, isLoading }: SplitDiffViewProps) {
	const splitPairs = useMemo(() => convertToSplitPairs(hunks), [hunks]);

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

	return (
		<div className="overflow-x-auto bg-[#0d1117]">
			<table className="w-full table-fixed border-collapse font-mono text-[13px] leading-[1.45] antialiased [font-feature-settings:'liga'_0,'calt'_1]">
				<colgroup>
					<col className="w-12" />
					<col className="w-1/2" />
					<col className="w-12" />
					<col className="w-1/2" />
				</colgroup>
				<tbody>
					{splitPairs.map((pair, index) => (
						<SplitDiffLineRow
							key={`split-${index}`}
							oldLine={pair.oldLine}
							newLine={pair.isHeader ? null : pair.newLine}
						/>
					))}
				</tbody>
			</table>
		</div>
	);
}
