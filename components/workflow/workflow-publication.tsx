"use client";

import { formatDistanceToNow } from "date-fns";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type PublishedWorkflowRevisionDetail } from "@/lib/api-client";
import type { PublishedRuntimeMetadata } from "@/lib/workflow-spec/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";

function formatPublishedTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "Unknown";
	}
	return formatDistanceToNow(date, { addSuffix: true });
}

function publicationBadgeClasses(
	isPublished: boolean,
	compact?: boolean,
): string {
	return cn(
		"h-6 rounded-full px-2.5 font-medium text-[11px] uppercase tracking-wide",
		compact && "h-5 px-2 text-[10px]",
		isPublished
			? "border-transparent bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300"
			: "border-transparent bg-muted text-muted-foreground",
	);
}

type WorkflowPublicationBadgeProps = {
	compact?: boolean;
	publishedRuntime?: PublishedRuntimeMetadata | null;
};

export function WorkflowPublicationBadge({
	compact,
	publishedRuntime,
}: WorkflowPublicationBadgeProps) {
	const isPublished = Boolean(publishedRuntime);

	return (
		<Badge
			className={publicationBadgeClasses(isPublished, compact)}
			variant="outline"
		>
			{isPublished ? "Published" : "Draft"}
		</Badge>
	);
}

type WorkflowPublicationStatusProps = {
	workflowId: string;
	workflowName: string;
	publishedRuntime?: PublishedRuntimeMetadata | null;
};

export function WorkflowPublicationStatus({
	workflowId,
	workflowName,
	publishedRuntime,
}: WorkflowPublicationStatusProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedVersion, setSelectedVersion] = useState<string | null>(
		publishedRuntime?.latestVersion ?? null,
	);
	const [detailByVersion, setDetailByVersion] = useState<
		Record<string, PublishedWorkflowRevisionDetail["revision"]>
	>({});

	const revisions = publishedRuntime?.revisions ?? [];
	const activeVersion =
		selectedVersion ?? publishedRuntime?.latestVersion ?? null;
	const activeRevision = activeVersion ? detailByVersion[activeVersion] : null;

	useEffect(() => {
		setSelectedVersion(publishedRuntime?.latestVersion ?? null);
	}, [publishedRuntime?.latestVersion]);

	useEffect(() => {
		if (!isOpen || !publishedRuntime?.latestVersion) {
			return;
		}
		if (detailByVersion[publishedRuntime.latestVersion]) {
			return;
		}

		let cancelled = false;
		const loadLatestRevision = async () => {
			setIsLoading(true);
			setError(null);
			try {
				const detail = await api.workflow.getPublishedRevision(
					workflowId,
					"latest",
				);
				if (cancelled) {
					return;
				}
				setDetailByVersion((current) => ({
					...current,
					[detail.revision.version]: detail.revision,
				}));
				setSelectedVersion(detail.revision.version);
			} catch (loadError) {
				if (!cancelled) {
					setError(
						loadError instanceof Error
							? loadError.message
							: "Failed to load published revision",
					);
				}
			} finally {
				if (!cancelled) {
					setIsLoading(false);
				}
			}
		};

		void loadLatestRevision();

		return () => {
			cancelled = true;
		};
	}, [detailByVersion, isOpen, publishedRuntime?.latestVersion, workflowId]);

	const orderedRevisions = useMemo(
		() =>
			[...revisions].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
		[revisions],
	);

	const handleVersionSelect = async (version: string) => {
		setSelectedVersion(version);
		if (detailByVersion[version]) {
			return;
		}
		setIsLoading(true);
		setError(null);
		try {
			const detail = await api.workflow.getPublishedRevision(
				workflowId,
				version,
			);
			setDetailByVersion((current) => ({
				...current,
				[detail.revision.version]: detail.revision,
			}));
			setSelectedVersion(detail.revision.version);
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: "Failed to load published revision",
			);
		} finally {
			setIsLoading(false);
		}
	};

	if (!publishedRuntime) {
		return <WorkflowPublicationBadge publishedRuntime={null} />;
	}

	return (
		<Popover onOpenChange={setIsOpen} open={isOpen}>
			<PopoverTrigger asChild>
				<button
					className="rounded-full transition-opacity hover:opacity-90"
					type="button"
				>
					<WorkflowPublicationBadge publishedRuntime={publishedRuntime} />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[28rem] p-0">
				<div className="border-b px-4 py-3">
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<div className="font-medium text-sm">{workflowName}</div>
							<div className="mt-1 text-muted-foreground text-xs">
								Dapr workflow:{" "}
								<span className="font-mono">
									{publishedRuntime.workflowName}
								</span>
							</div>
						</div>
						<WorkflowPublicationBadge publishedRuntime={publishedRuntime} />
					</div>
					<div className="mt-3 flex flex-wrap gap-2 text-xs">
						<Badge className="font-mono" variant="secondary">
							{publishedRuntime.latestVersion}
						</Badge>
						<Badge variant="outline">
							Updated {formatPublishedTime(publishedRuntime.publishedAt)}
						</Badge>
					</div>
				</div>

				<div className="grid gap-4 p-4 md:grid-cols-[12rem_1fr]">
					<div className="space-y-2">
						<div className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
							Published revisions
						</div>
						<div className="max-h-56 space-y-1 overflow-y-auto">
							{orderedRevisions.map((revision) => {
								const isActive = revision.version === activeVersion;
								return (
									<Button
										className="h-auto w-full items-start justify-start px-3 py-2 text-left"
										key={revision.version}
										onClick={() => void handleVersionSelect(revision.version)}
										size="sm"
										variant={isActive ? "secondary" : "ghost"}
									>
										<div className="min-w-0">
											<div className="font-mono text-[11px]">
												{revision.version}
											</div>
											<div className="mt-1 text-muted-foreground text-xs">
												{formatPublishedTime(revision.publishedAt)}
											</div>
										</div>
									</Button>
								);
							})}
						</div>
					</div>

					<div className="space-y-3">
						<div className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
							Frozen definition
						</div>
						{isLoading && (
							<div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
								<Loader2 className="size-4 animate-spin" />
								Loading published revision…
							</div>
						)}
						{error && (
							<div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm">
								{error}
							</div>
						)}
						{activeRevision && (
							<>
								<div className="flex flex-wrap gap-2 text-xs">
									<Badge className="font-mono" variant="secondary">
										{activeRevision.version}
									</Badge>
									<Badge variant="outline">
										Published {formatPublishedTime(activeRevision.publishedAt)}
									</Badge>
								</div>
								<pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
									{JSON.stringify(activeRevision.definition, null, 2)}
								</pre>
							</>
						)}
						{!isLoading && !error && !activeRevision && (
							<div className="rounded-md border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
								Select a revision to inspect the frozen published definition.
							</div>
						)}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
