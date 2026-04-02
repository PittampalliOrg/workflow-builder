"use client";

/**
 * Configuration panels for CNCF Serverless Workflow 1.0 task types.
 *
 * Each panel appears in the right sidebar when a task node is selected,
 * allowing the user to configure task-specific properties.
 */

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CodeEditor } from "@/components/ui/code-editor";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	FUNCTION_CATALOG,
	getCatalogByCategory,
} from "@/lib/serverless-workflow/function-catalog";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

type TaskConfigProps = {
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: unknown) => void;
	disabled?: boolean;
};

function JsonEditor({
	value,
	onChange,
	disabled,
	height = 160,
}: {
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
	height?: number;
}) {
	return (
		<div className="overflow-hidden rounded-lg border">
			<CodeEditor
				height={`${height}px`}
				language="json"
				onChange={(next) => onChange(next ?? "")}
				options={{
					fontSize: 13,
					lineNumbers: "on",
					minimap: { enabled: false },
					readOnly: disabled,
					scrollBeyondLastLine: false,
					wordWrap: "on",
				}}
				value={value}
			/>
		</div>
	);
}

function TextCodeEditor({
	value,
	onChange,
	disabled,
	height = 140,
	language = "text",
}: {
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
	height?: number;
	language?: string;
}) {
	return (
		<div className="overflow-hidden rounded-lg border">
			<CodeEditor
				height={`${height}px`}
				language={language}
				onChange={(next) => onChange(next ?? "")}
				options={{
					fontSize: 13,
					lineNumbers: "on",
					minimap: { enabled: false },
					readOnly: disabled,
					scrollBeyondLastLine: false,
					wordWrap: "on",
				}}
				value={value}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Call task config
// ---------------------------------------------------------------------------

export function CallTaskConfig({
	config,
	onUpdateConfig,
	disabled,
}: TaskConfigProps) {
	const callProtocol = (config.call as string) || "http";
	const withArgs = (config.with as Record<string, unknown>) || {};

	const isFunction = !["http", "grpc", "openapi", "asyncapi"].includes(
		callProtocol,
	);
	const categories = getCatalogByCategory();

	return (
		<>
			<div className="space-y-2">
				<Label className="ml-1" htmlFor="callType">
					Call Type
				</Label>
				<Select
					disabled={disabled}
					onValueChange={(value) => onUpdateConfig("call", value)}
					value={callProtocol}
				>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="http">HTTP Request</SelectItem>
						<SelectItem value="grpc">gRPC</SelectItem>
						<SelectItem value="openapi">OpenAPI</SelectItem>
						<SelectItem value="asyncapi">AsyncAPI</SelectItem>
						{/* Show catalog functions */}
						{Object.entries(categories).map(([category, fns]) =>
							fns.map((fn) => (
								<SelectItem key={fn.name} value={fn.name}>
									{fn.label} ({category})
								</SelectItem>
							)),
						)}
					</SelectContent>
				</Select>
			</div>

			{callProtocol === "http" && (
				<>
					<div className="space-y-2">
						<Label className="ml-1" htmlFor="httpMethod">
							HTTP Method
						</Label>
						<Select
							disabled={disabled}
							onValueChange={(value) =>
								onUpdateConfig("with", { ...withArgs, method: value })
							}
							value={(withArgs.method as string) || "GET"}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="GET">GET</SelectItem>
								<SelectItem value="POST">POST</SelectItem>
								<SelectItem value="PUT">PUT</SelectItem>
								<SelectItem value="PATCH">PATCH</SelectItem>
								<SelectItem value="DELETE">DELETE</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-2">
						<Label className="ml-1" htmlFor="endpoint">
							Endpoint URL
						</Label>
						<Input
							disabled={disabled}
							id="endpoint"
							onChange={(e) => {
								const endpoint =
									typeof withArgs.endpoint === "object"
										? {
												...(withArgs.endpoint as Record<string, unknown>),
												uri: e.target.value,
											}
										: { uri: e.target.value };
								onUpdateConfig("with", { ...withArgs, endpoint });
							}}
							placeholder="https://api.example.com/resource"
							value={
								typeof withArgs.endpoint === "object"
									? ((withArgs.endpoint as Record<string, unknown>)
											.uri as string) || ""
									: (withArgs.endpoint as string) || ""
							}
						/>
					</div>
					<div className="space-y-2">
						<Label className="ml-1" htmlFor="body">
							Request Body (JSON)
						</Label>
						<JsonEditor
							disabled={disabled}
							height={140}
							onChange={(value) => {
								try {
									const body = JSON.parse(value);
									onUpdateConfig("with", { ...withArgs, body });
								} catch {
									onUpdateConfig("with", { ...withArgs, body: value });
								}
							}}
							value={
								typeof withArgs.body === "object"
									? JSON.stringify(withArgs.body, null, 2)
									: (withArgs.body as string) || ""
							}
						/>
					</div>
				</>
			)}

			{isFunction && (
				<div className="space-y-2">
					<Label className="ml-1">Function Arguments (JSON)</Label>
					<JsonEditor
						disabled={disabled}
						height={200}
						onChange={(value) => {
							try {
								onUpdateConfig("with", JSON.parse(value));
							} catch {
								// Keep as string while typing
							}
						}}
						value={JSON.stringify(withArgs, null, 2)}
					/>
					<p className="text-muted-foreground text-xs">
						Arguments passed to the function. Use{" "}
						<code className="rounded bg-muted px-1">{"${ .path }"}</code> for
						runtime expressions.
					</p>
				</div>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// Set task config
// ---------------------------------------------------------------------------

export function SetTaskConfig({
	config,
	onUpdateConfig,
	disabled,
}: TaskConfigProps) {
	const assignments = (config.set as Record<string, unknown>) || {};

	return (
		<div className="space-y-2">
			<Label className="ml-1">Variables (JSON)</Label>
			<JsonEditor
				disabled={disabled}
				height={220}
				onChange={(value) => {
					try {
						onUpdateConfig("set", JSON.parse(value));
					} catch {
						// Keep as string while typing
					}
				}}
				value={JSON.stringify(assignments, null, 2)}
			/>
			<p className="text-muted-foreground text-xs">
				Key-value pairs to set in the workflow context. Values can be literals
				or runtime expressions.
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Switch task config
// ---------------------------------------------------------------------------

export function SwitchTaskConfig({
	config,
	onUpdateConfig,
	disabled,
}: TaskConfigProps) {
	const cases =
		(config.switch as Array<
			Record<string, { when?: string; then?: string }>
		>) || [];

	return (
		<div className="space-y-4">
			<Label className="ml-1">Switch Cases</Label>
			{cases.map((caseItem, idx) => {
				const entries = Object.entries(caseItem);
				if (entries.length === 0) return null;
				const [caseName, caseDef] = entries[0];
				return (
					<div key={idx} className="space-y-2 rounded-lg border p-3">
						<div className="space-y-1">
							<Label className="text-xs">Case Name</Label>
							<Input disabled={disabled} value={caseName} readOnly />
						</div>
						<div className="space-y-1">
							<Label className="text-xs">When (expression)</Label>
							<Input
								disabled={disabled}
								placeholder="${ .status == 'active' }"
								value={caseDef?.when || ""}
								onChange={(e) => {
									const newCases = [...cases];
									newCases[idx] = {
										[caseName]: { ...caseDef, when: e.target.value },
									};
									onUpdateConfig("switch", newCases);
								}}
							/>
						</div>
						<div className="space-y-1">
							<Label className="text-xs">Then (flow directive)</Label>
							<Input
								disabled={disabled}
								placeholder="taskName, end, exit, or continue"
								value={caseDef?.then || ""}
								onChange={(e) => {
									const newCases = [...cases];
									newCases[idx] = {
										[caseName]: { ...caseDef, then: e.target.value },
									};
									onUpdateConfig("switch", newCases);
								}}
							/>
						</div>
					</div>
				);
			})}
			<p className="text-muted-foreground text-xs">
				Evaluates cases in order. First matching{" "}
				<code className="rounded bg-muted px-1">when</code> expression routes to
				its <code className="rounded bg-muted px-1">then</code> target. A case
				without <code className="rounded bg-muted px-1">when</code> acts as the
				default.
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Wait task config
// ---------------------------------------------------------------------------

export function WaitTaskConfig({
	config,
	onUpdateConfig,
	disabled,
}: TaskConfigProps) {
	const wait = config.wait;
	const isIso = typeof wait === "string";

	return (
		<div className="space-y-2">
			<Label className="ml-1" htmlFor="waitDuration">
				Duration (ISO 8601)
			</Label>
			<Input
				disabled={disabled}
				id="waitDuration"
				onChange={(e) => onUpdateConfig("wait", e.target.value)}
				placeholder="PT30S (30 seconds), PT5M (5 minutes), PT1H (1 hour)"
				value={isIso ? (wait as string) : JSON.stringify(wait)}
			/>
			<p className="text-muted-foreground text-xs">
				ISO 8601 duration. Examples:{" "}
				<code className="rounded bg-muted px-1">PT30S</code> (30s),{" "}
				<code className="rounded bg-muted px-1">PT5M</code> (5m),{" "}
				<code className="rounded bg-muted px-1">PT1H30M</code> (1h 30m).
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Emit task config
// ---------------------------------------------------------------------------

export function EmitTaskConfig({
	config,
	onUpdateConfig,
	disabled,
}: TaskConfigProps) {
	const emit =
		(config.emit as { event?: { with?: Record<string, unknown> } }) || {};
	const eventWith = emit?.event?.with || {};

	const updateEventWith = (key: string, value: unknown) => {
		onUpdateConfig("emit", {
			event: {
				with: { ...eventWith, [key]: value },
			},
		});
	};

	return (
		<>
			<div className="space-y-2">
				<Label className="ml-1" htmlFor="eventType">
					Event Type
				</Label>
				<Input
					disabled={disabled}
					id="eventType"
					onChange={(e) => updateEventWith("type", e.target.value)}
					placeholder="com.example.workflow.completed"
					value={(eventWith.type as string) || ""}
				/>
			</div>
			<div className="space-y-2">
				<Label className="ml-1" htmlFor="eventSource">
					Source
				</Label>
				<Input
					disabled={disabled}
					id="eventSource"
					onChange={(e) => updateEventWith("source", e.target.value)}
					placeholder="/workflow/my-workflow"
					value={(eventWith.source as string) || ""}
				/>
			</div>
			<div className="space-y-2">
				<Label className="ml-1" htmlFor="eventData">
					Data (JSON)
				</Label>
				<JsonEditor
					disabled={disabled}
					height={140}
					onChange={(value) => {
						try {
							updateEventWith("data", JSON.parse(value));
						} catch {
							/* noop */
						}
					}}
					value={eventWith.data ? JSON.stringify(eventWith.data, null, 2) : ""}
				/>
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------
// Listen task config
// ---------------------------------------------------------------------------

export function ListenTaskConfig({
	config,
	onUpdateConfig,
	disabled,
}: TaskConfigProps) {
	const listen = (config.listen as { to?: Record<string, unknown> }) || {};
	const to = listen?.to || {};

	return (
		<>
			<div className="space-y-2">
				<Label className="ml-1">Event Filter (JSON)</Label>
				<JsonEditor
					disabled={disabled}
					height={180}
					onChange={(value) => {
						try {
							onUpdateConfig("listen", { to: JSON.parse(value) });
						} catch {
							/* noop */
						}
					}}
					value={JSON.stringify(to, null, 2)}
				/>
				<p className="text-muted-foreground text-xs">
					Event consumption strategy. Use{" "}
					<code className="rounded bg-muted px-1">one</code>,{" "}
					<code className="rounded bg-muted px-1">any</code>, or{" "}
					<code className="rounded bg-muted px-1">all</code> to match events.
				</p>
			</div>
			<div className="space-y-2">
				<Label className="ml-1">Timeout (ISO 8601, optional)</Label>
				<Input
					disabled={disabled}
					onChange={(e) => {
						if (e.target.value) {
							onUpdateConfig("timeout", { after: e.target.value });
						} else {
							onUpdateConfig("timeout", undefined);
						}
					}}
					placeholder="PT1H (1 hour timeout)"
					value={(config.timeout as { after?: string })?.after || ""}
				/>
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------
// For task config
// ---------------------------------------------------------------------------

export function ForTaskConfig({
	config,
	onUpdateConfig,
	disabled,
}: TaskConfigProps) {
	const forDef =
		(config.for as { each?: string; in?: string; at?: string }) || {};

	return (
		<>
			<div className="space-y-2">
				<Label className="ml-1" htmlFor="forEach">
					Each (variable name)
				</Label>
				<Input
					disabled={disabled}
					id="forEach"
					onChange={(e) =>
						onUpdateConfig("for", { ...forDef, each: e.target.value })
					}
					placeholder="item"
					value={forDef.each || ""}
				/>
			</div>
			<div className="space-y-2">
				<Label className="ml-1" htmlFor="forIn">
					In (collection expression)
				</Label>
				<Input
					disabled={disabled}
					id="forIn"
					onChange={(e) =>
						onUpdateConfig("for", { ...forDef, in: e.target.value })
					}
					placeholder="${ .items }"
					value={forDef.in || ""}
				/>
			</div>
			<div className="space-y-2">
				<Label className="ml-1" htmlFor="forWhile">
					While (optional condition)
				</Label>
				<Input
					disabled={disabled}
					id="forWhile"
					onChange={(e) => onUpdateConfig("while", e.target.value || undefined)}
					placeholder="${ .hasMore == true }"
					value={(config.while as string) || ""}
				/>
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------
// Run task config
// ---------------------------------------------------------------------------

export function RunTaskConfig({
	config,
	onUpdateConfig,
	disabled,
}: TaskConfigProps) {
	const run = (config.run as Record<string, unknown>) || {};
	const runType = Object.keys(run)[0] || "shell";

	return (
		<>
			<div className="space-y-2">
				<Label className="ml-1">Run Type</Label>
				<Select
					disabled={disabled}
					onValueChange={(value) => {
						const defaults: Record<string, unknown> = {
							shell: { shell: { command: "" } },
							script: { script: { language: "python", code: "" } },
							container: { container: { image: "" } },
							workflow: {
								workflow: { namespace: "default", name: "", version: "latest" },
							},
						};
						onUpdateConfig("run", defaults[value] || {});
					}}
					value={runType}
				>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="shell">Shell Command</SelectItem>
						<SelectItem value="script">Script</SelectItem>
						<SelectItem value="container">Container</SelectItem>
						<SelectItem value="workflow">Child Workflow</SelectItem>
					</SelectContent>
				</Select>
			</div>

			{runType === "shell" && (
				<div className="space-y-2">
					<Label className="ml-1">Command</Label>
					<TextCodeEditor
						disabled={disabled}
						height={140}
						language="shell"
						onChange={(value) =>
							onUpdateConfig("run", { shell: { command: value } })
						}
						value={(run.shell as { command?: string })?.command || ""}
					/>
				</div>
			)}

			{runType === "workflow" && (
				<>
					<div className="space-y-2">
						<Label className="ml-1">Workflow Name</Label>
						<Input
							disabled={disabled}
							onChange={(e) =>
								onUpdateConfig("run", {
									workflow: {
										...((run.workflow as Record<string, unknown>) || {}),
										name: e.target.value,
									},
								})
							}
							placeholder="child-workflow-name"
							value={(run.workflow as { name?: string })?.name || ""}
						/>
					</div>
					<div className="space-y-2">
						<Label className="ml-1">Input (JSON)</Label>
						<JsonEditor
							disabled={disabled}
							height={140}
							onChange={(value) => {
								try {
									onUpdateConfig("run", {
										workflow: {
											...((run.workflow as Record<string, unknown>) || {}),
											input: JSON.parse(value),
										},
									});
								} catch {
									/* noop */
								}
							}}
							value={JSON.stringify(
								(run.workflow as { input?: unknown })?.input || {},
								null,
								2,
							)}
						/>
					</div>
				</>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// Config panel dispatcher
// ---------------------------------------------------------------------------

export function SWTaskConfigPanel({
	taskType,
	config,
	onUpdateConfig,
	disabled,
}: {
	taskType: string;
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: unknown) => void;
	disabled?: boolean;
}) {
	switch (taskType) {
		case "call":
			return (
				<CallTaskConfig
					config={config}
					onUpdateConfig={onUpdateConfig}
					disabled={disabled}
				/>
			);
		case "set":
			return (
				<SetTaskConfig
					config={config}
					onUpdateConfig={onUpdateConfig}
					disabled={disabled}
				/>
			);
		case "switch":
			return (
				<SwitchTaskConfig
					config={config}
					onUpdateConfig={onUpdateConfig}
					disabled={disabled}
				/>
			);
		case "wait":
			return (
				<WaitTaskConfig
					config={config}
					onUpdateConfig={onUpdateConfig}
					disabled={disabled}
				/>
			);
		case "emit":
			return (
				<EmitTaskConfig
					config={config}
					onUpdateConfig={onUpdateConfig}
					disabled={disabled}
				/>
			);
		case "listen":
			return (
				<ListenTaskConfig
					config={config}
					onUpdateConfig={onUpdateConfig}
					disabled={disabled}
				/>
			);
		case "for":
			return (
				<ForTaskConfig
					config={config}
					onUpdateConfig={onUpdateConfig}
					disabled={disabled}
				/>
			);
		case "run":
			return (
				<RunTaskConfig
					config={config}
					onUpdateConfig={onUpdateConfig}
					disabled={disabled}
				/>
			);
		default:
			return (
				<div className="space-y-2">
					<Label className="ml-1">Task Configuration (JSON)</Label>
					<JsonEditor
						disabled={disabled}
						height={260}
						onChange={(value) => {
							try {
								const parsed = JSON.parse(value);
								for (const [key, nextValue] of Object.entries(parsed)) {
									onUpdateConfig(key, nextValue);
								}
							} catch {
								/* noop */
							}
						}}
						value={JSON.stringify(config, null, 2)}
					/>
				</div>
			);
	}
}
