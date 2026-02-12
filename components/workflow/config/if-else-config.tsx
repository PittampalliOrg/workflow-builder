"use client";

import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";

type IfElseConfigProps = {
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

export function IfElseConfig({
	config,
	onUpdateConfig,
	disabled,
}: IfElseConfigProps) {
	const operator = (config.operator as OperatorValue) || "EXISTS";
	const operatorMeta =
		OPERATORS.find((o) => o.value === operator) || OPERATORS[0];

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="operator">Operator</Label>
				<Select
					disabled={disabled}
					onValueChange={(value) => onUpdateConfig("operator", value)}
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

			{operatorMeta.needsRight ? (
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
			) : null}

			<p className="text-muted-foreground text-xs">
				Connect the <span className="font-medium">true</span> or{" "}
				<span className="font-medium">false</span> output handle to build
				branches.
			</p>
		</div>
	);
}
