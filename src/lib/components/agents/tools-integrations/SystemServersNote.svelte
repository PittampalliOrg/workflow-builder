<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Sparkles } from '@lucide/svelte';
</script>

<div class="rounded-md border border-dashed bg-muted/30 p-3 space-y-1.5">
	<div class="flex items-center gap-2">
		<Sparkles class="size-3.5 text-muted-foreground" />
		<span class="text-xs font-medium">Always-on system tools</span>
		<Badge variant="secondary" class="text-[10px]">auto-added to sessions</Badge>
	</div>
	<p class="text-[11px] text-muted-foreground">
		The <span class="font-medium text-foreground">goal</span> MCP server
		(<code class="text-[10px]">create_goal</code>, <code class="text-[10px]">update_goal</code>,
		<code class="text-[10px]">get_goal</code>) is wired into every MCP-capable session at spawn
		time — it never appears in this agent's config. It is present on direct sessions and is
		<span class="font-medium">absent on the workflow-step path</span>.
	</p>
</div>
