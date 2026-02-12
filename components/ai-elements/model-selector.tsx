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
import { Check, ChevronsUpDown } from "lucide-react";
import { useMemo, useState } from "react";

export type ModelOption = {
	id: string;
	name: string;
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

	const selectedLabel = useMemo(() => {
		if (selectedModel) {
			return selectedModel.name;
		}
		return placeholder;
	}, [selectedModel, placeholder]);

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
					<span className="truncate">{selectedLabel}</span>
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
												"mr-2 h-4 w-4",
												isSelected ? "opacity-100" : "opacity-0",
											)}
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

