"use client";

import { useReactFlow } from "@xyflow/react";
import {
	Check,
	GitBranch,
	MapPin,
	MapPinXInside,
	Maximize2,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { useAtom } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DagreLayoutOptions } from "@/lib/workflow-layout/dagre-layout";
import { showMinimapAtom } from "@/lib/workflow-store";

export type AutoLayoutPresetId =
	| "auto"
	| "compact"
	| "flow-left-right"
	| "flow-top-bottom"
	| "elk-left-right"
	| "elk-top-bottom";

type AutoLayoutPreset = {
	id: AutoLayoutPresetId;
	label: string;
	description: string;
	options: Pick<DagreLayoutOptions, "strategy" | "direction" | "maxColumns">;
};

type CompactDensityOption = {
	id: "2" | "3" | "4";
	label: string;
	maxColumns: number;
};

const AUTO_LAYOUT_PRESETS: AutoLayoutPreset[] = [
	{
		id: "auto",
		label: "Auto (Recommended)",
		description: "Compact for chains, flow layout for branches",
		options: { strategy: "auto", direction: "LR", maxColumns: 3 },
	},
	{
		id: "compact",
		label: "Compact Wrap",
		description: "Serpentine rows to use horizontal and vertical space",
		options: { strategy: "compact", direction: "LR", maxColumns: 3 },
	},
	{
		id: "flow-left-right",
		label: "Flow Left to Right",
		description: "Classic DAG flow layout",
		options: { strategy: "dagre", direction: "LR", maxColumns: 3 },
	},
	{
		id: "flow-top-bottom",
		label: "Flow Top to Bottom",
		description: "Vertical DAG flow layout",
		options: { strategy: "dagre", direction: "TB", maxColumns: 3 },
	},
	{
		id: "elk-left-right",
		label: "ELK Left to Right",
		description: "ELK layered layout",
		options: { strategy: "elk", direction: "LR", maxColumns: 3 },
	},
	{
		id: "elk-top-bottom",
		label: "ELK Top to Bottom",
		description: "ELK layered vertical layout",
		options: { strategy: "elk", direction: "TB", maxColumns: 3 },
	},
];

const COMPACT_DENSITY_OPTIONS: CompactDensityOption[] = [
	{ id: "2", label: "Compact: 2 columns", maxColumns: 2 },
	{ id: "3", label: "Compact: 3 columns", maxColumns: 3 },
	{ id: "4", label: "Compact: 4 columns", maxColumns: 4 },
];

type ControlsProps = {
	onAutoArrange?: (
		options: Pick<DagreLayoutOptions, "strategy" | "direction" | "maxColumns">,
	) => void;
	layoutPreferenceKey?: string;
};

type StoredAutoLayoutPreference = {
	presetId: AutoLayoutPresetId;
	compactMaxColumns: number;
};

const DEFAULT_PRESET_ID: AutoLayoutPresetId = "auto";
const DEFAULT_COMPACT_MAX_COLUMNS = 3;

