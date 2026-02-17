"use client";

import { Copy, Download, Loader2, RefreshCw, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Commit,
	CommitActions,
	CommitContent,
	CommitCopyButton,
	CommitHash,
	CommitHeader,
	CommitInfo,
	CommitMessage,
	CommitMetadata,
	CommitSeparator,
} from "@/components/ai-elements/commit";
import {
	FileTree,
	FileTreeFile,
	FileTreeFolder,
} from "@/components/ai-elements/file-tree";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { DiffToolbar } from "@/components/workflow-runs/diff/diff-toolbar";
import { MonacoDiffView } from "@/components/workflow-runs/diff/monaco-diff-view";
import { useDiffPreferences } from "@/hooks/use-diff-preferences";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DiffHunk, DiffResult } from "@/lib/diff/types";
import { computeDiff } from "@/lib/diff/compute-diff";
import {
	api,
	type ExecutionChangeArtifactMetadata,
	type ExecutionFileSnapshot,
} from "@/lib/api-client";
import { cn } from "@/lib/utils";

const VISUAL_DIFF_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_RETRIES = 20;

type UnifiedPatchSection = {
	header: string;
	path: string;
	type: "added" | "deleted" | "renamed" | "modified";
	lines: string[];
};

type FileTreeNode = {
	kind: "folder" | "file";
	name: string;
	path: string;
	status?: "A" | "M" | "D" | "R";
	children?: FileTreeNode[];
};

type FileStats = {
	additions: number;
	deletions: number;
	hunks: number;
	lines: number;
	sections: number;
	status: "A" | "M" | "D" | "R";
};

type DiffTextPair = {
	original: string;
	modified: string;
	language: string;
};

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function statusLabel(status: string): string {
	switch (status) {
		case "A":
			return "Added";
		case "D":
			return "Deleted";
		case "R":
			return "Renamed";
		default:
			return "Modified";
	}
}

function statusClass(status: string): string {
	switch (status) {
		case "A":
			return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300";
		case "D":
			return "bg-rose-500/15 text-rose-600 dark:text-rose-300";
		case "R":
			return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
		default:
			return "bg-sky-500/15 text-sky-700 dark:text-sky-300";
	}
}

function downloadTextFile(content: string, filename: string): void {
	const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
	const objectUrl = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = objectUrl;
	anchor.download = filename;
	anchor.click();
	URL.revokeObjectURL(objectUrl);
}

function shortenHash(value: string | null | undefined): string {
	if (!value) {
		return "unknown";
	}
	return value.slice(0, 12);
}

function parsePatchPath(headerLine: string): string {
	const match = headerLine.match(/^diff --git a\/(.+) b\/(.+)$/);
	if (!match) {
		return "Patch";
	}
	if (match[2] === "/dev/null") {
		return match[1];
	}
	return match[2];
}

function splitUnifiedPatchFiles(patch: string): UnifiedPatchSection[] {
	const lines = patch.split("\n");
	const sections: UnifiedPatchSection[] = [];
	let current: UnifiedPatchSection | null = null;

	const pushCurrent = () => {
		if (!current) {
			return;
		}
		sections.push(current);
		current = null;
	};

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			pushCurrent();
			current = {
				header: line,
				path: parsePatchPath(line),
				type: "modified",
				lines: [line],
			};
			continue;
		}

		if (!current) {
			current = {
				header: "diff --git",
				path: "Patch",
				type: "modified",
				lines: [],
			};
		}

		if (line.startsWith("new file mode ")) {
			current.type = "added";
		} else if (line.startsWith("deleted file mode ")) {
			current.type = "deleted";
		} else if (
			line.startsWith("rename from ") ||
			line.startsWith("rename to ")
		) {
			current.type = "renamed";
		}
		current.lines.push(line);
	}

	pushCurrent();
	return sections;
}

function sectionTypeToStatus(
	type: UnifiedPatchSection["type"],
): "A" | "M" | "D" | "R" {
	switch (type) {
		case "added":
			return "A";
		case "deleted":
			return "D";
		case "renamed":
			return "R";
		default:
			return "M";
	}
}

function getSectionStats(section: UnifiedPatchSection): {
	additions: number;
	deletions: number;
	hunks: number;
	lines: number;
} {
	let additions = 0;
	let deletions = 0;
	let hunks = 0;

	for (const line of section.lines) {
		if (line.startsWith("@@")) {
			hunks += 1;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			additions += 1;
		}
		if (line.startsWith("-") && !line.startsWith("---")) {
			deletions += 1;
		}
	}

	return {
		additions,
		deletions,
		hunks,
		lines: section.lines.length,
	};
}

