"use client";

import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useIsMobile } from "@/hooks/use-mobile";
import { type AppConnection, api } from "@/lib/api-client";
import { AppConnectionType } from "@/lib/types/app-connection";
import type { UpsertAppConnectionRequestBody } from "@/lib/types/app-connection";
import { ConfirmOverlay } from "./confirm-overlay";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

type EditableUpsertBody = Extract<
	UpsertAppConnectionRequestBody,
	{
		type:
			| AppConnectionType.SECRET_TEXT
			| AppConnectionType.BASIC_AUTH
			| AppConnectionType.CUSTOM_AUTH;
	}
>;

type EditConnectionOverlayProps = {
	overlayId: string;
	connection: AppConnection;
	onSuccess?: () => void;
	onDelete?: () => void;
};

/**
 * Secret field with "Configured" state for edit mode
 */
function SecretField({
	fieldId,
	label,
	configKey,
	placeholder,
	helpText,
	helpLink,
	value,
	onChange,
}: {
	fieldId: string;
	label: string;
	configKey: string;
	placeholder?: string;
	helpText?: string;
	helpLink?: { url: string; text: string };
	value: string;
	onChange: (key: string, value: string) => void;
}) {
	const [isEditing, setIsEditing] = useState(false);
	const isMobile = useIsMobile();
	const hasNewValue = value.length > 0;

	// Show "Configured" state until user clicks Change
	if (!(isEditing || hasNewValue)) {
		return (
			<div className="space-y-2">
				<Label htmlFor={fieldId}>{label}</Label>
				<div className="flex items-center gap-2">
					<div className="flex h-9 flex-1 items-center gap-2 rounded-md border bg-muted/30 px-3">
						<Check className="size-4 text-green-600" />
						<span className="text-muted-foreground text-sm">Configured</span>
					</div>
					<Button
						onClick={() => setIsEditing(true)}
						type="button"
						variant="outline"
					>
						<Pencil className="mr-1.5 size-3" />
						Change
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<Label htmlFor={fieldId}>{label}</Label>
			<div className="flex items-center gap-2">
				<Input
					autoFocus={isEditing && !isMobile}
					className="flex-1"
					id={fieldId}
					onChange={(e) => onChange(configKey, e.target.value)}
					placeholder={placeholder}
					type="password"
					value={value}
				/>
				{(isEditing || hasNewValue) && (
					<Button
						onClick={() => {
							onChange(configKey, "");
							setIsEditing(false);
						}}
						size="icon"
						type="button"
						variant="ghost"
					>
						<X className="size-4" />
					</Button>
				)}
			</div>
			{(helpText || helpLink) && (
				<p className="text-muted-foreground text-xs">
					{helpText}
					{helpLink && (
						<a
							className="underline hover:text-foreground"
							href={helpLink.url}
							rel="noopener noreferrer"
							target="_blank"
						>
							{helpLink.text}
						</a>
					)}
				</p>
			)}
		</div>
	);
}

/**
 * Overlay for editing an existing connection
 */
export function EditConnectionOverlay({
	overlayId,
	connection,
	onSuccess,
	onDelete,
}: EditConnectionOverlayProps) {
	const { push, closeAll } = useOverlay();
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [_testResult, setTestResult] = useState<{
		status: "success" | "error";
		message: string;
	} | null>(null);
	const [displayName, setDisplayName] = useState(connection.displayName);
	const [config, setConfig] = useState<Record<string, string>>({});

	const updateConfig = (key: string, value: string) => {
		setConfig((prev) => ({ ...prev, [key]: value }));
	};

	const hasNewConfig = Object.values(config).some((v) => v && v.length > 0);

	const buildUpsertRequestFromConfig = (): EditableUpsertBody | null => {
		switch (connection.type) {
			case AppConnectionType.SECRET_TEXT: {
				const secret =
					config.secret_text ||
					Object.values(config).find((v) => v && v.length > 0) ||
					"";
				return {
					externalId: connection.externalId,
					displayName: displayName.trim(),
					pieceName: connection.pieceName,
					projectId: "default",
					pieceVersion: connection.pieceVersion,
					metadata: connection.metadata,
					type: AppConnectionType.SECRET_TEXT,
					value: {
						type: AppConnectionType.SECRET_TEXT,
						secret_text: secret,
					},
				};
			}
			case AppConnectionType.BASIC_AUTH: {
				const username = config.username || "";
				const password = config.password || "";
				return {
					externalId: connection.externalId,
					displayName: displayName.trim(),
					pieceName: connection.pieceName,
					projectId: "default",
					pieceVersion: connection.pieceVersion,
					metadata: connection.metadata,
					type: AppConnectionType.BASIC_AUTH,
					value: {
						type: AppConnectionType.BASIC_AUTH,
						username,
						password,
					},
				};
			}
			case AppConnectionType.CUSTOM_AUTH: {
				const raw = config.props_json || "{}";
				let props: Record<string, unknown> = {};
				try {
					const parsed = JSON.parse(raw) as unknown;
					if (parsed && typeof parsed === "object") {
						props = parsed as Record<string, unknown>;
					}
				} catch {
					// validated in UI; keep empty to avoid crashing save/test
				}
				return {
					externalId: connection.externalId,
					displayName: displayName.trim(),
					pieceName: connection.pieceName,
					projectId: "default",
					pieceVersion: connection.pieceVersion,
					metadata: connection.metadata,
					type: AppConnectionType.CUSTOM_AUTH,
					value: {
						type: AppConnectionType.CUSTOM_AUTH,
						props,
					},
				};
			}
			default:
				return null;
		}
	};

	const doSave = async () => {
		try {
			setSaving(true);
			if (hasNewConfig) {
				const upsertBody = buildUpsertRequestFromConfig();
				if (!upsertBody) {
					toast.error(
						"This connection type can't be updated here. Delete and re-create the connection instead.",
					);
					return;
				}

				// Re-upsert with new credentials (matched by externalId)
				await api.appConnection.upsert(upsertBody);
			} else {
				await api.appConnection.update(connection.id, {
					displayName: displayName.trim(),
				});
			}
			toast.success("Connection updated");
			onSuccess?.();
			closeAll();
		} catch (error) {
			console.error("Failed to update connection:", error);
			toast.error("Failed to update connection");
		} finally {
			setSaving(false);
		}
	};

	const handleSave = async () => {
		// If no new config, just save the name
		if (!hasNewConfig) {
			await doSave();
			return;
		}

		// Test before saving
		try {
			setSaving(true);
			setTestResult(null);

			const upsertBody = buildUpsertRequestFromConfig();
			if (!upsertBody) {
				toast.error(
					"This connection type can't be updated here. Delete and re-create the connection instead.",
				);
				setSaving(false);
				return;
			}

			const result = await api.appConnection.test(upsertBody);

			if (result.status === "error") {
				push(ConfirmOverlay, {
					title: "Connection Test Failed",
					message: `The test failed: ${result.message}\n\nDo you want to save anyway?`,
					confirmLabel: "Save Anyway",
					onConfirm: async () => {
						await doSave();
					},
				});
				setSaving(false);
				return;
			}

			await doSave();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to test connection";
			push(ConfirmOverlay, {
				title: "Connection Test Failed",
				message: `${message}\n\nDo you want to save anyway?`,
				confirmLabel: "Save Anyway",
				onConfirm: async () => {
					await doSave();
				},
			});
			setSaving(false);
		}
	};

	const handleTest = async () => {
		try {
			setTesting(true);
			setTestResult(null);

			let result: { status: "success" | "error"; message: string };

			if (hasNewConfig) {
				const upsertBody = buildUpsertRequestFromConfig();
				if (!upsertBody) {
					toast.error(
						"This connection type can't be tested here. Test the existing connection instead.",
					);
					setTesting(false);
					return;
				}
				result = await api.appConnection.test({
					...upsertBody,
				});
			} else {
				result = await api.appConnection.testExisting(connection.id);
			}

			setTestResult(result);
			if (result.status === "success") {
				toast.success(result.message || "Connection successful");
			} else {
				toast.error(result.message || "Connection failed");
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Connection test failed";
			setTestResult({ status: "error", message });
			toast.error(message);
		} finally {
			setTesting(false);
		}
	};

	const handleDelete = () => {
		push(DeleteConnectionOverlay, {
			connection,
			onSuccess: () => {
				onDelete?.();
				closeAll();
			},
		});
	};

	const renderCredentialFields = () => {
		switch (connection.type) {
			case AppConnectionType.SECRET_TEXT:
				return (
					<SecretField
						configKey="secret_text"
						fieldId="secret_text"
						key="secret_text"
						label="Secret"
						onChange={updateConfig}
						placeholder="Enter a new secret"
						value={config.secret_text || ""}
					/>
				);

			case AppConnectionType.BASIC_AUTH:
				return (
					<>
						<div className="space-y-2">
							<Label htmlFor="username">Username</Label>
							<Input
								id="username"
								onChange={(e) => updateConfig("username", e.target.value)}
								placeholder="Username"
								type="text"
								value={config.username || ""}
							/>
						</div>
						<SecretField
							configKey="password"
							fieldId="password"
							key="password"
							label="Password"
							onChange={updateConfig}
							placeholder="Enter a new password"
							value={config.password || ""}
						/>
					</>
				);

			case AppConnectionType.CUSTOM_AUTH:
				return (
					<div className="space-y-2">
						<Label htmlFor="props_json">Auth Properties (JSON)</Label>
						<Input
							id="props_json"
							onChange={(e) => updateConfig("props_json", e.target.value)}
							placeholder='{"apiKey":"..."}'
							type="text"
							value={config.props_json || ""}
						/>
						<p className="text-muted-foreground text-xs">
							For complex auth, use the Connections page to create a new
							connection with the piece-auth form.
						</p>
					</div>
				);

			default:
				return (
					<p className="text-muted-foreground text-sm">
						This connection type can’t be updated here. To rotate credentials,
						delete and re-create the connection.
					</p>
				);
		}
	};

	return (
		<Overlay
			actions={[
				{
					label: "Delete",
					variant: "ghost",
					onClick: handleDelete,
					disabled: saving || testing,
				},
				{
					label: "Test",
					variant: "outline",
					onClick: handleTest,
					loading: testing,
					disabled: saving,
				},
				{ label: "Update", onClick: handleSave, loading: saving },
			]}
			overlayId={overlayId}
			title={`Edit ${connection.displayName}`}
		>
			<p className="-mt-2 mb-4 text-muted-foreground text-sm">
				Update your connection credentials
			</p>

			<div className="space-y-4">
				{renderCredentialFields()}

				<div className="space-y-2">
					<Label htmlFor="name">Label (Optional)</Label>
					<Input
						id="name"
						onChange={(e) => setDisplayName(e.target.value)}
						placeholder="e.g. Production, Personal, Work"
						value={displayName}
					/>
				</div>
			</div>
		</Overlay>
	);
}

type DeleteConnectionOverlayProps = {
	overlayId: string;
	connection: AppConnection;
	onSuccess?: () => void;
};

/**
 * Overlay for deleting a connection with optional key revocation
 */
export function DeleteConnectionOverlay({
	overlayId,
	connection,
	onSuccess,
}: DeleteConnectionOverlayProps) {
	const { pop } = useOverlay();
	const [deleting, setDeleting] = useState(false);

	const handleDelete = async () => {
		try {
			setDeleting(true);
			await api.appConnection.delete(connection.id);
			toast.success("Connection deleted");
			onSuccess?.();
		} catch (error) {
			console.error("Failed to delete connection:", error);
			toast.error("Failed to delete connection");
			setDeleting(false);
		}
	};

	return (
		<Overlay
			actions={[
				{ label: "Cancel", variant: "outline", onClick: pop },
				{
					label: "Delete",
					variant: "destructive",
					onClick: handleDelete,
					loading: deleting,
				},
			]}
			overlayId={overlayId}
			title="Delete Connection"
		>
			<p className="text-muted-foreground text-sm">
				Are you sure you want to delete this connection? Workflows using it will
				fail until a new one is configured.
			</p>
		</Overlay>
	);
}
