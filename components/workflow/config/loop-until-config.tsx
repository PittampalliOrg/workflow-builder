"use client";

import { useMemo } from "react";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { TemplateBadgeTextarea } from "@/components/ui/template-badge-textarea";
import { useAtomValue } from "jotai";
import { nodesAtom } from "@/lib/workflow-store";

type LoopUntilConfigProps = {
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: string) => void;
	disabled: boolean;
};

type OperatorValue =
	| "EXISTS"
	| "DOES_NOT_EXIST"
	| "TEXT_CONTAINS"
	| "TEXT_EXACTLY_MATCHES"
	| "NUMBER_IS_GREATER_THAN"
	| "NUMBER_IS_LESS_THAN"
	| "NUMBER_IS_EQUAL_TO"
	| "BOOLEAN_IS_TRUE"
	| "BOOLEAN_IS_FALSE";

const OPERATORS: Array<{
	label: string;
	value: OperatorValue;
	needsRight: boolean;
}> = [
	{ label: "Exists", value: "EXISTS", needsRight: false },
	{ label: "Does Not Exist", value: "DOES_NOT_EXIST", needsRight: false },
	{ label: "Text Contains", value: "TEXT_CONTAINS", needsRight: true },
	{
		label: "Text Exactly Matches",
		value: "TEXT_EXACTLY_MATCHES",
		needsRight: true,
	},
	{ label: "Number >", value: "NUMBER_IS_GREATER_THAN", needsRight: true },
	{ label: "Number <", value: "NUMBER_IS_LESS_THAN", needsRight: true },
	{ label: "Number =", value: "NUMBER_IS_EQUAL_TO", needsRight: true },
	{ label: "Is True", value: "BOOLEAN_IS_TRUE", needsRight: false },
	{ label: "Is False", value: "BOOLEAN_IS_FALSE", needsRight: false },
];

export function LoopUntilConfig({
	config,
	onUpdateConfig,
	disabled,
}: LoopUntilConfigProps) {
	const nodes = useAtomValue(nodesAtom);

	const startNodeOptions = useMemo(() => {
		return nodes
			.filter((n) => n.type !== "add" && n.type !== "trigger")
			.map((n) => ({
				id: n.id,
				label: (n.data?.label || n.id).trim(),
				type: n.type,
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	}, [nodes]);

	const operator = (config.operator as OperatorValue) || "EXISTS";
	const operatorMeta =
		OPERATORS.find((o) => o.value === operator) || OPERATORS[0];

	const onMaxIterations = (config.onMaxIterations as string) || "fail";

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="loopStartNodeId">Loop Start Node</Label>
				<Select
					disabled={disabled}
					onValueChange={(value) => onUpdateConfig("loopStartNodeId", value)}
					value={(config.loopStartNodeId as string) || ""}
				>
					<SelectTrigger className="w-full" id="loopStartNodeId">
						<SelectValue placeholder="Select the first node to repeat" />
					</SelectTrigger>
					<SelectContent>
						{startNodeOptions.map((opt) => (
							<SelectItem key={opt.id} value={opt.id}>
								{opt.label} ({opt.type})
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-muted-foreground text-xs">
					The workflow will jump back to this node when the stop condition is
					not met.
				</p>
			</div>

			<div className="space-y-2">
				<Label htmlFor="maxIterations">Max Iterations</Label>
				<Input
					disabled={disabled}
					id="maxIterations"
					min={1}
					onChange={(e) => onUpdateConfig("maxIterations", e.target.value)}
					type="number"
					value={String(config.maxIterations ?? 10)}
				/>
			</div>

			<div className="space-y-2">
				<Label htmlFor="delaySeconds">Delay Between Iterations (seconds)</Label>
				<Input
					disabled={disabled}
					id="delaySeconds"
					min={0}
					onChange={(e) => onUpdateConfig("delaySeconds", e.target.value)}
					type="number"
					value={String(config.delaySeconds ?? 0)}
				/>
			</div>

			<div className="space-y-2">
				<Label htmlFor="onMaxIterations">On Max Iterations</Label>
				<Select
					disabled={disabled}
					onValueChange={(value) => onUpdateConfig("onMaxIterations", value)}
					value={onMaxIterations}
				>
					<SelectTrigger className="w-full" id="onMaxIterations">
						<SelectValue placeholder="Select behavior" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="fail">Fail workflow</SelectItem>
						<SelectItem value="continue">Continue (exit loop)</SelectItem>
					</SelectContent>
				</Select>
			</div>

			<div className="space-y-2">
				<Label htmlFor="operator">Stop Condition Operator</Label>
				<Select
					disabled={disabled}
					onValueChange={(value) =>
						onUpdateConfig("operator", value as unknown as string)
					}
					value={operator}
				>
					<SelectTrigger className="w-full" id="operator">
						<SelectValue placeholder="Select operator" />
					</SelectTrigger>
					<SelectContent>
						{OPERATORS.map((op) => (
							<SelectItem key={op.value} value={op.value}>
								{op.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="space-y-2">
				<Label htmlFor="left">Left Value</Label>
				<TemplateBadgeInput
					disabled={disabled}
					id="left"
					onChange={(value) => onUpdateConfig("left", value)}
					placeholder="e.g. {{@nodeId:Step.field}}"
					value={(config.left as string) || ""}
				/>
			</div>

			{operatorMeta.needsRight && (
				<div className="space-y-2">
					<Label htmlFor="right">Right Value</Label>
					<TemplateBadgeInput
						disabled={disabled}
						id="right"
						onChange={(value) => onUpdateConfig("right", value)}
						placeholder="e.g. 200 or success"
						value={(config.right as string) || ""}
					/>
				</div>
			)}

			<div className="space-y-2">
				<Label htmlFor="notes">Notes (optional)</Label>
				<TemplateBadgeTextarea
					disabled={disabled}
					id="notes"
					onChange={(value) => onUpdateConfig("notes", value)}
					placeholder="Explain what the loop is doing and what stops it."
					rows={3}
					value={(config.notes as string) || ""}
				/>
			</div>
		</div>
	);
}