function parseHunkHeader(headerLine: string): {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
} | null {
	const match = headerLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
	if (!match) {
		return null;
	}

	const oldStart = Number.parseInt(match[1] ?? "0", 10);
	const oldLines = Number.parseInt(match[2] ?? "1", 10);
	const newStart = Number.parseInt(match[3] ?? "0", 10);
	const newLines = Number.parseInt(match[4] ?? "1", 10);

	if (
		Number.isNaN(oldStart) ||
		Number.isNaN(oldLines) ||
		Number.isNaN(newStart) ||
		Number.isNaN(newLines)
	) {
		return null;
	}

	return { oldStart, oldLines, newStart, newLines };
}

function parseUnifiedPatchToDiff(patch: string): DiffResult | null {
	const lines = patch.split("\n");
	const hunks: DiffHunk[] = [];

	let currentHunk: DiffHunk | null = null;
	let currentOldLine = 0;
	let currentNewLine = 0;
	let additions = 0;
	let deletions = 0;

	const pushCurrentHunk = () => {
		if (!currentHunk) {
			return;
		}
		hunks.push(currentHunk);
		currentHunk = null;
	};

	for (const line of lines) {
		if (line.startsWith("@@")) {
			pushCurrentHunk();
			const header = parseHunkHeader(line);
			if (!header) {
				continue;
			}
			currentOldLine = header.oldStart;
			currentNewLine = header.newStart;
			currentHunk = {
				oldStart: header.oldStart,
				oldLines: header.oldLines,
				newStart: header.newStart,
				newLines: header.newLines,
				lines: [
					{
						type: "header",
						content: line,
						oldLineNum: null,
						newLineNum: null,
					},
				],
			};
			continue;
		}

		if (!currentHunk) {
			continue;
		}

		if (line.startsWith("+") && !line.startsWith("+++")) {
			additions += 1;
			currentHunk.lines.push({
				type: "addition",
				content: line.slice(1),
				oldLineNum: null,
				newLineNum: currentNewLine,
			});
			currentNewLine += 1;
			continue;
		}

		if (line.startsWith("-") && !line.startsWith("---")) {
			deletions += 1;
			currentHunk.lines.push({
				type: "deletion",
				content: line.slice(1),
				oldLineNum: currentOldLine,
				newLineNum: null,
			});
			currentOldLine += 1;
			continue;
		}

		if (line.startsWith(" ")) {
			currentHunk.lines.push({
				type: "context",
				content: line.slice(1),
				oldLineNum: currentOldLine,
				newLineNum: currentNewLine,
			});
			currentOldLine += 1;
			currentNewLine += 1;
		}
	}

	pushCurrentHunk();

	if (hunks.length === 0) {
		return null;
	}

	return {
		hunks,
		additions,
		deletions,
	};
}

function monacoLanguageFromPath(path: string | null | undefined): string {
	if (!path) {
		return "plaintext";
	}

	const fileName = path.split("/").pop()?.toLowerCase() ?? "";
	if (fileName === "dockerfile") return "dockerfile";
	if (fileName === "makefile") return "makefile";

	const ext = fileName.split(".").pop();
	switch (ext) {
		case "ts":
		case "tsx":
			return "typescript";
		case "js":
		case "jsx":
			return "javascript";
		case "json":
			return "json";
		case "md":
			return "markdown";
		case "py":
			return "python";
		case "go":
			return "go";
		case "rs":
			return "rust";
		case "java":
			return "java";
		case "kt":
			return "kotlin";
		case "rb":
			return "ruby";
		case "php":
			return "php";
		case "sh":
		case "bash":
		case "zsh":
			return "shell";
		case "yaml":
		case "yml":
			return "yaml";
		case "toml":
			return "toml";
		case "xml":
			return "xml";
		case "css":
			return "css";
		case "scss":
			return "scss";
		case "html":
			return "html";
		case "sql":
			return "sql";
		default:
			return "plaintext";
	}
}

function diffResultToTextPair(result: DiffResult): {
	original: string;
	modified: string;
} {
	const oldLines: string[] = [];
	const newLines: string[] = [];

	for (const [hunkIndex, hunk] of result.hunks.entries()) {
		if (hunkIndex > 0) {
			oldLines.push("...");
			newLines.push("...");
		}

		for (const line of hunk.lines) {
			if (line.type === "header") {
				continue;
			}
			if (line.type === "context") {
				oldLines.push(line.content);
				newLines.push(line.content);
				continue;
			}
			if (line.type === "deletion") {
				oldLines.push(line.content);
				continue;
			}
			newLines.push(line.content);
		}
	}

	return {
		original: oldLines.join("\n"),
		modified: newLines.join("\n"),
	};
}