export const Controls = ({
	onAutoArrange,
	layoutPreferenceKey,
}: ControlsProps) => {
	const { zoomIn, zoomOut, fitView } = useReactFlow();
	const [showMinimap, setShowMinimap] = useAtom(showMinimapAtom);
	const [selectedPresetId, setSelectedPresetId] =
		useState<AutoLayoutPresetId>(DEFAULT_PRESET_ID);
	const [compactMaxColumns, setCompactMaxColumns] = useState<number>(
		DEFAULT_COMPACT_MAX_COLUMNS,
	);
	const resolvedPreferenceKey = useMemo(
		() => layoutPreferenceKey ?? "workflow-builder:auto-layout:global",
		[layoutPreferenceKey],
	);

	useEffect(() => {
		try {
			const rawValue = localStorage.getItem(resolvedPreferenceKey);
			if (!rawValue) {
				setSelectedPresetId(DEFAULT_PRESET_ID);
				setCompactMaxColumns(DEFAULT_COMPACT_MAX_COLUMNS);
				return;
			}

			const parsed = JSON.parse(rawValue) as Partial<StoredAutoLayoutPreference>;
			const validPreset = AUTO_LAYOUT_PRESETS.some(
				(preset) => preset.id === parsed.presetId,
			)
				? parsed.presetId
				: DEFAULT_PRESET_ID;
			const validColumns = COMPACT_DENSITY_OPTIONS.some(
				(option) => option.maxColumns === parsed.compactMaxColumns,
			)
				? parsed.compactMaxColumns
				: DEFAULT_COMPACT_MAX_COLUMNS;

			setSelectedPresetId(validPreset ?? DEFAULT_PRESET_ID);
			setCompactMaxColumns(validColumns ?? DEFAULT_COMPACT_MAX_COLUMNS);
		} catch {
			setSelectedPresetId(DEFAULT_PRESET_ID);
			setCompactMaxColumns(DEFAULT_COMPACT_MAX_COLUMNS);
		}
	}, [resolvedPreferenceKey]);

	useEffect(() => {
		const preference: StoredAutoLayoutPreference = {
			presetId: selectedPresetId,
			compactMaxColumns,
		};
		localStorage.setItem(resolvedPreferenceKey, JSON.stringify(preference));
	}, [resolvedPreferenceKey, selectedPresetId, compactMaxColumns]);

	const handleZoomIn = () => {
		zoomIn();
	};

	const handleZoomOut = () => {
		zoomOut();
	};

	const handleFitView = () => {
		fitView({ padding: 0.2, duration: 300 });
	};

	const handleToggleMinimap = () => {
		setShowMinimap(!showMinimap);
	};

	const handleSelectAutoLayoutPreset = (preset: AutoLayoutPreset) => {
		setSelectedPresetId(preset.id);
		onAutoArrange?.({
			...preset.options,
			maxColumns: compactMaxColumns,
		});
	};

	const handleSelectCompactDensity = (density: CompactDensityOption) => {
		setCompactMaxColumns(density.maxColumns);

		const activePreset = AUTO_LAYOUT_PRESETS.find(
			(preset) => preset.id === selectedPresetId,
		);
		if (!activePreset) {
			return;
		}

		onAutoArrange?.({
			...activePreset.options,
			maxColumns: density.maxColumns,
		});
	};

	return (
		<ButtonGroup orientation="vertical">
			<Button
				className="border hover:bg-black/5 disabled:opacity-100 dark:hover:bg-white/5 disabled:[&>svg]:text-muted-foreground"
				onClick={handleZoomIn}
				size="icon"
				title="Zoom in"
				variant="secondary"
			>
				<ZoomIn className="size-4" />
			</Button>
			<Button
				className="border hover:bg-black/5 disabled:opacity-100 dark:hover:bg-white/5 disabled:[&>svg]:text-muted-foreground"
				onClick={handleZoomOut}
				size="icon"
				title="Zoom out"
				variant="secondary"
			>
				<ZoomOut className="size-4" />
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						className="border hover:bg-black/5 disabled:opacity-100 dark:hover:bg-white/5 disabled:[&>svg]:text-muted-foreground"
						disabled={!onAutoArrange}
						size="icon"
						title="Auto-arrange options"
						variant="secondary"
					>
						<GitBranch className="size-4" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" side="right">
					<DropdownMenuLabel>Auto-arrange</DropdownMenuLabel>
					<DropdownMenuSeparator />
					{AUTO_LAYOUT_PRESETS.map((preset) => (
						<DropdownMenuItem
							key={preset.id}
							onSelect={() => handleSelectAutoLayoutPreset(preset)}
						>
							{selectedPresetId === preset.id ? (
								<Check className="size-4" />
							) : (
								<span className="size-4" />
							)}
							<div className="flex flex-col gap-0.5">
								<span>{preset.label}</span>
								<span className="text-muted-foreground text-xs">
									{preset.description}
								</span>
							</div>
						</DropdownMenuItem>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuLabel>Compact Density</DropdownMenuLabel>
					{COMPACT_DENSITY_OPTIONS.map((density) => (
						<DropdownMenuItem
							key={density.id}
							onSelect={() => handleSelectCompactDensity(density)}
						>
							{compactMaxColumns === density.maxColumns ? (
								<Check className="size-4" />
							) : (
								<span className="size-4" />
							)}
							<span>{density.label}</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			<Button
				className="border hover:bg-black/5 disabled:opacity-100 dark:hover:bg-white/5 disabled:[&>svg]:text-muted-foreground"
				onClick={handleFitView}
				size="icon"
				title="Fit view"
				variant="secondary"
			>
				<Maximize2 className="size-4" />
			</Button>
			<Button
				className="border hover:bg-black/5 disabled:opacity-100 dark:hover:bg-white/5 disabled:[&>svg]:text-muted-foreground"
				onClick={handleToggleMinimap}
				size="icon"
				title={showMinimap ? "Hide minimap" : "Show minimap"}
				variant="secondary"
			>
				{showMinimap ? (
					<MapPin className="size-4" />
				) : (
					<MapPinXInside className="size-4" />
				)}
			</Button>
		</ButtonGroup>
	);
};
