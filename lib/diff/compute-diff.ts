import {
	DIFF_DELETE,
	DIFF_EQUAL,
	DIFF_INSERT,
	diff_match_patch,
} from "diff-match-patch";
import type { DiffContentMode, DiffHunk, DiffLine, DiffResult } from "./types";

const CONTEXT_LINES = 3;

function linesToChars(
	oldLines: string[],
	newLines: string[],
): { chars1: string; chars2: string; lineArray: string[] } {
	const lineArray: string[] = [];
	const lineHash: Record<string, number> = {};

	function linesToCharsMunge(lines: string[]): string {
		let chars = "";
		for (const line of lines) {
			if (line in lineHash) {
				chars += String.fromCharCode(lineHash[line]);
			} else {
				lineHash[line] = lineArray.length;
				lineArray.push(line);
				chars += String.fromCharCode(lineArray.length - 1);
			}
		}
		return chars;
	}

	const chars1 = linesToCharsMunge(oldLines);
	const chars2 = linesToCharsMunge(newLines);

	return { chars1, chars2, lineArray };
}

function charsToLines(
	diffs: [number, string][],
	lineArray: string[],
): [number, string[]][] {
	return diffs.map(([op, chars]) => {
		const lines: string[] = [];
		for (let i = 0; i < chars.length; i += 1) {
			lines.push(lineArray[chars.charCodeAt(i)]);
		}
		return [op, lines];
	});
}

function generateHunks(
	lineDiffs: [number, string[]][],
	contentMode: DiffContentMode,
): DiffHunk[] {
	const allLines: { op: number; content: string }[] = [];

	for (const [op, lines] of lineDiffs) {
		for (const line of lines) {
			allLines.push({ op, content: line });
		}
	}

	if (allLines.length === 0) {
		return [];
	}

	const hunks: DiffHunk[] = [];
	let oldLineNum = 1;
	let newLineNum = 1;

	const changeIndices = new Set<number>();
	allLines.forEach((item, idx) => {
		if (item.op !== DIFF_EQUAL) {
			changeIndices.add(idx);
		}
	});

	const visibleIndices = new Set<number>();
	if (contentMode === "incremental") {
		changeIndices.forEach((idx) => {
			for (
				let i = Math.max(0, idx - CONTEXT_LINES);
				i <= Math.min(allLines.length - 1, idx + CONTEXT_LINES);
				i += 1
			) {
				visibleIndices.add(i);
			}
		});
	} else {
		allLines.forEach((_, idx) => visibleIndices.add(idx));
	}

	let hunkOldStart = 0;
	let hunkNewStart = 0;
	let hunkOldLines = 0;
	let hunkNewLines = 0;
	let hunkDiffLines: DiffLine[] = [];

	for (const [idx, item] of allLines.entries()) {
		const isVisible = visibleIndices.has(idx);
		if (!isVisible) {
			if (hunkDiffLines.length > 0) {
				hunks.push({
					oldStart: hunkOldStart,
					oldLines: hunkOldLines,
					newStart: hunkNewStart,
					newLines: hunkNewLines,
					lines: [
						{
							type: "header",
							content: `@@ -${hunkOldStart},${hunkOldLines} +${hunkNewStart},${hunkNewLines} @@`,
							oldLineNum: null,
							newLineNum: null,
						},
						...hunkDiffLines,
					],
				});
				hunkDiffLines = [];
				hunkOldLines = 0;
				hunkNewLines = 0;
			}

			if (item.op === DIFF_EQUAL || item.op === DIFF_DELETE) {
				oldLineNum += 1;
			}
			if (item.op === DIFF_EQUAL || item.op === DIFF_INSERT) {
				newLineNum += 1;
			}
			continue;
		}

		if (hunkDiffLines.length === 0) {
			hunkOldStart = oldLineNum;
			hunkNewStart = newLineNum;
		}

		let line: DiffLine;
		if (item.op === DIFF_EQUAL) {
			line = {
				type: "context",
				content: item.content,
				oldLineNum,
				newLineNum,
			};
			hunkOldLines += 1;
			hunkNewLines += 1;
			oldLineNum += 1;
			newLineNum += 1;
		} else if (item.op === DIFF_DELETE) {
			line = {
				type: "deletion",
				content: item.content,
				oldLineNum,
				newLineNum: null,
			};
			hunkOldLines += 1;
			oldLineNum += 1;
		} else {
			line = {
				type: "addition",
				content: item.content,
				oldLineNum: null,
				newLineNum,
			};
			hunkNewLines += 1;
			newLineNum += 1;
		}

		hunkDiffLines.push(line);
	}

	if (hunkDiffLines.length > 0) {
		hunks.push({
			oldStart: hunkOldStart,
			oldLines: hunkOldLines,
			newStart: hunkNewStart,
			newLines: hunkNewLines,
			lines: [
				{
					type: "header",
					content: `@@ -${hunkOldStart},${hunkOldLines} +${hunkNewStart},${hunkNewLines} @@`,
					oldLineNum: null,
					newLineNum: null,
				},
				...hunkDiffLines,
			],
		});
	}

	return hunks;
}

export function computeDiff(
	oldContent: string | null,
	newContent: string | null,
	contentMode: DiffContentMode = "incremental",
): DiffResult {
	const oldLines = oldContent?.split("\n") ?? [];
	const newLines = newContent?.split("\n") ?? [];

	if (oldContent === null && newContent !== null) {
		const lines: DiffLine[] = [
			{
				type: "header",
				content: `@@ -0,0 +1,${newLines.length} @@`,
				oldLineNum: null,
				newLineNum: null,
			},
			...newLines.map((line, idx) => ({
				type: "addition" as const,
				content: line,
				oldLineNum: null,
				newLineNum: idx + 1,
			})),
		];

		return {
			hunks: [
				{
					oldStart: 0,
					oldLines: 0,
					newStart: 1,
					newLines: newLines.length,
					lines,
				},
			],
			additions: newLines.length,
			deletions: 0,
		};
	}

	if (oldContent !== null && newContent === null) {
		const lines: DiffLine[] = [
			{
				type: "header",
				content: `@@ -1,${oldLines.length} +0,0 @@`,
				oldLineNum: null,
				newLineNum: null,
			},
			...oldLines.map((line, idx) => ({
				type: "deletion" as const,
				content: line,
				oldLineNum: idx + 1,
				newLineNum: null,
			})),
		];

		return {
			hunks: [
				{
					oldStart: 1,
					oldLines: oldLines.length,
					newStart: 0,
					newLines: 0,
					lines,
				},
			],
			additions: 0,
			deletions: oldLines.length,
		};
	}

	if (oldContent === null && newContent === null) {
		return { hunks: [], additions: 0, deletions: 0 };
	}

	const dmp = new diff_match_patch();
	const { chars1, chars2, lineArray } = linesToChars(oldLines, newLines);
	const charDiffs = dmp.diff_main(chars1, chars2, false);
	dmp.diff_cleanupSemantic(charDiffs);
	const lineDiffs = charsToLines(charDiffs, lineArray);

	let additions = 0;
	let deletions = 0;
	for (const [op, lines] of lineDiffs) {
		if (op === DIFF_INSERT) {
			additions += lines.length;
		} else if (op === DIFF_DELETE) {
			deletions += lines.length;
		}
	}

	const hunks = generateHunks(lineDiffs, contentMode);
	return { hunks, additions, deletions };
}

export function flattenHunks(hunks: DiffHunk[]): DiffLine[] {
	return hunks.flatMap((hunk) => hunk.lines);
}
