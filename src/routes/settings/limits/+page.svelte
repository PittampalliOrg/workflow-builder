<script lang="ts">
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Gauge, ExternalLink } from 'lucide-svelte';
</script>

<div class="space-y-6">
	<div>
		<h2 class="text-lg font-semibold flex items-center gap-2">
			<Gauge class="size-4" /> Limits
		</h2>
		<p class="text-xs text-muted-foreground mt-1">
			Rate and spend limits for this workspace.
		</p>
	</div>

	<Alert>
		<AlertDescription class="text-xs">
			Self-hosted rate limiting is governed by the underlying LLM providers. See
			<a href="/usage" class="text-primary hover:underline">
				Usage <ExternalLink class="inline size-3" />
			</a>
			for real-time consumption.
		</AlertDescription>
	</Alert>

	<Card>
		<CardHeader>
			<CardTitle class="text-base">Rate limits (per LLM provider)</CardTitle>
			<CardDescription>
				Configured via Azure Key Vault + provider-side settings. Per-workspace quotas land here.
			</CardDescription>
		</CardHeader>
		<CardContent>
			<table class="w-full text-xs">
				<thead class="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b">
					<tr>
						<th class="pb-2 font-medium">Model</th>
						<th class="pb-2 font-medium text-right">RPM</th>
						<th class="pb-2 font-medium text-right">TPM (input)</th>
						<th class="pb-2 font-medium text-right">TPM (output)</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					<tr>
						<td class="py-2">anthropic/claude-opus-4-7</td>
						<td class="py-2 text-right text-muted-foreground">provider-set</td>
						<td class="py-2 text-right text-muted-foreground">provider-set</td>
						<td class="py-2 text-right text-muted-foreground">provider-set</td>
					</tr>
					<tr>
						<td class="py-2">anthropic/claude-sonnet-4-6</td>
						<td class="py-2 text-right text-muted-foreground">provider-set</td>
						<td class="py-2 text-right text-muted-foreground">provider-set</td>
						<td class="py-2 text-right text-muted-foreground">provider-set</td>
					</tr>
				</tbody>
			</table>
		</CardContent>
	</Card>

	<Card>
		<CardHeader>
			<CardTitle class="text-base">Session limits</CardTitle>
			<CardDescription>
				Active session cap + per-session token ceiling. Enforced by the workflow-orchestrator.
			</CardDescription>
		</CardHeader>
		<CardContent>
			<ul class="text-xs space-y-1 text-muted-foreground">
				<li>Concurrent sessions per workspace: unlimited (Dapr workflow capacity)</li>
				<li>Per-session max turns: 120 (default); configurable via agent config</li>
				<li>Per-session timeout: 120 minutes (default); configurable via agent config</li>
				<li>Idle session sweeper: runs daily via K8s CronJob</li>
			</ul>
		</CardContent>
	</Card>
</div>
