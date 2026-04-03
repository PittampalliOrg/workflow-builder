<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
	} from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		Table, TableHeader, TableBody, TableRow, TableHead, TableCell
	} from '$lib/components/ui/table';
	import * as Popover from '$lib/components/ui/popover';
	import * as Command from '$lib/components/ui/command';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import * as Select from '$lib/components/ui/select';
	import { Plus, Trash2, Loader2, Unplug, Pencil, RefreshCw, ChevronsUpDown, Check, Search } from 'lucide-svelte';

	interface Connection {
		id: string;
		externalId: string;
		pieceName: string;
		displayName: string;
		type: string;
		status: string;
		createdAt: string;
	}

	interface Piece {
		name: string;
		displayName: string;
		logoUrl: string | null;
		authType: string;
	}

	let connections: Connection[] = $state([]);
	let pieces: Piece[] = $state([]);
	let loading = $state(true);
	let showNewDialog = $state(false);
	let deleteConfirmId: string | null = $state(null);
	let saving = $state(false);

	// Rename state
	let renameDialogOpen = $state(false);
	let renameConnection: Connection | null = $state(null);
	let renameValue = $state('');
	let renaming = $state(false);

	// Form fields
	let formPieceName = $state('');
	let formDisplayName = $state('');
	let formType = $state('SECRET_TEXT');
	let formValue = $state('');
	let pieceSearchOpen = $state(false);
	let pieceSearch = $state('');

	let filteredPieces = $derived(
		pieceSearch
			? pieces.filter(p =>
					p.displayName.toLowerCase().includes(pieceSearch.toLowerCase()) ||
					p.name.toLowerCase().includes(pieceSearch.toLowerCase())
				)
			: pieces
	);

	let selectedPiece = $derived(pieces.find(p => p.name === formPieceName));

	async function loadConnections() {
		loading = true;
		try {
			const res = await fetch('/api/app-connections');
			if (res.ok) connections = await res.json();
		} catch { /* */ } finally {
			loading = false;
		}
	}

	async function loadPieces() {
		try {
			const res = await fetch('/api/pieces?auth=true');
			if (res.ok) pieces = await res.json();
		} catch { /* */ }
	}

	async function createConnection() {
		saving = true;
		try {
			const res = await fetch('/api/app-connections', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					pieceName: formPieceName,
					displayName: formDisplayName,
					type: formType,
					value: formValue
				})
			});
			if (res.ok) {
				showNewDialog = false;
				formPieceName = '';
				formDisplayName = '';
				formType = 'SECRET_TEXT';
				formValue = '';
				await loadConnections();
			}
		} finally { saving = false; }
	}

	async function deleteConnection(id: string) {
		try {
			const res = await fetch(`/api/app-connections/${id}`, { method: 'DELETE' });
			if (res.ok) connections = connections.filter(c => c.id !== id);
		} finally { deleteConfirmId = null; }
	}

	function openRenameDialog(conn: Connection) {
		renameConnection = conn;
		renameValue = conn.displayName;
		renameDialogOpen = true;
	}

	async function submitRename() {
		if (!renameConnection || !renameValue.trim()) return;
		renaming = true;
		try {
			const res = await fetch(`/api/app-connections/${renameConnection.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ displayName: renameValue.trim() })
			});
			if (res.ok) {
				renameDialogOpen = false;
				renameConnection = null;
				await loadConnections();
			}
		} finally { renaming = false; }
	}

	function reconnectOAuth2(conn: Connection) {
		window.location.href = `/api/app-connections/oauth2/authorize?pieceName=${encodeURIComponent(conn.pieceName)}&connectionId=${encodeURIComponent(conn.id)}`;
	}

	function isOAuth2(type: string): boolean {
		return type === 'OAUTH2' || type === 'PLATFORM_OAUTH2';
	}

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function selectPiece(piece: Piece) {
		formPieceName = piece.name;
		if (!formDisplayName) formDisplayName = piece.displayName;
		formType = piece.authType === 'OAUTH2' ? 'PLATFORM_OAUTH2' : piece.authType || 'SECRET_TEXT';
		pieceSearchOpen = false;
		pieceSearch = '';
	}

	function openNewDialog() {
		showNewDialog = true;
		if (pieces.length === 0) loadPieces();
	}

	$effect(() => { loadConnections(); });
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<h1 class="text-sm font-semibold tracking-tight">Connections</h1>
		<Button size="sm" onclick={openNewDialog}>
			<Plus size={14} />
			New Connection
		</Button>
	</header>

	<div class="flex-1 overflow-auto p-6">
		{#if loading}
			<div class="flex items-center justify-center py-12">
				<Loader2 size={20} class="animate-spin text-muted-foreground" />
			</div>
		{:else if connections.length === 0}
			<div class="flex flex-col items-center justify-center py-16 text-center">
				<div class="rounded-full bg-muted p-4 mb-4">
					<Unplug size={24} class="text-muted-foreground" />
				</div>
				<h2 class="text-sm font-medium">No connections yet</h2>
				<p class="mt-1 text-xs text-muted-foreground max-w-sm">
					Create a connection to store API keys and credentials for your workflow actions.
				</p>
				<Button class="mt-4" size="sm" onclick={openNewDialog}>
					<Plus size={14} />
					New Connection
				</Button>
			</div>
		{:else}
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Name</TableHead>
						<TableHead>Piece</TableHead>
						<TableHead>Type</TableHead>
						<TableHead>Status</TableHead>
						<TableHead>Created</TableHead>
						<TableHead class="text-right">Actions</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{#each connections as conn (conn.id)}
						<TableRow>
							<TableCell class="font-medium text-xs">{conn.displayName}</TableCell>
							<TableCell>
								<span class="font-mono text-[10px] text-muted-foreground">{conn.pieceName}</span>
							</TableCell>
							<TableCell>
								<Badge variant="outline" class="text-[9px]">{conn.type}</Badge>
							</TableCell>
							<TableCell>
								<Badge variant={conn.status === 'ACTIVE' ? 'default' : conn.status === 'ERROR' ? 'destructive' : 'secondary'} class="text-[9px]">
									{conn.status}
								</Badge>
							</TableCell>
							<TableCell class="text-xs text-muted-foreground">{formatDate(conn.createdAt)}</TableCell>
							<TableCell class="text-right">
								{#if deleteConfirmId === conn.id}
									<div class="flex items-center justify-end gap-1">
										<span class="text-[10px] text-muted-foreground">Delete?</span>
										<Button variant="destructive" size="sm" class="h-6 text-[10px]" onclick={() => deleteConnection(conn.id)}>Yes</Button>
										<Button variant="ghost" size="sm" class="h-6 text-[10px]" onclick={() => (deleteConfirmId = null)}>No</Button>
									</div>
								{:else}
									<div class="flex items-center justify-end gap-0.5">
										<Tooltip.Root>
											<Tooltip.Trigger>
												<Button variant="ghost" size="icon" class="h-7 w-7" onclick={() => openRenameDialog(conn)}>
													<Pencil size={12} />
												</Button>
											</Tooltip.Trigger>
											<Tooltip.Content>Rename</Tooltip.Content>
										</Tooltip.Root>

										{#if isOAuth2(conn.type)}
											<Tooltip.Root>
												<Tooltip.Trigger>
													<Button variant="ghost" size="icon" class="h-7 w-7" onclick={() => reconnectOAuth2(conn)}>
														<RefreshCw size={12} />
													</Button>
												</Tooltip.Trigger>
												<Tooltip.Content>Reconnect OAuth2</Tooltip.Content>
											</Tooltip.Root>
										{/if}

										<Tooltip.Root>
											<Tooltip.Trigger>
												<Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground hover:text-destructive" onclick={() => (deleteConfirmId = conn.id)}>
													<Trash2 size={12} />
												</Button>
											</Tooltip.Trigger>
											<Tooltip.Content>Delete</Tooltip.Content>
										</Tooltip.Root>
									</div>
								{/if}
							</TableCell>
						</TableRow>
					{/each}
				</TableBody>
			</Table>
		{/if}
	</div>
</div>

<!-- New Connection Dialog -->
<Dialog open={showNewDialog} onOpenChange={(v) => { if (!v) showNewDialog = false; }}>
	<DialogContent class="sm:max-w-lg">
		<DialogHeader>
			<DialogTitle>New Connection</DialogTitle>
		</DialogHeader>
		<form class="space-y-4" onsubmit={(e) => { e.preventDefault(); createConnection(); }}>
			<!-- Piece Combobox -->
			<div class="space-y-1.5">
				<Label>Piece</Label>
				<Popover.Root bind:open={pieceSearchOpen}>
					<Popover.Trigger class="w-full">
						<Button variant="outline" class="w-full justify-between h-8 text-xs font-normal">
							{#if selectedPiece}
								<span class="flex items-center gap-2">
									{#if selectedPiece.logoUrl}
										<img src={selectedPiece.logoUrl} alt="" class="h-4 w-4 rounded" />
									{/if}
									{selectedPiece.displayName}
								</span>
							{:else}
								<span class="text-muted-foreground">Search pieces...</span>
							{/if}
							<ChevronsUpDown size={12} class="text-muted-foreground" />
						</Button>
					</Popover.Trigger>
					<Popover.Content class="w-[var(--bits-popover-anchor-width)] min-w-[400px] p-0" align="start">
						<Command.Root>
							<Command.Input placeholder="Search pieces..." bind:value={pieceSearch} class="text-xs" />
							<Command.List class="max-h-[200px]">
								<Command.Empty class="py-4 text-center text-xs text-muted-foreground">No pieces found.</Command.Empty>
								{#each filteredPieces.slice(0, 50) as piece (piece.name)}
									<Command.Item
										value={piece.name}
										onSelect={() => selectPiece(piece)}
										class="flex items-center gap-2 text-xs"
									>
										{#if piece.logoUrl}
											<img src={piece.logoUrl} alt="" class="h-4 w-4 rounded" />
										{:else}
											<div class="flex h-4 w-4 items-center justify-center rounded bg-muted text-[8px]">{piece.displayName.charAt(0)}</div>
										{/if}
										<span class="flex-1">{piece.displayName}</span>
										<Badge variant="outline" class="text-[8px] px-1">{piece.authType}</Badge>
										{#if formPieceName === piece.name}
											<Check size={12} class="text-primary" />
										{/if}
									</Command.Item>
								{/each}
							</Command.List>
						</Command.Root>
					</Popover.Content>
				</Popover.Root>
			</div>

			<!-- Display Name -->
			<div class="space-y-1.5">
				<Label for="displayName">Display Name</Label>
				<Input id="displayName" placeholder="e.g. My Slack Token" bind:value={formDisplayName} required class="text-xs" />
			</div>

			<!-- Type -->
			<div class="space-y-1.5">
				<Label>Type</Label>
				<Select.Root type="single" value={formType} onValueChange={(v) => { formType = v; }}>
					<Select.Trigger class="w-full text-xs">
						{formType.replace(/_/g, ' ')}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="SECRET_TEXT">Secret Text</Select.Item>
						<Select.Item value="BASIC_AUTH">Basic Auth</Select.Item>
						<Select.Item value="CUSTOM_AUTH">Custom Auth</Select.Item>
						<Select.Item value="OAUTH2">OAuth2</Select.Item>
						<Select.Item value="PLATFORM_OAUTH2">Platform OAuth2</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>

			<!-- Secret Value (for SECRET_TEXT) -->
			{#if formType === 'SECRET_TEXT'}
				<div class="space-y-1.5">
					<Label for="value">Secret Value</Label>
					<Textarea id="value" placeholder="Enter your API key or secret..." bind:value={formValue} required class="text-xs" />
				</div>
			{/if}

			<DialogFooter>
				<Button variant="outline" type="button" onclick={() => (showNewDialog = false)}>Cancel</Button>
				<Button type="submit" disabled={saving || !formPieceName}>
					{#if saving}
						<Loader2 size={12} class="animate-spin" />
					{/if}
					Create
				</Button>
			</DialogFooter>
		</form>
	</DialogContent>
</Dialog>

<!-- Rename Dialog -->
<Dialog open={renameDialogOpen} onOpenChange={(v) => { if (!v) { renameDialogOpen = false; renameConnection = null; } }}>
	<DialogContent class="sm:max-w-sm">
		<DialogHeader>
			<DialogTitle>Rename Connection</DialogTitle>
		</DialogHeader>
		<form class="space-y-4" onsubmit={(e) => { e.preventDefault(); submitRename(); }}>
			<div class="space-y-1.5">
				<Label for="renameName">Display Name</Label>
				<Input id="renameName" bind:value={renameValue} required class="text-xs" />
			</div>
			<DialogFooter>
				<Button variant="outline" type="button" onclick={() => { renameDialogOpen = false; renameConnection = null; }}>Cancel</Button>
				<Button type="submit" disabled={renaming}>
					{#if renaming}<Loader2 size={12} class="animate-spin" />{/if}
					Rename
				</Button>
			</DialogFooter>
		</form>
	</DialogContent>
</Dialog>
