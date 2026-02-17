"use client";

import {
	Check,
	Copy,
	Download,
	FileCode2,
	FileDiff,
	GitCommit,
	GitPullRequest,
	Loader2,
	RefreshCw,
	Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type ExecutionChangeArtifactMetadata } from "@/lib/api-client";
import { cn } from "@/lib/utils";

const VISUAL_DIFF_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_RETRIES = 20;
const FILE_PREVIEW_LIMIT = 100;
const LARGE_FILESET_THRESHOLD = 200;

type UnifiedPatchSection = {
	header: string;
	path: string;
	type: "added" | "deleted" | "renamed" | "modified";
	lines: string[];
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

function patchLineClass(line: string): string {
	if (line.startsWith("@@")) {
		return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
	}
	if (line.startsWith("+") && !line.startsWith("+++")) {
		return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
	}
	if (line.startsWith("-") && !line.startsWith("---")) {
		return "bg-rose-500/15 text-rose-700 dark:text-rose-300";
	}
	if (
		line.startsWith("diff --git ") ||
		line.startsWith("index ") ||
		line.startsWith("--- ") ||
		line.startsWith("+++ ")
	) {
		return "text-muted-foreground";
	}
	return "";
}

function summarizeFileStatuses(
	files: { status: string }[],
): Record<string, number> {
	return files.reduce<Record<string, number>>((acc, file) => {
		acc[file.status] = (acc[file.status] ?? 0) + 1;
		return acc;
	}, {});
}

type ExecutionChangesPanelProps = {
	executionId: string;
};

export function ExecutionChangesPanel({
	executionId,
}: ExecutionChangesPanelProps) {
	const [changes, setChanges] = useState<ExecutionChangeArtifactMetadata[]>([]);
	const [pendingSync, setPendingSync] = useState(false);
	const [pendingRetries, setPendingRetries] = useState(0);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selectedChangeSetId, setSelectedChangeSetId] = useState<string | null>(
		null,
	);
	const [patchesById, setPatchesById] = useState<Record<string, string>>({});
	const [loadingPatchId, setLoadingPatchId] = useState<string | null>(null);
	const [patchErrorsById, setPatchErrorsById] = useState<
		Record<string, string>
	>({});
	const [tab, setTab] = useState("diff");
	const [search, setSearch] = useState("");
	const [forceRenderLargeDiff, setForceRenderLargeDiff] = useState(false);
	const [showBaselineArtifacts, setShowBaselineArtifacts] = useState(false);
	const [showAllFiles, setShowAllFiles] = useState(false);
	const [copied, setCopied] = useState(false);
	const [isDownloadingCombined, setIsDownloadingCombined] = useState(false);

	const loadChanges = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const result = await api.workflow.getExecutionChanges(executionId);
			setChanges(result.changes ?? []);
			const nextPending = Boolean(result.pending);
			setPendingSync(nextPending);
			setPendingRetries((current) => (nextPending ? current + 1 : 0));
			setSelectedChangeSetId((current) => {
				if (
					current &&
					result.changes.some((item) => item.changeSetId === current)
				) {
					return current;
				}
				return (
					result.changes.find((item) => item.includeInExecutionPatch)
						?.changeSetId ??
					result.changes[0]?.changeSetId ??
					null
				);
			});
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
		setPatchesById({});
		setPatchErrorsById({});
		setSelectedChangeSetId(null);
		setForceRenderLargeDiff(false);
		setShowAllFiles(false);
		setPendingSync(false);
		setPendingRetries(0);
		void loadChanges();
	}, [loadChanges]);

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
			void loadChanges();
		}, 3000);
		return () => clearTimeout(timeout);
	}, [loadChanges, pendingRetries, pendingSync]);

	const selectedMetadata = useMemo(
		() =>
			changes.find((item) => item.changeSetId === selectedChangeSetId) ?? null,
		[changes, selectedChangeSetId],
	);

	const visibleChanges = useMemo(() => {
		if (showBaselineArtifacts) {
			return changes;
		}
		return changes.filter((item) => item.includeInExecutionPatch);
	}, [changes, showBaselineArtifacts]);

	useEffect(() => {
		setSelectedChangeSetId((current) => {
			if (
				current &&
				visibleChanges.some((item) => item.changeSetId === current)
			) {
				return current;
			}
			return visibleChanges[0]?.changeSetId ?? null;
		});
	}, [visibleChanges]);

	useEffect(() => {
		setShowAllFiles(false);
	}, [selectedChangeSetId]);

	const selectedPatch = selectedChangeSetId
		? patchesById[selectedChangeSetId]
		: undefined;

	const loadPatch = useCallback(
		async (changeSetId: string) => {
			if (patchesById[changeSetId] || loadingPatchId === changeSetId) {
				return;
			}
			setLoadingPatchId(changeSetId);
			try {
				const result = await api.workflow.getExecutionChangeById(
					executionId,
					changeSetId,
				);
				setPatchesById((current) => ({
					...current,
					[changeSetId]: result.patch || "",
				}));
				setPatchErrorsById((current) => {
					if (!(changeSetId in current)) {
						return current;
					}
					const next = { ...current };
					delete next[changeSetId];
					return next;
				});
			} catch (patchError) {
				setPatchErrorsById((current) => ({
					...current,
					[changeSetId]:
						patchError instanceof Error
							? patchError.message
							: "Failed to load patch",
				}));
			} finally {
				setLoadingPatchId((current) =>
					current === changeSetId ? null : current,
				);
			}
		},
		[executionId, loadingPatchId, patchesById],
	);

	useEffect(() => {
		if (!selectedChangeSetId) {
			return;
		}
		void loadPatch(selectedChangeSetId);
	}, [loadPatch, selectedChangeSetId]);

	const filteredChanges = useMemo(() => {
		const query = search.trim().toLowerCase();
		if (!query) {
			return visibleChanges;
		}
		return visibleChanges.filter((change) => {
			const op = change.operation.toLowerCase();
			if (op.includes(query)) {
				return true;
			}
			return change.files.some((file) =>
				file.path.toLowerCase().includes(query),
			);
		});
	}, [search, visibleChanges]);

	const summary = useMemo(() => {
		return visibleChanges.reduce(
			(acc, current) => ({
				files: acc.files + current.filesChanged,
				additions: acc.additions + current.additions,
				deletions: acc.deletions + current.deletions,
				artifacts: acc.artifacts + 1,
			}),
			{ files: 0, additions: 0, deletions: 0, artifacts: 0 },
		);
	}, [visibleChanges]);

	const baselineArtifactsCount = useMemo(
		() => changes.filter((item) => !item.includeInExecutionPatch).length,
		[changes],
	);

	const selectedFileStatusSummary = useMemo(
		() => summarizeFileStatuses(selectedMetadata?.files ?? []),
		[selectedMetadata],
	);

	const selectedVisibleFiles = useMemo(() => {
		if (!selectedMetadata) {
			return [];
		}
		if (showAllFiles) {
			return selectedMetadata.files;
		}
		return selectedMetadata.files.slice(0, FILE_PREVIEW_LIMIT);
	}, [selectedMetadata, showAllFiles]);

	const selectedFilesTruncated = Boolean(
		selectedMetadata &&
			selectedMetadata.files.length > selectedVisibleFiles.length,
	);

	const selectedLargeFileset = Boolean(
		selectedMetadata &&
			(selectedMetadata.operation === "clone" ||
				selectedMetadata.files.length >= LARGE_FILESET_THRESHOLD),
	);

	const selectedPatchBytes = selectedMetadata?.bytes ?? 0;
	const diffTooLarge =
		selectedPatchBytes > VISUAL_DIFF_LIMIT_BYTES && !forceRenderLargeDiff;

	const patchSections = useMemo(() => {
		if (!selectedPatch || diffTooLarge) {
			return [];
		}
		return splitUnifiedPatchFiles(selectedPatch);
	}, [diffTooLarge, selectedPatch]);

	const copyPatch = useCallback(async () => {
		if (!selectedPatch) {
			return;
		}
		try {
			await navigator.clipboard.writeText(selectedPatch);
			setCopied(true);
			toast.success("Patch copied");
			setTimeout(() => setCopied(false), 1500);
		} catch {
			toast.error("Failed to copy patch");
		}
	}, [selectedPatch]);

	const copyApplyCommand = useCallback(async () => {
		if (!selectedMetadata) {
			return;
		}
		const filename = `${selectedMetadata.changeSetId}.patch`;
		const command = selectedMetadata.baseRevision
			? `git checkout ${selectedMetadata.baseRevision}\ngit apply ${filename}`
			: `git apply ${filename}`;
		try {
			await navigator.clipboard.writeText(command);
			toast.success("git apply command copied");
		} catch {
			toast.error("Failed to copy command");
		}
	}, [selectedMetadata]);

	const downloadSelectedPatch = useCallback(() => {
		if (!selectedPatch || !selectedMetadata) {
			return;
		}
		downloadTextFile(selectedPatch, `${selectedMetadata.changeSetId}.patch`);
	}, [selectedMetadata, selectedPatch]);

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

	if (isLoading) {
		return (
			<div className="rounded-lg border bg-background p-4">
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<Loader2 className="h-4 w-4 animate-spin" />
					Loading file changes...
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
				<div className="mb-3 text-destructive text-sm">{error}</div>
				<Button onClick={() => void loadChanges()} size="sm" variant="outline">
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
					<div className="mt-2 flex items-center gap-2 text-muted-foreground text-sm">
						<Loader2 className="h-4 w-4 animate-spin" />
						Changes are still being indexed. Retrying...
					</div>
				) : (
					<div className="mt-2 text-muted-foreground text-sm">
						This run did not persist any workspace file changes.
					</div>
				)}
			</div>
		);
	}

	if (visibleChanges.length === 0) {
		return (
			<div className="space-y-3 rounded-lg border bg-background p-4">
				<div className="font-medium text-sm">File Changes</div>
				<div className="text-muted-foreground text-sm">
					This run has baseline clone artifacts only. No editable file-change
					artifacts were recorded.
				</div>
				{baselineArtifactsCount > 0 && (
					<Button
						onClick={() => setShowBaselineArtifacts(true)}
						size="sm"
						variant="outline"
					>
						Show Baseline Artifacts ({baselineArtifactsCount})
					</Button>
				)}
			</div>
		);
	}

	const selectedPatchError = selectedChangeSetId
		? patchErrorsById[selectedChangeSetId]
		: null;
	const isPatchLoading = selectedChangeSetId === loadingPatchId;

	return (
		<div
			className="space-y-4 rounded-lg border bg-background p-4"
			id="file-changes"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="font-semibold text-lg">File Changes</h2>
					<p className="text-muted-foreground text-xs">
						Showing editable artifacts by default. Baseline clone artifacts are
						optional.
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<div className="flex items-center gap-2">
						<Switch
							checked={showBaselineArtifacts}
							id="toggle-baseline-artifacts"
							onCheckedChange={setShowBaselineArtifacts}
						/>
						<label
							className="text-muted-foreground text-xs"
							htmlFor="toggle-baseline-artifacts"
						>
							Show baseline clone artifacts ({baselineArtifactsCount})
						</label>
					</div>
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
						Download Combined Patch
					</Button>
				</div>
			</div>

			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<div className="rounded-md border bg-muted/30 p-3">
					<div className="text-muted-foreground text-xs">Artifacts</div>
					<div className="mt-1 font-semibold text-lg">{summary.artifacts}</div>
				</div>
				<div className="rounded-md border bg-muted/30 p-3">
					<div className="text-muted-foreground text-xs">Files Changed</div>
					<div className="mt-1 font-semibold text-lg">{summary.files}</div>
				</div>
				<div className="rounded-md border bg-muted/30 p-3">
					<div className="text-muted-foreground text-xs">Additions</div>
					<div className="mt-1 font-semibold text-emerald-600 text-lg dark:text-emerald-300">
						+{summary.additions}
					</div>
				</div>
				<div className="rounded-md border bg-muted/30 p-3">
					<div className="text-muted-foreground text-xs">Deletions</div>
					<div className="mt-1 font-semibold text-lg text-rose-600 dark:text-rose-300">
						-{summary.deletions}
					</div>
				</div>
			</div>

			<div className="grid gap-4 lg:grid-cols-[320px,1fr]">
				<div className="space-y-3">
					<div className="relative">
						<Search className="-translate-y-1/2 absolute top-1/2 left-2 h-4 w-4 text-muted-foreground" />
						<Input
							className="pl-8"
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search files or operation..."
							value={search}
						/>
					</div>

					<div className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
						{filteredChanges.length === 0 && (
							<div className="rounded border border-dashed p-3 text-muted-foreground text-sm">
								No artifacts match your filter.
							</div>
						)}
						{filteredChanges.map((change) => {
							const isSelected = selectedChangeSetId === change.changeSetId;
							return (
								<button
									className={cn(
										"w-full rounded-md border p-3 text-left transition-colors",
										isSelected
											? "border-primary bg-primary/5"
											: "hover:bg-muted/50",
									)}
									key={change.changeSetId}
									onClick={() => {
										setSelectedChangeSetId(change.changeSetId);
										setForceRenderLargeDiff(false);
									}}
									type="button"
								>
									<div className="mb-2 flex items-center justify-between gap-2">
										<div className="truncate font-medium text-sm">
											{change.operation}
										</div>
										<div className="flex items-center gap-1">
											{!change.includeInExecutionPatch && (
												<span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
													baseline
												</span>
											)}
											<div className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
												#{change.sequence}
											</div>
										</div>
									</div>
									<div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs">
										<FileDiff className="h-3.5 w-3.5" />
										<span>{change.filesChanged} files</span>
										<span>•</span>
										<span>+{change.additions}</span>
										<span>/-{change.deletions}</span>
									</div>
									<div className="font-mono text-[11px] text-muted-foreground">
										{change.changeSetId}
									</div>
								</button>
							);
						})}
					</div>
				</div>

				<div className="min-w-0 rounded-md border">
					{selectedMetadata ? (
						<div className="space-y-4 p-4">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<div>
									<div className="font-medium">
										{selectedMetadata.operation}
									</div>
									<div className="font-mono text-muted-foreground text-xs">
										{selectedMetadata.changeSetId}
									</div>
								</div>
								<div className="flex flex-wrap items-center gap-2">
									<Button
										disabled={!selectedPatch}
										onClick={() => void copyPatch()}
										size="sm"
										variant="outline"
									>
										{copied ? (
											<Check className="mr-2 h-3.5 w-3.5" />
										) : (
											<Copy className="mr-2 h-3.5 w-3.5" />
										)}
										Copy Patch
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
									<Button
										onClick={() => void copyApplyCommand()}
										size="sm"
										variant="outline"
									>
										<FileCode2 className="mr-2 h-3.5 w-3.5" />
										Copy git apply
									</Button>
								</div>
							</div>

							<div className="space-y-2 rounded-md border bg-muted/20 p-3">
								<div className="flex flex-wrap items-center justify-between gap-2">
									<div className="font-medium text-sm">
										Files in artifact ({selectedMetadata.files.length})
									</div>
									<div className="text-muted-foreground text-xs">
										{selectedLargeFileset
											? "Large baseline-sized file set"
											: "Focused edit set"}
									</div>
								</div>
								<div className="flex flex-wrap items-center gap-2">
									{Object.entries(selectedFileStatusSummary).map(
										([status, count]) => (
											<span
												className={cn(
													"inline-flex items-center gap-1 rounded px-2 py-1 text-[11px]",
													statusClass(status),
												)}
												key={status}
											>
												<span className="font-semibold">{status}</span>
												<span>{count}</span>
												<span className="opacity-80">
													{statusLabel(status)}
												</span>
											</span>
										),
									)}
								</div>
								<div className="max-h-[220px] overflow-auto rounded border bg-background">
									<div className="divide-y">
										{selectedVisibleFiles.map((file, index) => (
											<div
												className="flex items-start gap-3 px-3 py-1.5 font-mono text-xs"
												key={`${file.status}-${file.path}-${index}`}
											>
												<span
													className={cn(
														"inline-flex min-w-5 justify-center rounded px-1 py-0.5 font-semibold",
														statusClass(file.status),
													)}
												>
													{file.status}
												</span>
												<span className="break-all">{file.path}</span>
											</div>
										))}
									</div>
								</div>
								{selectedFilesTruncated && (
									<div className="flex items-center justify-between gap-2">
										<div className="text-muted-foreground text-xs">
											Showing {selectedVisibleFiles.length} of{" "}
											{selectedMetadata.files.length} files
										</div>
										<Button
											onClick={() => setShowAllFiles((current) => !current)}
											size="sm"
											variant="outline"
										>
											{showAllFiles ? "Show first 100" : "Show all files"}
										</Button>
									</div>
								)}
							</div>

							<Tabs onValueChange={setTab} value={tab}>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<TabsList>
										<TabsTrigger value="diff">Diff</TabsTrigger>
										<TabsTrigger value="raw">Raw Patch</TabsTrigger>
										<TabsTrigger value="metadata">Metadata</TabsTrigger>
									</TabsList>
								</div>

								<TabsContent className="mt-3" value="diff">
									{isPatchLoading && (
										<div className="flex items-center gap-2 text-muted-foreground text-sm">
											<Loader2 className="h-4 w-4 animate-spin" />
											Loading patch...
										</div>
									)}

									{selectedPatchError && (
										<div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
											{selectedPatchError}
										</div>
									)}

									{!isPatchLoading && !selectedPatchError && diffTooLarge && (
										<div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
											<div className="font-medium text-sm">
												Visual diff disabled for large patch
											</div>
											<div className="mt-1 text-muted-foreground text-sm">
												This patch is {formatBytes(selectedMetadata.bytes)}.
												Load it only if needed to avoid UI slowdown.
											</div>
											<Button
												className="mt-3"
												onClick={() => setForceRenderLargeDiff(true)}
												size="sm"
												variant="outline"
											>
												Render Patch Preview
											</Button>
										</div>
									)}

									{!isPatchLoading &&
										!selectedPatchError &&
										!diffTooLarge &&
										selectedPatch && (
											<div className="max-h-[560px] overflow-auto rounded-md border p-2">
												{patchSections.length === 0 ? (
													<div className="p-3 text-muted-foreground text-sm">
														No patch sections found. Use the Raw Patch tab.
													</div>
												) : (
													<div className="space-y-4">
														{patchSections.map((section, fileIndex) => {
															const fileKey = `${section.path}-${fileIndex}`;
															return (
																<div
																	className="overflow-hidden rounded-md border"
																	key={fileKey}
																>
																	<div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
																		<div className="font-mono text-xs">
																			{section.path}
																		</div>
																		<div className="text-muted-foreground text-xs">
																			{section.type}
																		</div>
																	</div>
																	<pre className="overflow-x-auto p-2 font-mono text-xs leading-5">
																		{section.lines.map((line, lineIndex) => (
																			<div
																				className={cn(
																					"whitespace-pre-wrap break-all px-2",
																					patchLineClass(line),
																				)}
																				key={`${fileKey}-${lineIndex}`}
																			>
																				{line || " "}
																			</div>
																		))}
																	</pre>
																</div>
															);
														})}
													</div>
												)}
											</div>
										)}
								</TabsContent>

								<TabsContent className="mt-3" value="raw">
									{isPatchLoading ? (
										<div className="flex items-center gap-2 text-muted-foreground text-sm">
											<Loader2 className="h-4 w-4 animate-spin" />
											Loading patch...
										</div>
									) : selectedPatchError ? (
										<div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
											{selectedPatchError}
										</div>
									) : (
										<div className="overflow-hidden rounded-md border">
											<CodeEditor
												height="560px"
												language="diff"
												options={{
													minimap: { enabled: false },
													readOnly: true,
													scrollBeyondLastLine: false,
													wordWrap: "off",
												}}
												value={selectedPatch || ""}
											/>
										</div>
									)}
								</TabsContent>

								<TabsContent className="mt-3" value="metadata">
									<div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
										<div className="flex items-center justify-between gap-2">
											<span className="text-muted-foreground">Bytes</span>
											<span>{formatBytes(selectedMetadata.bytes)}</span>
										</div>
										<div className="flex items-center justify-between gap-2">
											<span className="text-muted-foreground">SHA256</span>
											<span className="font-mono text-xs">
												{selectedMetadata.sha256}
											</span>
										</div>
										<div className="flex items-center justify-between gap-2">
											<span className="text-muted-foreground">Storage Ref</span>
											<span className="font-mono text-xs">
												{selectedMetadata.storageRef}
											</span>
										</div>
										<div className="flex items-center justify-between gap-2">
											<span className="text-muted-foreground">Created</span>
											<span>
												{new Date(selectedMetadata.createdAt).toLocaleString()}
											</span>
										</div>
										{selectedMetadata.baseRevision && (
											<div className="flex items-center justify-between gap-2">
												<span className="inline-flex items-center gap-1 text-muted-foreground">
													<GitCommit className="h-3.5 w-3.5" />
													Base
												</span>
												<span className="font-mono text-xs">
													{selectedMetadata.baseRevision}
												</span>
											</div>
										)}
										{selectedMetadata.headRevision && (
											<div className="flex items-center justify-between gap-2">
												<span className="inline-flex items-center gap-1 text-muted-foreground">
													<GitPullRequest className="h-3.5 w-3.5" />
													Head
												</span>
												<span className="font-mono text-xs">
													{selectedMetadata.headRevision}
												</span>
											</div>
										)}
									</div>
								</TabsContent>
							</Tabs>
						</div>
					) : (
						<div className="p-4 text-muted-foreground text-sm">
							Select a change artifact to inspect file changes.
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
