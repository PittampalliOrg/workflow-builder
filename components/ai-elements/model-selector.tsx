"use client";

import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Check, ChevronsUpDown, BrainCircuit } from "lucide-react";
import { useMemo, useState } from "react";

// ── Provider Icons ────────────────────────────────────────────

function OpenAIIcon({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
		</svg>
	);
}

function AnthropicIcon({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M17.304 3.541h-3.672l6.696 16.918h3.672zm-10.608 0L0 20.459h3.744l1.37-3.553h7.005l1.369 3.553h3.744L10.536 3.541zm-.372 10.339l2.544-6.602 2.544 6.602z" />
		</svg>
	);
}

function GoogleIcon({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
			<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
			<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
			<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
		</svg>
	);
}

function MetaIcon({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a4.908 4.908 0 0 0 1.708 2.728c.68.528 1.471.813 2.308.813 1.018 0 1.907-.39 2.653-1.064.603-.544 1.122-1.256 1.6-2.1C9.469 14.939 10.7 12.36 12 9.82c.897-1.75 1.84-3.318 2.903-4.382.723-.724 1.494-1.2 2.336-1.34a4.556 4.556 0 0 0-.917-.068c-1.032 0-1.998.398-2.818 1.082-.746.623-1.39 1.467-1.97 2.444-1.227 2.065-2.36 4.726-3.54 7.347-.49 1.09-1.034 2.012-1.588 2.646-.603.69-1.17.968-1.757.968-.442 0-.84-.187-1.174-.554-.372-.408-.62-.98-.74-1.678a8.14 8.14 0 0 1-.098-1.254c0-2.265.608-4.667 1.695-6.46.965-1.593 2.188-2.59 3.504-2.59.384 0 .743.073 1.076.217l.145-.637a4.326 4.326 0 0 0-1.057-.191zm10.162 0c-1.823 0-3.41 1.313-4.546 3.198-1.247 2.07-2.04 4.855-2.04 7.534 0 2.116.497 3.807 1.382 4.978.749.99 1.727 1.494 2.823 1.494 1.021 0 1.928-.412 2.674-1.072.605-.536 1.123-1.24 1.6-2.082.948-1.673 1.73-3.768 2.547-5.89.369-.96.654-1.85.895-2.626.205-.66.377-1.285.494-1.852.093-.449.142-.864.142-1.215 0-1.135-.318-2.017-.895-2.626-.494-.523-1.145-.841-1.88-.841a2.45 2.45 0 0 0-.426.038c.263.392.482.868.625 1.413.105.4.16.834.16 1.305 0 .487-.091 1.049-.261 1.685-.2.749-.47 1.567-.817 2.472-.797 2.08-1.564 4.12-2.482 5.743-.444.785-.9 1.395-1.382 1.832-.402.364-.826.585-1.273.585-.468 0-.846-.249-1.14-.704-.342-.53-.518-1.298-.518-2.29 0-2.319.662-4.862 1.716-6.723.933-1.646 2.06-2.653 3.217-2.653.324 0 .624.063.901.186l.147-.653a3.29 3.29 0 0 0-.864-.156z" />
		</svg>
	);
}

const PROVIDER_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
	openai: OpenAIIcon,
	anthropic: AnthropicIcon,
	google: GoogleIcon,
	meta: MetaIcon,
};

/**
 * Infer provider from a model ID string.
 * e.g. "openai/gpt-4o" -> "openai", "claude-opus-4-6" -> "anthropic"
 */
function inferProvider(modelId: string): string | undefined {
	if (modelId.includes("/")) {
		return modelId.split("/")[0];
	}
	if (modelId.startsWith("gpt-") || modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4")) return "openai";
	if (modelId.startsWith("claude-")) return "anthropic";
	if (modelId.startsWith("gemini-")) return "google";
	if (modelId.startsWith("llama-") || modelId.startsWith("llama3")) return "meta";
	return undefined;
}

function ProviderIcon({ provider, className }: { provider?: string; className?: string }) {
	if (!provider) return <BrainCircuit className={className} />;
	const Icon = PROVIDER_ICONS[provider];
	if (Icon) return <Icon className={className} />;
	return <BrainCircuit className={className} />;
}

// ── Component ─────────────────────────────────────────────────

export type ModelOption = {
	id: string;
	name: string;
	provider?: string;
	description?: string;
};

export type ModelSelectorProps = {
	models: ModelOption[];
	selectedModel: ModelOption | null;
	onModelChange: (model: ModelOption) => void;
	placeholder?: string;
	disabled?: boolean;
	className?: string;
};

/**
 * ModelSelector
 *
 * UI component inspired by Vercel AI Elements:
 * https://elements.ai-sdk.dev/components/model-selector
 */
export function ModelSelector({
	models,
	selectedModel,
	onModelChange,
	placeholder = "Select a model",
	disabled,
	className,
}: ModelSelectorProps) {
	const [open, setOpen] = useState(false);

	const selectedProvider = useMemo(
		() => selectedModel?.provider ?? inferProvider(selectedModel?.id ?? ""),
		[selectedModel],
	);

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger asChild>
				<Button
					aria-expanded={open}
					className={cn(
						"w-full justify-between",
						!selectedModel && "text-muted-foreground",
						className,
					)}
					disabled={disabled}
					role="combobox"
					type="button"
					variant="outline"
				>
					<span className="flex items-center gap-2 truncate">
						{selectedModel && (
							<ProviderIcon
								provider={selectedProvider}
								className="h-4 w-4 shrink-0"
							/>
						)}
						<span className="truncate">
							{selectedModel ? selectedModel.name : placeholder}
						</span>
					</span>
					<ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-0">
				<Command>
					<CommandInput placeholder="Search models..." />
					<CommandList>
						<CommandEmpty>No models found.</CommandEmpty>
						<CommandGroup>
							{models.map((model) => {
								const isSelected = selectedModel?.id === model.id;
								const provider = model.provider ?? inferProvider(model.id);
								return (
									<CommandItem
										key={model.id}
										onSelect={() => {
											onModelChange(model);
											setOpen(false);
										}}
										value={`${model.name} ${model.id}`}
									>
										<Check
											className={cn(
												"mr-2 h-4 w-4 shrink-0",
												isSelected ? "opacity-100" : "opacity-0",
											)}
										/>
										<ProviderIcon
											provider={provider}
											className="mr-2 h-4 w-4 shrink-0"
										/>
										<div className="min-w-0">
											<div className="truncate">{model.name}</div>
											{model.description ? (
												<div className="truncate text-muted-foreground text-xs">
													{model.description}
												</div>
											) : null}
										</div>
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
