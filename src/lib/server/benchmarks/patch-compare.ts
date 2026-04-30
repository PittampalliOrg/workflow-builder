// Pure-TS unified-diff parser. Computes per-patch line/file counts and
// "well-formed" validation, plus overlap stats vs the SWE-bench gold patch.
//
// We deliberately do NOT call out to git here: the SWE-bench harness
// already records `patch_successfully_applied` in `harness_result.report`,
// which is the authoritative apply-success signal. `wellFormed` here is a
// strictly weaker check — "is this even a unified diff?". A patch may be
// well-formed but still fail to apply (context drift, base-commit mismatch).

export type PatchStats = {
	addedLines: number;
	removedLines: number;
	filesTouched: string[];
	wellFormed: boolean;
};

export type GoldOverlap = {
	filesOverlap: number;
	filesOverlapList: string[];
};

const DIFF_GIT_HEADER = /^diff --git a\/(\S+) b\/(\S+)$/;
// SWE-bench predictions sometimes omit the `diff --git` header and start
// straight at `--- a/path`. Accept both forms.
const FILE_HEADER_FROM = /^--- (?:a\/)?(.+?)(?:\t|$)/;
const FILE_HEADER_TO = /^\+\+\+ (?:b\/)?(.+?)(?:\t|$)/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

export function parsePatchStats(unifiedDiff: string | null | undefined): PatchStats {
	const empty: PatchStats = {
		addedLines: 0,
		removedLines: 0,
		filesTouched: [],
		wellFormed: false,
	};
	if (!unifiedDiff || !unifiedDiff.trim()) return empty;

	const lines = unifiedDiff.split(/\r?\n/);
	const filesTouched = new Set<string>();
	let addedLines = 0;
	let removedLines = 0;
	let inHunk = false;
	let sawAnyHunk = false;
	let sawAnyFileHeader = false;
	let lastSawDiffGitOrFromHeader = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.length === 0) {
			// Blank line; allowed inside hunks, otherwise no-op.
			continue;
		}
		const diffMatch = line.match(DIFF_GIT_HEADER);
		if (diffMatch) {
			filesTouched.add(diffMatch[2]);
			sawAnyFileHeader = true;
			lastSawDiffGitOrFromHeader = true;
			inHunk = false;
			continue;
		}
		const fromMatch = line.match(FILE_HEADER_FROM);
		if (fromMatch) {
			lastSawDiffGitOrFromHeader = true;
			inHunk = false;
			continue;
		}
		const toMatch = line.match(FILE_HEADER_TO);
		if (toMatch) {
			// Some patches don't have `diff --git`; the "to" header is the
			// authoritative file path.
			if (toMatch[1] && toMatch[1] !== "/dev/null") {
				filesTouched.add(toMatch[1]);
				sawAnyFileHeader = true;
			}
			lastSawDiffGitOrFromHeader = false;
			inHunk = false;
			continue;
		}
		if (HUNK_HEADER.test(line)) {
			inHunk = true;
			sawAnyHunk = true;
			lastSawDiffGitOrFromHeader = false;
			continue;
		}
		if (inHunk) {
			if (line.startsWith("+") && !line.startsWith("+++")) {
				addedLines += 1;
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				removedLines += 1;
			}
			// Context lines (` ` prefix), `\ No newline at end of file` etc. are ignored.
		}
	}

	// "Well-formed": at least one file header AND at least one hunk header,
	// and no header line orphaned at EOF without a following hunk.
	const wellFormed =
		sawAnyFileHeader &&
		sawAnyHunk &&
		!lastSawDiffGitOrFromHeader && // didn't end mid-header
		filesTouched.size > 0;

	return {
		addedLines,
		removedLines,
		filesTouched: [...filesTouched].sort(),
		wellFormed,
	};
}

export function compareToGold(
	modelPatch: string | null | undefined,
	goldPatch: string | null | undefined,
): GoldOverlap {
	const modelFiles = new Set(parsePatchStats(modelPatch).filesTouched);
	const goldFiles = new Set(parsePatchStats(goldPatch).filesTouched);
	const overlap: string[] = [];
	for (const f of modelFiles) {
		if (goldFiles.has(f)) overlap.push(f);
	}
	overlap.sort();
	return {
		filesOverlap: overlap.length,
		filesOverlapList: overlap,
	};
}