function buildFileTree(
	files: { path: string; status: "A" | "M" | "D" | "R" }[],
): { defaultExpanded: Set<string>; nodes: FileTreeNode[] } {
	type MutableTreeFolderNode = {
		children: Map<string, MutableTreeFolderNode>;
		files: Map<string, { path: string; status: "A" | "M" | "D" | "R" }>;
		name: string;
		path: string;
	};

	const root: MutableTreeFolderNode = {
		children: new Map(),
		files: new Map(),
		name: "",
		path: "",
	};

	for (const file of files) {
		const parts = file.path.split("/").filter(Boolean);
		if (parts.length === 0) {
			continue;
		}

		let current = root;
		let currentPath = "";

		for (const [index, part] of parts.entries()) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const isLeaf = index === parts.length - 1;
			if (isLeaf) {
				current.files.set(part, { path: currentPath, status: file.status });
				continue;
			}

			let child = current.children.get(part);
			if (!child) {
				child = {
					children: new Map(),
					files: new Map(),
					name: part,
					path: currentPath,
				};
				current.children.set(part, child);
			}
			current = child;
		}
	}

	const defaultExpanded = new Set<string>();

	const toNodes = (folder: MutableTreeFolderNode): FileTreeNode[] => {
		const folderNodes = Array.from(folder.children.values())
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((child) => {
				defaultExpanded.add(child.path);
				return {
					children: toNodes(child),
					kind: "folder" as const,
					name: child.name,
					path: child.path,
				};
			});

		const fileNodes = Array.from(folder.files.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, file]) => ({
				kind: "file" as const,
				name,
				path: file.path,
				status: file.status,
			}));

		return [...folderNodes, ...fileNodes];
	};

	return { defaultExpanded, nodes: toNodes(root) };
}

function renderFileTreeNodes(nodes: FileTreeNode[]): ReactNode {
	return nodes.map((node) => {
		if (node.kind === "folder") {
			return (
				<FileTreeFolder key={node.path} name={node.name} path={node.path}>
					{renderFileTreeNodes(node.children ?? [])}
				</FileTreeFolder>
			);
		}

		return (
			<FileTreeFile key={node.path} name={node.name} path={node.path}>
				<span className="size-4" />
				<span
					className={cn(
						"inline-flex min-w-5 justify-center rounded px-1 py-0.5 font-mono font-semibold text-[10px]",
						statusClass(node.status ?? "M"),
					)}
				>
					{node.status ?? "M"}
				</span>
				<span className="truncate">{node.name}</span>
			</FileTreeFile>
		);
	});
}

type ExecutionChangesPanelProps = {
	executionId: string;
	initialSelectedFilePath?: string | null;
	onSelectedFilePathChange?: (path: string | null) => void;
};

