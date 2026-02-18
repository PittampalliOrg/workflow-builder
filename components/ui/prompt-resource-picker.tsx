"use client";

import { BookText, Loader2, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type ResourcePromptData } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./dialog";
import { Label } from "./label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./select";
import { Tabs, TabsList, TabsTrigger } from "./tabs";

type PromptPreviewMode = "system" | "user" | "combined";

type PromptResourcePickerProps = {
	disabled?: boolean;
	onInsert: (text: string) => void;
	className?: string;
};

function getPromptPreviewText(
	prompt: ResourcePromptData | undefined,
	mode: PromptPreviewMode,
): string {
	if (!prompt) {
		return "";
	}

	if (mode === "system") {
		return prompt.systemPrompt;
	}

	if (mode === "user") {
		return prompt.userPrompt ?? "";
	}

	if (prompt.promptMode === "system+user" && prompt.userPrompt?.trim()) {
		return `${prompt.systemPrompt}\n\n${prompt.userPrompt}`;
	}

	return prompt.systemPrompt;
}

function getModeLabel(mode: PromptPreviewMode): string {
	if (mode === "system") return "System";
	if (mode === "user") return "User";
	return "Combined";
}

export function PromptResourcePicker({
	disabled,
	onInsert,
	className,
}: PromptResourcePickerProps) {
	const [open, setOpen] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [prompts, setPrompts] = useState<ResourcePromptData[]>([]);
	const [selectedPromptId, setSelectedPromptId] = useState<string>("");
	const [previewMode, setPreviewMode] = useState<PromptPreviewMode>("system");

	useEffect(() => {
		if (!open) {
			return;
		}

		let cancelled = false;
		setIsLoading(true);
		setLoadError(null);

		api.resource.prompts
			.list()
			.then((rows) => {
				if (cancelled) {
					return;
				}
				const enabledRows = rows.filter((row) => row.isEnabled);
				setPrompts(enabledRows);
				setSelectedPromptId((current) =>
					current && enabledRows.some((row) => row.id === current)
						? current
						: enabledRows[0]?.id || "",
				);
			})
			.catch((error) => {
				console.error("Failed to load prompt resources:", error);
				if (!cancelled) {
					setLoadError("Failed to load prompt presets.");
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoading(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [open]);

	const selectedPrompt = useMemo(
		() => prompts.find((row) => row.id === selectedPromptId),
		[prompts, selectedPromptId],
	);
	const previewText = useMemo(
		() => getPromptPreviewText(selectedPrompt, previewMode),
		[selectedPrompt, previewMode],
	);
	const canPreviewUser = Boolean(selectedPrompt?.userPrompt?.trim());

	useEffect(() => {
		if (previewMode === "user" && !canPreviewUser) {
			setPreviewMode("system");
		}
	}, [canPreviewUser, previewMode]);

	const handleInsert = () => {
		if (!previewText.trim()) {
			return;
		}
		onInsert(previewText);
		setOpen(false);
	};

	return (
		<>
			<Button
				className={cn("shrink-0", className)}
				disabled={disabled}
				onClick={() => setOpen(true)}
				size="sm"
				type="button"
				variant="outline"
			>
				<BookText className="mr-1 size-4" />
				Prompt
			</Button>

			<Dialog onOpenChange={setOpen} open={open}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>Insert Prompt Preset</DialogTitle>
					</DialogHeader>

					<div className="space-y-3">
						<div className="space-y-2">
							<Label htmlFor="prompt-resource-picker">Prompt preset</Label>
							<Select
								onValueChange={setSelectedPromptId}
								value={selectedPromptId || undefined}
							>
								<SelectTrigger id="prompt-resource-picker">
									<SelectValue
										placeholder={
											isLoading
												? "Loading prompt presets..."
												: "Select prompt preset"
										}
									/>
								</SelectTrigger>
								<SelectContent>
									{prompts.length === 0 ? (
										<SelectItem disabled value="__none__">
											No prompt presets found
										</SelectItem>
									) : (
										prompts.map((prompt) => (
											<SelectItem key={prompt.id} value={prompt.id}>
												{prompt.name} (v{prompt.version})
											</SelectItem>
										))
									)}
								</SelectContent>
							</Select>
							{loadError ? (
								<p className="text-destructive text-xs">{loadError}</p>
							) : null}
						</div>

						<div className="space-y-2">
							<Label>Preview mode</Label>
							<Tabs
								onValueChange={(next) =>
									setPreviewMode(next as PromptPreviewMode)
								}
								value={previewMode}
							>
								<TabsList>
									<TabsTrigger value="system">System</TabsTrigger>
									<TabsTrigger disabled={!canPreviewUser} value="user">
										User
									</TabsTrigger>
									<TabsTrigger value="combined">Combined</TabsTrigger>
								</TabsList>
							</Tabs>
						</div>

						<div className="space-y-2">
							<Label>Preview</Label>
							<div className="max-h-72 overflow-auto rounded-md border bg-muted/20 p-3">
								{isLoading ? (
									<div className="flex items-center gap-2 text-muted-foreground text-sm">
										<Loader2 className="size-4 animate-spin" />
										Loading prompt presets...
									</div>
								) : previewText ? (
									<pre className="whitespace-pre-wrap font-mono text-sm">
										{previewText}
									</pre>
								) : (
									<p className="text-muted-foreground text-sm">
										Select a preset and preview mode to insert text.
									</p>
								)}
							</div>
						</div>
					</div>

					<DialogFooter>
						<Button onClick={() => setOpen(false)} type="button" variant="ghost">
							Cancel
						</Button>
						<Button
							disabled={!previewText.trim() || isLoading}
							onClick={handleInsert}
							type="button"
						>
							<Plus className="mr-1 size-4" />
							Insert {getModeLabel(previewMode)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
