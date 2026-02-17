export type DiffViewMode = "unified" | "split";
export type DiffContentMode = "incremental" | "full";

export interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: DiffLine[];
}

export interface DiffLine {
	type: "context" | "addition" | "deletion" | "header";
	content: string;
	oldLineNum: number | null;
	newLineNum: number | null;
	highlightedHtml?: string;
}

export interface DiffPreferences {
	viewMode: DiffViewMode;
	contentMode: DiffContentMode;
}

export interface DiffResult {
	hunks: DiffHunk[];
	additions: number;
	deletions: number;
}