export function ExecutionChangesPanel({
	executionId,
	initialSelectedFilePath,
	onSelectedFilePathChange,
}: ExecutionChangesPanelProps) {
	const { viewMode, contentMode, setContentMode, setViewMode } =
		useDiffPreferences();
	const [changes, setChanges] = useState<ExecutionChangeArtifactMetadata[]>([]);
	const [combinedPatch, setCombinedPatch] = useState("");
	const [patchError, setPatchError] = useState<string | null>(null);
	const [pendingSync, setPendingSync] = useState(false);
	const [pendingRetries, setPendingRetries] = useState(0);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [selectedFilePath, setSelectedFilePath] = useState<string | null>(
		initialSelectedFilePath ?? null,
	);
	const [snapshotByPath, setSnapshotByPath] = useState<
		Record<string, ExecutionFileSnapshot | null>
	>({});
	const [snapshotErrorByPath, setSnapshotErrorByPath] = useState<
		Record<string, string | undefined>
	>({});
	const [snapshotLoadingPath, setSnapshotLoadingPath] = useState<string | null>(
		null,
	);
	const [isDownloadingCombined, setIsDownloadingCombined] = useState(false);

	const loadData = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const changesResult = await api.workflow.getExecutionChanges(executionId);
			setChanges(changesResult.changes ?? []);

			let patchPending = false;
			try {
				const patchResult = await api.workflow.getExecutionPatch(executionId);
				setCombinedPatch(patchResult.patch ?? "");
				setPatchError(null);
				patchPending = Boolean(patchResult.pending);
			} catch (patchLoadError) {
				setCombinedPatch("");
				setPatchError(
					patchLoadError instanceof Error
						? patchLoadError.message
						: "Failed to load combined patch",
				);
			}

			const nextPending = Boolean(changesResult.pending || patchPending);
			setPendingSync(nextPending);
			setPendingRetries((current) => (nextPending ? current + 1 : 0));
		} catch (loadError) {
			setPendingSync(false);
			setError(
				loadError instanceof Error
					? loadError.message
					: "Failed to load file changes",
			);
		} finally {
			setIsLoading(false);
		}
	}, [executionId]);

	useEffect(() => {
		setSearch("");
		setSelectedFilePath(initialSelectedFilePath ?? null);
		setSnapshotByPath({});
		setSnapshotErrorByPath({});
		setSnapshotLoadingPath(null);
		setPendingSync(false);
		setPendingRetries(0);
		void loadData();
	}, [initialSelectedFilePath, loadData]);

	useEffect(() => {
		if (initialSelectedFilePath === undefined) {
			return;
		}
		setSelectedFilePath(initialSelectedFilePath ?? null);
	}, [initialSelectedFilePath]);

	useEffect(() => {
		if (!pendingSync) {
			return;
		}
		if (pendingRetries >= MAX_PENDING_RETRIES) {
			setPendingSync(false);
			setError(
				"File changes are taking longer than expected. Click Retry to check again.",
			);
			return;
		}
		const timeout = setTimeout(() => {
			void loadData();
		}, 3000);
		return () => clearTimeout(timeout);
	}, [loadData, pendingRetries, pendingSync]);

	const includedChanges = useMemo(
		() => changes.filter((item) => item.includeInExecutionPatch),
		[changes],
	);

	const summary = useMemo(() => {
		return includedChanges.reduce(
			(acc, current) => ({
				additions: acc.additions + current.additions,
				artifacts: acc.artifacts + 1,
				deletions: acc.deletions + current.deletions,
				files: acc.files + current.filesChanged,
			}),
			{ additions: 0, artifacts: 0, deletions: 0, files: 0 },
		);
	}, [includedChanges]);

	const patchBytes = useMemo(
		() => new Blob([combinedPatch]).size,
		[combinedPatch],
	);

	const patchSections = useMemo(() => {
		if (!combinedPatch) {
			return [];
		}
		return splitUnifiedPatchFiles(combinedPatch);
	}, [combinedPatch]);

	const fileEntries = useMemo(() => {
		const byPath = new Map<
			string,
			{ oldPath?: string; path: string; status: "A" | "M" | "D" | "R" }
		>();
		for (const change of includedChanges) {
			for (const file of change.files) {
				byPath.set(file.path, {
					path: file.path,
					status: file.status,
					oldPath: file.oldPath,
				});
			}
		}
		for (const section of patchSections) {
			if (!byPath.has(section.path)) {
				byPath.set(section.path, {
					path: section.path,
					status: sectionTypeToStatus(section.type),
				});
			}
		}
		return Array.from(byPath.values()).sort((a, b) =>
			a.path.localeCompare(b.path),
		);
	}, [includedChanges, patchSections]);

	const filteredFileEntries = useMemo(() => {
		const query = search.trim().toLowerCase();
		if (!query) {
			return fileEntries;
		}
		return fileEntries.filter((file) =>
			file.path.toLowerCase().includes(query),
		);
	}, [fileEntries, search]);

	const selectedFileTree = useMemo(
		() => buildFileTree(filteredFileEntries),
		[filteredFileEntries],
	);

	useEffect(() => {
		setSelectedFilePath((current) => {
			if (
				current &&
				filteredFileEntries.some((file) => file.path === current)
			) {
				return current;
			}
			const next = filteredFileEntries[0]?.path ?? null;
			if (next !== current) {
				onSelectedFilePathChange?.(next);
			}
			return next;
		});
	}, [filteredFileEntries, onSelectedFilePathChange]);

	const selectedSections = useMemo(() => {
		if (!selectedFilePath) {
			return [];
		}
		return patchSections.filter((section) => section.path === selectedFilePath);
	}, [patchSections, selectedFilePath]);

	const selectedPatch = useMemo(
		() =>
			selectedSections.map((section) => section.lines.join("\n")).join("\n\n"),
		[selectedSections],
	);

	const selectedPatchBytes = useMemo(
		() => new Blob([selectedPatch]).size,
		[selectedPatch],
	);

	const selectedSnapshot = useMemo(() => {
		if (!selectedFilePath) {
			return null;
		}
		return selectedFilePath in snapshotByPath
			? snapshotByPath[selectedFilePath]
			: undefined;
	}, [selectedFilePath, snapshotByPath]);

	const selectedSnapshotError = useMemo(() => {
		if (!selectedFilePath) {
			return undefined;
		}
		return snapshotErrorByPath[selectedFilePath];
	}, [selectedFilePath, snapshotErrorByPath]);

	const selectedSnapshotLoading = Boolean(
		selectedFilePath && snapshotLoadingPath === selectedFilePath,
	);

	const selectedFileStats = useMemo<FileStats | null>(() => {
		if (selectedSections.length === 0) {
			if (!selectedSnapshot || selectedSnapshot === null) {
				return null;
			}
			const additions = selectedSnapshot.history.reduce(
				(total, row) => total + Math.max(0, row.newBytes > 0 ? 1 : 0),
				0,
			);
			const deletions = selectedSnapshot.history.reduce(
				(total, row) => total + Math.max(0, row.oldBytes > 0 ? 1 : 0),
				0,
			);
			return {
				additions,
				deletions,
				hunks: selectedSnapshot.history.length,
				lines: selectedSnapshot.history.length,
				sections: selectedSnapshot.history.length,
				status: selectedSnapshot.status,
			};
		}

		let additions = 0;
		let deletions = 0;
		let hunks = 0;
		let lines = 0;
		const statuses = new Set<"A" | "M" | "D" | "R">();

		for (const section of selectedSections) {
			const sectionStats = getSectionStats(section);
			additions += sectionStats.additions;
			deletions += sectionStats.deletions;
			hunks += sectionStats.hunks;
			lines += sectionStats.lines;
			statuses.add(sectionTypeToStatus(section.type));
		}

		return {
			additions,
			deletions,
			hunks,
			lines,
			sections: selectedSections.length,
			status: statuses.size === 1 ? Array.from(statuses)[0] : "M",
		};
	}, [selectedSections, selectedSnapshot]);

	const selectedDiffResult = useMemo<DiffResult | null>(() => {
		if (selectedSnapshot && selectedSnapshot !== null) {
			if (selectedSnapshot.isBinary) {
				return null;
			}
			return computeDiff(
				selectedSnapshot.oldContent,
				selectedSnapshot.newContent,
				contentMode,
			);
		}

		if (!selectedPatch) {
			return null;
		}

		return parseUnifiedPatchToDiff(selectedPatch);
	}, [contentMode, selectedPatch, selectedSnapshot]);

	const selectedDiffText = useMemo<DiffTextPair | null>(() => {
		if (!selectedDiffResult) {
			return null;
		}
		const pair = diffResultToTextPair(selectedDiffResult);
		return {
			...pair,
			language:
				selectedSnapshot?.language ||
				monacoLanguageFromPath(selectedSnapshot?.path || selectedFilePath),
		};
	}, [selectedDiffResult, selectedFilePath, selectedSnapshot]);

	useEffect(() => {
		if (!selectedFilePath) {
			return;
		}
		if (snapshotByPath[selectedFilePath] !== undefined) {
			return;
		}

		let active = true;
		setSnapshotLoadingPath(selectedFilePath);
		void api.workflow
			.getExecutionFileSnapshot(executionId, selectedFilePath)
			.then((result) => {
				if (!active) {
					return;
				}
				setSnapshotByPath((prev) => ({
					...prev,
					[selectedFilePath]: result.snapshot ?? null,
				}));
				setSnapshotErrorByPath((prev) => ({
					...prev,
					[selectedFilePath]: undefined,
				}));
			})
			.catch((loadError) => {
				if (!active) {
					return;
				}
				setSnapshotByPath((prev) => ({
					...prev,
					[selectedFilePath]: null,
				}));
				setSnapshotErrorByPath((prev) => ({
					...prev,
					[selectedFilePath]:
						loadError instanceof Error
							? loadError.message
							: "Failed to load file snapshot",
				}));
			})
			.finally(() => {
				if (active) {
					setSnapshotLoadingPath((current) =>
						current === selectedFilePath ? null : current,
					);
				}
			});

		return () => {
			active = false;
		};
	}, [executionId, selectedFilePath, snapshotByPath]);

	const commitRange = useMemo(() => {
		const sorted = [...includedChanges].sort((a, b) => a.sequence - b.sequence);
		const baseRevision =
			sorted
				.find((change) => change.baseRevision?.trim())
				?.baseRevision?.trim() ?? null;
		const headRevision =
			[...sorted]
				.reverse()
				.find((change) => change.headRevision?.trim())
				?.headRevision?.trim() ?? null;

		return {
			baseRevision,
			headRevision,
			workspaceCount: new Set(sorted.map((change) => change.workspaceRef)).size,
		};
	}, [includedChanges]);

	const copySelectedPatch = useCallback(async () => {
		if (!selectedPatch) {
			return;
		}
		try {
			await navigator.clipboard.writeText(selectedPatch);
			toast.success("Selected file diff copied");
		} catch {
			toast.error("Failed to copy selected diff");
		}
	}, [selectedPatch]);

	const downloadSelectedPatch = useCallback(() => {
		if (!selectedPatch || !selectedFilePath) {
			return;
		}
		const safeName = selectedFilePath.replaceAll("/", "_");
		downloadTextFile(selectedPatch, `${safeName}.patch`);
	}, [selectedFilePath, selectedPatch]);

	const downloadCombinedPatch = useCallback(async () => {
		setIsDownloadingCombined(true);
		try {
			const result = await api.workflow.getExecutionPatch(executionId);
			downloadTextFile(result.patch ?? "", `execution-${executionId}.patch`);
			toast.success("Combined patch downloaded");
		} catch (downloadError) {
			toast.error(
				downloadError instanceof Error
					? downloadError.message
					: "Failed to download combined patch",
			);
		} finally {
			setIsDownloadingCombined(false);
		}
	}, [executionId]);

	const copyCombinedPatch = useCallback(async () => {
		if (!combinedPatch) {
			return;
		}
		try {
			await navigator.clipboard.writeText(combinedPatch);
			toast.success("Combined patch copied");
		} catch {
			toast.error("Failed to copy combined patch");
		}
	}, [combinedPatch]);

	if (isLoading) {
		return (
			<div className="rounded-lg border bg-background p-4">
				<div className="flex items-center gap-2 text-sm">
					<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
					<Shimmer className="text-muted-foreground">
						Loading file changes...
					</Shimmer>
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
				<div className="mb-3 text-destructive text-sm">{error}</div>
				<Button onClick={() => void loadData()} size="sm" variant="outline">
					<RefreshCw className="mr-2 h-4 w-4" />
					Retry
				</Button>
			</div>
		);
	}

	if (changes.length === 0) {
		return (
			<div className="rounded-lg border bg-background p-4">
				<div className="font-medium text-sm">File Changes</div>
				{pendingSync ? (
					<div className="mt-2 flex items-center gap-2 text-sm">
						<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
						<Shimmer className="text-muted-foreground">
							Changes are still being indexed. Retrying...
						</Shimmer>
					</div>
				) : (
					<div className="mt-2 text-muted-foreground text-sm">
						This run did not persist any workspace file changes.
					</div>
				)}
			</div>
		);
	}

	if (includedChanges.length === 0 || fileEntries.length === 0) {
		return (
			<div className="space-y-3 rounded-lg border bg-background p-4">
				<div className="font-medium text-sm">File Changes</div>
				<div className="text-muted-foreground text-sm">
					No editable file-change diffs are available for this run.
				</div>
				{patchError && (
					<div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
						{patchError}
					</div>
				)}
			</div>
		);
	}

	return (
		<div
			className="space-y-3 rounded-lg border bg-background p-3.5"
			id="file-changes"
		>
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div>
					<h2 className="font-semibold text-base">File Changes</h2>
					<p className="text-muted-foreground text-xs">
						Select a file to inspect its diff and metadata.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Button
						disabled={!combinedPatch}
						onClick={() => void copyCombinedPatch()}
						size="sm"
						variant="outline"
					>
						<Copy className="mr-2 h-3.5 w-3.5" />
						Copy Combined
					</Button>
					<Button
						disabled={isDownloadingCombined}
						onClick={() => void downloadCombinedPatch()}
						size="sm"
						variant="outline"
					>
						{isDownloadingCombined ? (
							<Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
						) : (
							<Download className="mr-2 h-3.5 w-3.5" />
						)}
						Download Combined
					</Button>
				</div>
			</div>

			<div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/20 px-2.5 py-1.5 text-xs">
				<span className="inline-flex items-center gap-1 rounded border bg-background px-2 py-1">
					<span className="text-muted-foreground">Artifacts</span>
					<span className="font-semibold">{summary.artifacts}</span>
				</span>
				<span className="inline-flex items-center gap-1 rounded border bg-background px-2 py-1">
					<span className="text-muted-foreground">Files</span>
					<span className="font-semibold">{fileEntries.length}</span>
				</span>
				<span className="inline-flex items-center gap-1 rounded border bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300">
					+{summary.additions}
				</span>
				<span className="inline-flex items-center gap-1 rounded border bg-rose-500/10 px-2 py-1 text-rose-700 dark:text-rose-300">
					-{summary.deletions}
				</span>
				<span className="inline-flex items-center gap-1 rounded border bg-background px-2 py-1">
					<span className="text-muted-foreground">Patch</span>
					<span className="font-semibold">{formatBytes(patchBytes)}</span>
				</span>
			</div>

			{patchBytes > VISUAL_DIFF_LIMIT_BYTES && (
				<div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-amber-800 text-xs dark:text-amber-300">
					Large patch detected ({formatBytes(patchBytes)}). File-level viewing
					is enabled to keep the UI responsive.
				</div>
			)}

			{patchError && (
				<div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
					{patchError}
				</div>
			)}

			<Commit defaultOpen={false}>
				<CommitHeader>
					<CommitInfo className="min-w-0 gap-1">
						<div className="flex items-center gap-2">
							<CommitMessage>Baseline Commit Context</CommitMessage>
							<CommitHash>{shortenHash(commitRange.baseRevision)}</CommitHash>
							{commitRange.headRevision ? (
								<>
									<CommitSeparator />
									<CommitHash>
										{shortenHash(commitRange.headRevision)}
									</CommitHash>
								</>
							) : null}
						</div>
						<CommitMetadata>
							<span>{summary.artifacts} change artifact(s)</span>
							<CommitSeparator />
							<span>{commitRange.workspaceCount} workspace session(s)</span>
						</CommitMetadata>
					</CommitInfo>
					<CommitActions>
						{commitRange.baseRevision ? (
							<CommitCopyButton
								hash={commitRange.baseRevision}
								onCopy={() => toast.success("Baseline commit copied")}
								onError={() => toast.error("Failed to copy baseline commit")}
								title="Copy baseline commit"
							/>
						) : null}
					</CommitActions>
				</CommitHeader>
				<CommitContent>
					<div className="text-muted-foreground text-xs">
						Baseline:{" "}
						<span className="font-mono text-foreground">
							{commitRange.baseRevision ?? "Unavailable"}
						</span>
						{commitRange.headRevision ? (
							<>
								{" "}
								<CommitSeparator />
								Head:{" "}
								<span className="font-mono text-foreground">
									{commitRange.headRevision}
								</span>
							</>
						) : null}
					</div>
				</CommitContent>
			</Commit>

			<div className="grid gap-3 lg:grid-cols-[300px,1fr]">
				<div className="space-y-2 rounded-md border p-2.5">
					<div className="relative">
						<Search className="-translate-y-1/2 absolute top-1/2 left-2 h-4 w-4 text-muted-foreground" />
						<Input
							className="pl-8"
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Filter files..."
							value={search}
						/>
					</div>

					<div className="max-h-[260px] overflow-auto sm:max-h-[420px] lg:max-h-[calc(100vh-20rem)]">
						{filteredFileEntries.length > 0 ? (
							<FileTree
								defaultExpanded={selectedFileTree.defaultExpanded}
								key={search || "all-files"}
								onSelect={(path) => {
									setSelectedFilePath(path);
									onSelectedFilePathChange?.(path);
								}}
								selectedPath={selectedFilePath ?? undefined}
							>
								{renderFileTreeNodes(selectedFileTree.nodes)}
							</FileTree>
						) : (
							<div className="rounded border border-dashed p-3 text-muted-foreground text-sm">
								No files match the filter.
							</div>
						)}
					</div>
				</div>

				<div className="space-y-2 rounded-md border p-2.5">
					{selectedFilePath ? (
						<>
							<div className="flex flex-wrap items-start justify-between gap-2">
								<div className="min-w-0">
									<div className="truncate font-medium text-sm">
										{selectedFilePath}
									</div>
									{selectedSnapshot?.oldPath &&
									selectedSnapshot.oldPath !== selectedSnapshot.path ? (
										<div className="truncate text-muted-foreground text-xs">
											renamed from {selectedSnapshot.oldPath}
										</div>
									) : null}
									{selectedFileStats ? (
										<div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
											<span
												className={cn(
													"inline-flex items-center gap-1 rounded px-2 py-0.5",
													statusClass(selectedFileStats.status),
												)}
											>
												{selectedFileStats.status}{" "}
												{statusLabel(selectedFileStats.status)}
											</span>
											<span className="inline-flex items-center gap-1 rounded border px-2 py-0.5">
												+{selectedFileStats.additions}
											</span>
											<span className="inline-flex items-center gap-1 rounded border px-2 py-0.5">
												-{selectedFileStats.deletions}
											</span>
											<span className="inline-flex items-center gap-1 rounded border px-2 py-0.5">
												{selectedFileStats.hunks} hunks
											</span>
											<span className="inline-flex items-center gap-1 rounded border px-2 py-0.5">
												{selectedFileStats.sections} section
												{selectedFileStats.sections === 1 ? "" : "s"}
											</span>
										</div>
									) : null}
								</div>
								<div className="flex items-center gap-1.5">
									{selectedDiffText ? (
										<DiffToolbar
											contentMode={contentMode}
											onContentModeChange={setContentMode}
											onViewModeChange={setViewMode}
											viewMode={viewMode}
										/>
									) : null}
									<Button
										disabled={!selectedPatch}
										onClick={() => void copySelectedPatch()}
										size="sm"
										variant="outline"
									>
										<Copy className="mr-2 h-3.5 w-3.5" />
										Copy
									</Button>
									<Button
										disabled={!selectedPatch}
										onClick={downloadSelectedPatch}
										size="sm"
										variant="outline"
									>
										<Download className="mr-2 h-3.5 w-3.5" />
										Download
									</Button>
								</div>
							</div>

							<div className="max-h-[320px] overflow-auto rounded-md border bg-[#0d1117] sm:max-h-[420px] lg:max-h-[calc(100vh-20rem)]">
								{selectedSnapshotLoading ? (
									<div className="flex items-center gap-2 p-3 text-sm text-zinc-400">
										<Loader2 className="h-4 w-4 animate-spin" />
										Loading file snapshot...
									</div>
								) : selectedSnapshotError ? (
									<div className="space-y-2 p-3">
										<div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive text-xs">
											{selectedSnapshotError}
										</div>
										{selectedDiffText ? (
											<MonacoDiffView
												height="min(52vh, 520px)"
												language={selectedDiffText.language}
												modified={selectedDiffText.modified}
												original={selectedDiffText.original}
												splitView={viewMode === "split"}
											/>
										) : (
											<pre className="overflow-auto rounded-md border border-zinc-800 bg-[#0d1117] p-3 font-mono text-[13px] leading-6 text-zinc-200">
												{selectedPatch ||
													"No patch available for selected file."}
											</pre>
										)}
									</div>
								) : selectedSnapshot && selectedSnapshot.isBinary ? (
									<div className="space-y-2 p-3 text-xs">
										<div className="rounded-md border bg-background p-3">
											<div className="font-medium text-sm">
												Binary file change
											</div>
											<div className="mt-1 text-muted-foreground">
												Preview is unavailable for binary content.
											</div>
											<div className="mt-2 flex flex-wrap gap-1.5">
												<span className="inline-flex items-center gap-1 rounded border px-2 py-0.5">
													Old: {formatBytes(selectedSnapshot.oldBytes)}
												</span>
												<span className="inline-flex items-center gap-1 rounded border px-2 py-0.5">
													New: {formatBytes(selectedSnapshot.newBytes)}
												</span>
											</div>
										</div>
									</div>
								) : selectedDiffText ? (
									<MonacoDiffView
										height="min(52vh, 520px)"
										language={selectedDiffText.language}
										modified={selectedDiffText.modified}
										original={selectedDiffText.original}
										splitView={viewMode === "split"}
									/>
								) : (
									<pre className="overflow-auto rounded-md border border-zinc-800 bg-[#0d1117] p-3 font-mono text-[13px] leading-6 text-zinc-200">
										{selectedPatch || "No diff available for selected file."}
									</pre>
								)}
							</div>

							{selectedFileStats ? (
								<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
									<div className="rounded border bg-muted/20 px-2 py-1.5 text-xs">
										<span className="text-muted-foreground">Changed Lines</span>
										<div className="font-semibold">
											{selectedFileStats.additions +
												selectedFileStats.deletions}
										</div>
									</div>
									<div className="rounded border bg-muted/20 px-2 py-1.5 text-xs">
										<span className="text-muted-foreground">Patch Lines</span>
										<div className="font-semibold">
											{selectedFileStats.lines}
										</div>
									</div>
									<div className="rounded border bg-muted/20 px-2 py-1.5 text-xs">
										<span className="text-muted-foreground">
											File Diff Size
										</span>
										<div className="font-semibold">
											{selectedSnapshot
												? formatBytes(
														selectedSnapshot.oldBytes +
															selectedSnapshot.newBytes,
													)
												: formatBytes(selectedPatchBytes)}
										</div>
									</div>
								</div>
							) : null}
						</>
					) : (
						<div className="text-muted-foreground text-sm">
							Select a file from the tree to view its diff.
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
