"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { SettingsSubnav } from "@/components/settings/settings-subnav";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, type RuntimeConfigAuditLog } from "@/lib/api-client";

function parseMetadata(raw: string): Record<string, string> | undefined {
	if (!raw.trim()) return undefined;
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Metadata must be a JSON object");
	}
	const metadata = Object.fromEntries(
		Object.entries(parsed as Record<string, unknown>)
			.map(([key, value]) => {
				if (typeof value === "string") {
					return [key.trim(), value.trim()] as const;
				}
				if (typeof value === "number" || typeof value === "boolean") {
					return [key.trim(), String(value)] as const;
				}
				return null;
			})
			.filter((entry): entry is readonly [string, string] => Boolean(entry))
			.filter(([key, value]) => Boolean(key) && Boolean(value)),
	);
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export default function RuntimeConfigSettingsPage() {
	const [storeName, setStoreName] = useState("");
	const [configKey, setConfigKey] = useState("");
	const [value, setValue] = useState("");
	const [metadata, setMetadata] = useState(
		'{\n  "label": "workflow-builder"\n}',
	);
	const [writerEnabled, setWriterEnabled] = useState(false);
	const [logs, setLogs] = useState<RuntimeConfigAuditLog[]>([]);
	const [currentValue, setCurrentValue] = useState<string | null>(null);
	const [currentVersion, setCurrentVersion] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [reading, setReading] = useState(false);

	const load = useCallback(async () => {
		try {
			setLoading(true);
			const result = await api.runtimeConfig.list();
			setWriterEnabled(result.data.writerEnabled);
			setLogs(result.data.logs);
			if (!storeName) {
				setStoreName(result.data.defaults.storeName);
			}
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed loading runtime config settings",
			);
		} finally {
			setLoading(false);
		}
	}, [storeName]);

	useEffect(() => {
		load();
	}, [load]);

	const readCurrent = async () => {
		if (!configKey.trim()) {
			toast.error("Config key is required");
			return;
		}
		try {
			setReading(true);
			const metadataMap = parseMetadata(metadata);
			const result = await api.runtimeConfig.list({
				storeName: storeName.trim() || undefined,
				configKey: configKey.trim(),
				metadata: metadataMap,
			});
			setLogs(result.data.logs);
			setWriterEnabled(result.data.writerEnabled);
			if (result.data.current) {
				setCurrentValue(result.data.current.value);
				setCurrentVersion(result.data.current.version ?? null);
				setValue(result.data.current.value);
				toast.success("Loaded current value");
				return;
			}
			setCurrentValue(null);
			setCurrentVersion(null);
			toast.error("Config key not found in store");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed reading config value",
			);
		} finally {
			setReading(false);
		}
	};

	const save = async () => {
		if (!configKey.trim()) {
			toast.error("Config key is required");
			return;
		}
		try {
			setSaving(true);
			const metadataMap = parseMetadata(metadata);
			const result = await api.runtimeConfig.write({
				storeName: storeName.trim() || undefined,
				configKey: configKey.trim(),
				value,
				metadata: metadataMap,
			});
			setCurrentValue(result.data.current?.value ?? null);
			setCurrentVersion(result.data.current?.version ?? null);
			toast.success("Runtime config updated");
			await load();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed writing config value",
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="pointer-events-auto flex h-full flex-col bg-background">
			<div className="flex items-center gap-2 border-b px-6 py-4">
				<SidebarToggle />
				<div>
					<h1 className="font-semibold text-xl">Runtime Config</h1>
					<p className="text-muted-foreground text-sm">
						Update dynamic agent configuration values used by durable workflows.
					</p>
				</div>
				<div className="ml-auto flex items-center gap-2">
					<Button asChild size="sm" variant="outline">
						<Link href="/settings">Settings Home</Link>
					</Button>
					<Button asChild size="sm" variant="outline">
						<Link href="/workflows">Builder</Link>
					</Button>
				</div>
			</div>
			<SettingsSubnav />

			<div className="flex-1 space-y-6 overflow-auto p-6">
				<div className="space-y-4 rounded-md border p-4">
					<div className="flex items-center justify-between">
						<h2 className="font-medium">Edit Runtime Config Key</h2>
						{writerEnabled ? (
							<Badge className="bg-emerald-500/10 text-emerald-600">
								Writer Enabled
							</Badge>
						) : (
							<Badge variant="destructive">Writer Not Configured</Badge>
						)}
					</div>
					<div className="grid gap-3 md:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="runtime-store">Store Name</Label>
							<Input
								id="runtime-store"
								onChange={(event) => setStoreName(event.target.value)}
								placeholder="azureappconfig-workflow-builder"
								value={storeName}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="runtime-key">Config Key</Label>
							<Input
								id="runtime-key"
								onChange={(event) => setConfigKey(event.target.value)}
								placeholder="agents/opendev"
								value={configKey}
							/>
						</div>
					</div>
					<div className="space-y-2">
						<Label htmlFor="runtime-metadata">Metadata (JSON)</Label>
						<Textarea
							className="font-mono text-xs"
							id="runtime-metadata"
							onChange={(event) => setMetadata(event.target.value)}
							rows={4}
							value={metadata}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="runtime-value">Value</Label>
						<Textarea
							className="font-mono text-xs"
							id="runtime-value"
							onChange={(event) => setValue(event.target.value)}
							placeholder='{"modelSpec":"openai/gpt-4o-mini","maxTurns":80}'
							rows={8}
							value={value}
						/>
					</div>
					<div className="flex flex-wrap items-center gap-3">
						<Button
							className="gap-2"
							disabled={reading || loading}
							onClick={readCurrent}
							type="button"
						>
							{reading ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<RefreshCw className="size-4" />
							)}
							Read Current
						</Button>
						<Button
							className="gap-2"
							disabled={saving || !writerEnabled}
							onClick={save}
							type="button"
						>
							{saving ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<Save className="size-4" />
							)}
							Save Value
						</Button>
						{currentValue !== null ? (
							<p className="text-muted-foreground text-xs">
								Loaded version: {currentVersion || "n/a"}
							</p>
						) : null}
					</div>
				</div>

				<div className="space-y-3 rounded-md border p-4">
					<h2 className="font-medium">Audit Log</h2>
					<div className="rounded-md border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Time</TableHead>
									<TableHead>Store</TableHead>
									<TableHead>Key</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Error</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{loading ? (
									<TableRow>
										<TableCell className="text-muted-foreground" colSpan={5}>
											Loading audit logs...
										</TableCell>
									</TableRow>
								) : logs.length === 0 ? (
									<TableRow>
										<TableCell className="text-muted-foreground" colSpan={5}>
											No runtime config audit entries yet
										</TableCell>
									</TableRow>
								) : (
									logs.map((entry) => (
										<TableRow key={entry.id}>
											<TableCell className="text-xs">
												{new Date(entry.createdAt).toLocaleString()}
											</TableCell>
											<TableCell className="font-mono text-xs">
												{entry.storeName}
											</TableCell>
											<TableCell className="font-mono text-xs">
												{entry.configKey}
											</TableCell>
											<TableCell>
												{entry.status === "success" ? (
													<Badge className="bg-emerald-500/10 text-emerald-600">
														Success
													</Badge>
												) : (
													<Badge variant="destructive">Error</Badge>
												)}
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{entry.error || "-"}
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>
				</div>
			</div>
		</div>
	);
}
