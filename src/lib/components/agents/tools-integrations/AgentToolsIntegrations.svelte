<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { Loader2, Plus, RefreshCw } from '@lucide/svelte';
	import {
		effectiveAgentTools,
		serverMatchesEntry,
		serverKey,
		normalizePiece,
		type McpAvailabilityEntryLite
	} from '$lib/connections/agent-mcp';
	import { toolSelectionFromMetadata } from '$lib/connections/piece-mcp';
	import type { McpServerProfileConfig } from '$lib/server/agent-profiles';
	import type { VaultCredentialSummary, VaultSummary } from '$lib/types/vaults';
	import EffectiveToolSurfaceBar from './EffectiveToolSurfaceBar.svelte';
	import AttachedServerCard from './AttachedServerCard.svelte';
	import AttachServerSheet from './AttachServerSheet.svelte';
	import SystemServersNote from './SystemServersNote.svelte';

	interface Props {
		value: McpServerProfileConfig[];
		connectionMode: 'explicit' | 'project' | 'auto';
		vaultIds: string[];
		onModeChange: (mode: 'explicit' | 'project' | 'auto') => void;
		onChange: (next: McpServerProfileConfig[]) => void;
	}

	let { value, connectionMode, vaultIds, onModeChange, onChange }: Props = $props();

	type CatalogEntry = {
		pieceName: string;
		displayName: string;
		logoUrl: string | null;
	};

	let availabilityEntries = $state<McpAvailabilityEntryLite[]>([]);
	let catalogLogos = $state<Record<string, string | null>>({});
	let vaults = $state<VaultSummary[]>([]);
	let credentialsByVault = $state<Record<string, VaultCredentialSummary[]>>({});
	let loading = $state(false);
	let error = $state<string | null>(null);
	let sheetOpen = $state(false);

	// Live tool universe per piece (action names), fetched once so the
	// effective-surface bar can sum counts without waiting for each card expand.
	let liveToolsByPiece = $state<Record<string, string[]>>({});

	const slug = $derived(String(page.params.slug || '').trim() || 'default');

	onMount(() => {
		void loadSupportData();
	});

	async function loadSupportData() {
		loading = true;
		error = null;
		try {
			const [availabilityRes, catalogRes, vaultsRes] = await Promise.all([
				fetch('/api/mcp-connections/availability'),
				fetch('/api/mcp-connections/catalog'),
				fetch('/api/v1/vaults')
			]);
			if (availabilityRes.ok) {
				const body = (await availabilityRes.json()) as { entries?: McpAvailabilityEntryLite[] };
				availabilityEntries = body.entries ?? [];
			} else {
				error = `Failed to load MCP availability (${availabilityRes.status})`;
			}
			if (catalogRes.ok) {
				const body = (await catalogRes.json()) as { entries?: CatalogEntry[] };
				catalogLogos = Object.fromEntries(
					(body.entries ?? []).map((e) => [normalizePiece(e.pieceName), e.logoUrl])
				);
			}
			if (vaultsRes.ok) {
				const data = (await vaultsRes.json()) as { vaults?: VaultSummary[] };
				vaults = data.vaults ?? [];
				const attached = vaults.filter((v) => vaultIds.includes(v.id));
				const creds = await Promise.all(
					attached.map(async (v) => {
						const r = await fetch(`/api/v1/vaults/${v.id}/credentials`);
						if (!r.ok) return [v.id, []] as const;
						const d = (await r.json()) as { credentials?: VaultCredentialSummary[] };
						return [v.id, d.credentials ?? []] as const;
					})
				);
				credentialsByVault = Object.fromEntries(creds);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
		// After support data loads, prefetch tool lists for already-attached piece
		// servers so the effective-surface bar is accurate without expanding cards.
		await prefetchAttachedPieceTools();
	}

	/**
	 * Fetch the action (tool) list for one piece once, caching by piece name.
	 * Populates the effective-surface bar without expanding each card. Invoked
	 * imperatively (on load + on attach) rather than from a reactive `$effect`.
	 */
	async function ensurePieceTools(pieceName: string) {
		const piece = normalizePiece(pieceName);
		if (!piece || liveToolsByPiece[piece] !== undefined) return;
		try {
			const res = await fetch(`/api/mcp-connections/catalog/${piece}/actions`);
			if (!res.ok) {
				liveToolsByPiece = { ...liveToolsByPiece, [piece]: [] };
				return;
			}
			const body = (await res.json()) as { actions?: { name: string }[] };
			liveToolsByPiece = {
				...liveToolsByPiece,
				[piece]: (body.actions ?? []).map((a) => a.name)
			};
		} catch {
			liveToolsByPiece = { ...liveToolsByPiece, [piece]: [] };
		}
	}

	async function prefetchAttachedPieceTools() {
		await Promise.all(
			value
				.filter((server) => server.sourceType === 'nimble_piece' && server.pieceName)
				.map((server) => ensurePieceTools(server.pieceName!))
		);
	}

	// --- Mode model: ONE "Include all workspace MCP servers" toggle. -----------
	// Map: toggle OFF → 'explicit'; toggle ON → 'project'. Read all three on load
	// ('auto' → ON iff value is empty, else OFF — legacy round-trip), write two.
	const includeAll = $derived.by(() => {
		if (connectionMode === 'project') return true;
		if (connectionMode === 'explicit') return false;
		// auto
		return value.length === 0;
	});

	function setIncludeAll(on: boolean) {
		onModeChange(on ? 'project' : 'explicit');
	}

	// --- Attached servers + their availability/logos ---------------------------
	function entryForServer(server: McpServerProfileConfig): McpAvailabilityEntryLite | null {
		if (server.sourceType !== 'nimble_piece') return null;
		return availabilityEntries.find((entry) => serverMatchesEntry(server, entry)) ?? null;
	}

	function logoForServer(server: McpServerProfileConfig): string | null {
		const piece = normalizePiece(server.pieceName ?? '');
		return piece ? (catalogLogos[piece] ?? null) : null;
	}

	function logoForPiece(pieceName: string): string | null {
		return catalogLogos[normalizePiece(pieceName)] ?? null;
	}

	function credentialForServer(server: McpServerProfileConfig): VaultCredentialSummary | null {
		if (!server.url) return null;
		for (const vid of vaultIds) {
			const creds = credentialsByVault[vid] ?? [];
			const match = creds.find((c) => c.mcpServerUrl === server.url);
			if (match) return match;
		}
		return null;
	}

	function attachServer(server: McpServerProfileConfig) {
		// Dedupe by serverKey.
		const key = serverKey(server);
		if (value.some((s) => serverKey(s) === key)) {
			sheetOpen = false;
			return;
		}
		onChange([...value, server]);
		sheetOpen = false;
		if (server.sourceType === 'nimble_piece' && server.pieceName) {
			void ensurePieceTools(server.pieceName);
		}
	}

	function updateServer(index: number, next: McpServerProfileConfig) {
		onChange(value.map((s, i) => (i === index ? next : s)));
	}

	function removeServer(index: number) {
		onChange(value.filter((_, i) => i !== index));
	}

	function ceilingForServer(server: McpServerProfileConfig): string[] | null {
		const entry = entryForServer(server);
		return toolSelectionFromMetadata(entry?.mcpConnection?.metadata ?? null);
	}

	// --- Effective tool surface ------------------------------------------------
	// For attached piece servers with a KNOWN live tool list, sum the effective
	// counts (ceiling ∩ agent narrowing). Servers without a known list (custom /
	// hosted / preset) contribute "?".
	const surface = $derived.by(() => {
		let toolCount = 0;
		let unknown = 0;
		for (const server of value) {
			const piece = normalizePiece(server.pieceName ?? '');
			const live = server.sourceType === 'nimble_piece' ? liveToolsByPiece[piece] : undefined;
			if (server.sourceType === 'nimble_piece' && live !== undefined) {
				const { count } = effectiveAgentTools(server, ceilingForServer(server), live);
				toolCount += count;
			} else {
				unknown += 1;
			}
		}
		// When "include all" is on, ready project servers that aren't explicitly
		// attached also load — count them as additional servers (unknown tools).
		let serverCount = value.length;
		if (includeAll) {
			const attachedPieces = new Set(
				value
					.filter((s) => s.sourceType === 'nimble_piece')
					.map((s) => normalizePiece(s.pieceName ?? ''))
			);
			for (const entry of availabilityEntries) {
				if (!entry.ready) continue;
				if (attachedPieces.has(normalizePiece(entry.pieceName))) continue;
				serverCount += 1;
				unknown += 1;
			}
		}
		return { toolCount, serverCount, unknown };
	});
</script>

<div class="space-y-4">
	<EffectiveToolSurfaceBar
		toolCount={surface.toolCount}
		serverCount={surface.serverCount}
		unknownServerCount={surface.unknown}
	/>

	{#if error}
		<div class="text-xs text-destructive">{error}</div>
	{/if}

	<div class="flex items-center justify-between gap-3 flex-wrap">
		<label class="flex items-center gap-2 cursor-pointer">
			<Switch checked={includeAll} onCheckedChange={setIncludeAll} />
			<span class="text-sm">
				Include all workspace MCP servers
				<span class="block text-[11px] text-muted-foreground">
					Off: only the servers attached below. On: every ready workspace MCP server.
				</span>
			</span>
		</label>
		<div class="flex items-center gap-2">
			<Button variant="outline" size="sm" onclick={() => void loadSupportData()}>
				{#if loading}
					<Loader2 class="size-3.5 animate-spin" />
				{:else}
					<RefreshCw class="size-3.5" />
				{/if}
				Refresh
			</Button>
			<Button size="sm" onclick={() => (sheetOpen = true)}>
				<Plus class="size-4" /> Attach integration
			</Button>
		</div>
	</div>

	{#if value.length === 0}
		<div class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
			{#if includeAll}
				This agent inherits every ready workspace MCP server. Attach a server to narrow its
				tools.
			{:else}
				No integrations attached. Use "Attach integration" to add one.
			{/if}
		</div>
	{:else}
		<div class="space-y-2">
			{#each value as server, index (serverKey(server))}
				<AttachedServerCard
					{server}
					entry={entryForServer(server)}
					logoUrl={logoForServer(server)}
					{slug}
					credential={credentialForServer(server)}
					onChange={(next) => updateServer(index, next)}
					onRemove={() => removeServer(index)}
				/>
			{/each}
		</div>
	{/if}

	<SystemServersNote />
</div>

<AttachServerSheet
	open={sheetOpen}
	onOpenChange={(o) => (sheetOpen = o)}
	{value}
	entries={availabilityEntries}
	logoFor={logoForPiece}
	{slug}
	onAttach={attachServer}
/>
