<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { RefreshCw, Loader2 } from 'lucide-svelte';

	interface Props {
		sandboxName: string;
	}

	let { sandboxName }: Props = $props();

	interface Process {
		pid: string;
		user: string;
		cpu: string;
		mem: string;
		command: string;
	}

	let processes = $state.raw<Process[]>([]);
	let loading = $state(true);
	let autoRefresh = $state(false);
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	async function loadProcesses() {
		loading = true;
		try {
			const res = await fetch(`/api/sandboxes/${encodeURIComponent(sandboxName)}/files`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'read', path: '/dev/null' })
			});
			// Use exec directly
			const execRes = await fetch(
				`/api/sandboxes/${encodeURIComponent(sandboxName)}/exec`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ command: 'ps aux --sort=-%cpu 2>/dev/null || ps aux', timeout: 5 })
				}
			);
			if (execRes.ok) {
				const data = await execRes.json();
				processes = parsePs(data.stdout ?? '');
			}
		} catch {
			// silent
		} finally {
			loading = false;
		}
	}

	function parsePs(stdout: string): Process[] {
		const lines = stdout.trim().split('\n');
		if (lines.length < 2) return [];
		// Skip header line
		return lines.slice(1).map((line) => {
			const parts = line.trim().split(/\s+/);
			return {
				user: parts[0] ?? '',
				pid: parts[1] ?? '',
				cpu: parts[2] ?? '0',
				mem: parts[3] ?? '0',
				command: parts.slice(10).join(' ') || parts.slice(4).join(' ')
			};
		}).filter((p) => p.pid);
	}

	function toggleAutoRefresh() {
		autoRefresh = !autoRefresh;
		if (autoRefresh) {
			refreshTimer = setInterval(loadProcesses, 5000);
		} else if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	}

	$effect(() => {
		loadProcesses();
		return () => {
			if (refreshTimer) clearInterval(refreshTimer);
		};
	});
</script>

<div class="rounded-lg border border-border p-4">
	<div class="flex items-center justify-between mb-3">
		<h3 class="text-sm font-semibold">Processes</h3>
		<div class="flex items-center gap-1">
			<Button
				variant={autoRefresh ? 'default' : 'ghost'}
				size="sm"
				class="h-6 text-[10px]"
				onclick={toggleAutoRefresh}
			>
				{autoRefresh ? 'Auto: ON' : 'Auto: OFF'}
			</Button>
			<Button variant="ghost" size="icon" class="h-6 w-6" onclick={loadProcesses}>
				<RefreshCw class="h-3 w-3" />
			</Button>
		</div>
	</div>

	{#if loading && processes.length === 0}
		<div class="flex items-center justify-center py-4">
			<Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
		</div>
	{:else}
		<div class="overflow-auto max-h-48">
			<table class="w-full text-xs">
				<thead>
					<tr class="border-b border-border text-left text-muted-foreground">
						<th class="pb-1 pr-3">PID</th>
						<th class="pb-1 pr-3">USER</th>
						<th class="pb-1 pr-3 text-right">CPU%</th>
						<th class="pb-1 pr-3 text-right">MEM%</th>
						<th class="pb-1">COMMAND</th>
					</tr>
				</thead>
				<tbody>
					{#each processes as proc}
						<tr class="border-b border-border/50 last:border-0">
							<td class="py-0.5 pr-3 font-mono text-muted-foreground">{proc.pid}</td>
							<td class="py-0.5 pr-3">{proc.user}</td>
							<td class="py-0.5 pr-3 text-right font-mono {parseFloat(proc.cpu) > 50 ? 'text-red-400' : ''}">{proc.cpu}</td>
							<td class="py-0.5 pr-3 text-right font-mono">{proc.mem}</td>
							<td class="py-0.5 truncate max-w-[200px] font-mono text-muted-foreground" title={proc.command}>{proc.command}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
