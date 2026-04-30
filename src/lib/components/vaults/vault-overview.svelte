<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Clock, KeyRound, RefreshCw, Shield } from '@lucide/svelte';
	import type { VaultCredentialSummary, VaultDetail } from '$lib/types/vaults';

	interface Props {
		vault: VaultDetail;
		credentials: VaultCredentialSummary[];
		onRotate?: (credId: string) => void;
	}
	const { vault, credentials, onRotate }: Props = $props();

	function expiryStatus(iso: string | null): {
		label: string;
		severity: 'ok' | 'warn' | 'expired' | 'none';
	} {
		if (!iso) return { label: 'no expiry', severity: 'none' };
		const t = new Date(iso).getTime();
		const now = Date.now();
		if (t <= now) return { label: 'expired', severity: 'expired' };
		const delta = t - now;
		const day = 24 * 3_600_000;
		if (delta < day) return { label: 'expires < 24h', severity: 'warn' };
		if (delta < 7 * day)
			return { label: `expires ${Math.ceil(delta / day)}d`, severity: 'warn' };
		return { label: `expires ${new Date(iso).toLocaleDateString()}`, severity: 'ok' };
	}
	function authTypeBadge(t: string): string {
		switch (t) {
			case 'mcp_oauth':
				return 'bg-indigo-500/15 text-indigo-300 border-transparent';
			case 'bearer':
				return 'bg-amber-500/15 text-amber-300 border-transparent';
			case 'basic':
				return 'bg-green-600/15 text-green-300 border-transparent';
			case 'secret_text':
				return 'bg-slate-500/15 text-slate-300 border-transparent';
			default:
				return '';
		}
	}
	function formatRelative(iso: string | null): string {
		if (!iso) return '—';
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return `${Math.floor(diff / 86_400_000)}d ago`;
	}
</script>

<div class="space-y-6">
	<!-- Summary -->
	<section class="space-y-2">
		<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
			Summary
		</h3>
		<div class="rounded border bg-muted/20 p-3 space-y-1.5 text-[12px]">
			{#if vault.description}
				<p class="text-foreground/90">{vault.description}</p>
			{/if}
			<div class="flex flex-wrap items-center gap-2 text-muted-foreground">
				<Badge variant="outline" class="text-[10px] gap-1">
					<KeyRound class="size-2.5" />
					{vault.credentialCount} credential{vault.credentialCount === 1 ? '' : 's'}
				</Badge>
				<Badge
					variant="outline"
					class="text-[10px] {vault.isArchived
						? 'bg-muted'
						: 'bg-green-600/15 text-green-700 dark:text-green-400 border-transparent'}"
				>
					{vault.isArchived ? 'Archived' : 'Active'}
				</Badge>
				<span class="text-[11px] text-muted-foreground">
					Created {new Date(vault.createdAt).toLocaleDateString()}
				</span>
			</div>
		</div>
	</section>

	<!-- Credentials -->
	<section class="space-y-2">
		<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
			Credentials
		</h3>
		{#if credentials.length === 0}
			<p class="rounded border bg-muted/20 p-4 text-center text-xs text-muted-foreground">
				No credentials yet. Add one from the Secrets tab — values are encrypted at rest
				with <code class="text-[10px]">AES-256-CBC</code> and never returned in plaintext.
			</p>
		{:else}
			<div class="divide-y rounded border bg-muted/20">
				{#each credentials as c (c.id)}
					{@const exp = expiryStatus(c.expiresAt)}
					<div class="flex items-start gap-3 px-3 py-2.5">
						<div class="min-w-0 flex-1 space-y-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-sm font-medium">{c.displayName}</span>
								<Badge variant="outline" class="text-[10px] {authTypeBadge(c.authType)}">
									{c.authType}
								</Badge>
								{#if c.mcpServerUrl}
									<code class="text-[10px] text-muted-foreground truncate max-w-[280px]">
										{c.mcpServerUrl}
									</code>
								{/if}
							</div>
							<div class="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
								{#if exp.severity === 'expired'}
									<Badge variant="outline" class="text-[10px] bg-red-500/15 text-red-400 border-transparent gap-1">
										<Clock class="size-2.5" /> {exp.label}
									</Badge>
								{:else if exp.severity === 'warn'}
									<Badge variant="outline" class="text-[10px] bg-amber-500/15 text-amber-400 border-transparent gap-1">
										<Clock class="size-2.5" /> {exp.label}
									</Badge>
								{:else if exp.severity === 'ok'}
									<Badge variant="outline" class="text-[10px] gap-1">
										<Shield class="size-2.5 text-green-500" />
										{exp.label}
									</Badge>
								{:else}
									<Badge variant="outline" class="text-[10px]">no expiry</Badge>
								{/if}
								<span>Last refreshed: {formatRelative(c.lastRefreshedAt)}</span>
								<span class="opacity-60">·</span>
								<span>Last used: {formatRelative(c.lastUsedAt)}</span>
							</div>
						</div>
						{#if c.authType === 'mcp_oauth' && onRotate}
							<Button
								variant="outline"
								size="sm"
								class="h-7 gap-1 text-[11px]"
								onclick={() => onRotate(c.id)}
							>
								<RefreshCw class="size-3" /> Rotate
							</Button>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>
</div>
