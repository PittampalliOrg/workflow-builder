<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Shield, Lock, Clock, FileCheck2, ExternalLink } from 'lucide-svelte';

	type AuditEvent = {
		id: string;
		at: string;
		kind: 'credential.access' | 'member.added' | 'config.change';
		summary: string;
		executionId?: string;
		actor?: string;
	};

	let events = $state<AuditEvent[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;

	async function load() {
		try {
			const res = await fetch('/api/v1/security/audit');
			if (!res.ok) {
				errorMessage = `Failed to load audit log (${res.status})`;
				return;
			}
			const data = (await res.json()) as { events: AuditEvent[] };
			events = data.events ?? [];
			errorMessage = null;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function formatRelative(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return new Date(iso).toLocaleDateString();
	}

	function kindLabel(kind: AuditEvent['kind']): string {
		switch (kind) {
			case 'credential.access':
				return 'Credential';
			case 'member.added':
				return 'Member';
			case 'config.change':
				return 'Config';
		}
	}

	onMount(() => {
		void load();
		timer = setInterval(() => void load(), 60_000);
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});
</script>

<div class="space-y-6">
	<div>
		<h2 class="text-lg font-semibold flex items-center gap-2">
			<Shield class="size-4" /> Security & compliance
		</h2>
		<p class="text-xs text-muted-foreground mt-1">
			Compliance posture, data retention, and an append-only audit log of credential
			access, membership changes, and runtime-config writes.
		</p>
	</div>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription class="text-xs">{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
		<Card>
			<CardHeader class="pb-2">
				<CardTitle class="text-sm flex items-center gap-2">
					<FileCheck2 class="size-4 text-primary" /> SOC2
				</CardTitle>
				<CardDescription class="text-xs">Type II, Anthropic-side</CardDescription>
			</CardHeader>
			<CardContent>
				<Badge variant="outline" class="text-[10px] bg-green-600/15 text-green-700 dark:text-green-400 border-transparent">
					Inherited
				</Badge>
				<p class="text-[11px] text-muted-foreground mt-2">
					Claude API inherits Anthropic's SOC2 Type II report; this deployment adds
					self-hosted controls (RLS, credential broker, audit log).
				</p>
			</CardContent>
		</Card>

		<Card>
			<CardHeader class="pb-2">
				<CardTitle class="text-sm flex items-center gap-2">
					<Lock class="size-4 text-primary" /> HIPAA
				</CardTitle>
				<CardDescription class="text-xs">BAA required</CardDescription>
			</CardHeader>
			<CardContent>
				<Badge variant="outline" class="text-[10px]">Not signed</Badge>
				<p class="text-[11px] text-muted-foreground mt-2">
					This self-hosted instance does not automatically qualify for HIPAA. Contact
					Anthropic to execute a BAA if you need to process PHI through the API.
				</p>
			</CardContent>
		</Card>

		<Card>
			<CardHeader class="pb-2">
				<CardTitle class="text-sm flex items-center gap-2">
					<Shield class="size-4 text-primary" /> GDPR
				</CardTitle>
				<CardDescription class="text-xs">Data residency: self-hosted</CardDescription>
			</CardHeader>
			<CardContent>
				<Badge variant="outline" class="text-[10px] bg-green-600/15 text-green-700 dark:text-green-400 border-transparent">
					Applicable
				</Badge>
				<p class="text-[11px] text-muted-foreground mt-2">
					All workspace data (sessions, vaults, files) lives in the cluster's Postgres +
					ClickHouse. LLM traffic leaves the cluster only when calling provider APIs.
				</p>
			</CardContent>
		</Card>
	</div>

	<Card>
		<CardHeader>
			<CardTitle class="text-base flex items-center gap-2">
				<Clock class="size-4" /> Data retention
			</CardTitle>
			<CardDescription class="text-xs">
				Per-table defaults — overridable via Postgres partitioning or cron cleanup.
			</CardDescription>
		</CardHeader>
		<CardContent>
			<table class="w-full text-xs">
				<thead class="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b">
					<tr>
						<th class="pb-2 font-medium">Table</th>
						<th class="pb-2 font-medium">Retention</th>
						<th class="pb-2 font-medium">Purge policy</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					<tr>
						<td class="py-2 font-mono">sessions + session_events</td>
						<td class="py-2">Indefinite</td>
						<td class="py-2 text-muted-foreground">Archive via API DELETE; hard-delete manual</td>
					</tr>
					<tr>
						<td class="py-2 font-mono">credential_access_logs</td>
						<td class="py-2">30 days (displayed)</td>
						<td class="py-2 text-muted-foreground">No server-side purge; grep by date</td>
					</tr>
					<tr>
						<td class="py-2 font-mono">runtime_config_audit_logs</td>
						<td class="py-2">Indefinite</td>
						<td class="py-2 text-muted-foreground">Partition by month for rolling cleanup</td>
					</tr>
					<tr>
						<td class="py-2 font-mono">otel_traces (ClickHouse)</td>
						<td class="py-2">7 days (queried window)</td>
						<td class="py-2 text-muted-foreground">TTL set on the ClickHouse table</td>
					</tr>
				</tbody>
			</table>
		</CardContent>
	</Card>

	<Card>
		<CardHeader>
			<CardTitle class="text-base">Encryption + proxy</CardTitle>
			<CardDescription class="text-xs">How credentials are handled at runtime.</CardDescription>
		</CardHeader>
		<CardContent class="text-sm space-y-2">
			<p>
				<strong>Vault credentials</strong> are encrypted with AES-256-CBC at rest; a random
				IV is generated per value. Key material lives in <code>AP_ENCRYPTION_KEY</code>.
			</p>
			<p>
				<strong>Proxy pattern</strong>: credentials are injected into outbound MCP / tool
				calls by <code>function-router</code> after the request leaves the sandbox. The
				agent container never sees the decrypted secret.
			</p>
			<p>
				<strong>OpenShell isolation</strong> —
				<a
					href="https://docs.openshell.io/security-model"
					target="_blank"
					rel="noreferrer"
					class="text-primary hover:underline"
				>
					security model <ExternalLink class="inline size-3" />
				</a>
			</p>
		</CardContent>
	</Card>

	<Card>
		<CardHeader>
			<CardTitle class="text-base">Audit log</CardTitle>
			<CardDescription class="text-xs">
				Last 30 days of credential access, membership changes, and runtime-config writes
				in this workspace. Refreshes every 60s.
			</CardDescription>
		</CardHeader>
		<CardContent class="p-0">
			{#if loading && events.length === 0}
				<div class="p-6 text-center text-xs text-muted-foreground">Loading audit log…</div>
			{:else if events.length === 0}
				<div class="p-6 text-center text-xs text-muted-foreground">
					No audit events in the last 30 days.
				</div>
			{:else}
				<table class="w-full text-xs">
					<thead class="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b">
						<tr>
							<th class="px-4 py-2 font-medium">Kind</th>
							<th class="px-4 py-2 font-medium">Event</th>
							<th class="px-4 py-2 font-medium">When</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each events as e (e.id)}
							<tr>
								<td class="px-4 py-2">
									<Badge variant="outline" class="text-[10px]">
										{kindLabel(e.kind)}
									</Badge>
								</td>
								<td class="px-4 py-2">{e.summary}</td>
								<td class="px-4 py-2 text-muted-foreground">{formatRelative(e.at)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</CardContent>
	</Card>
</div>
