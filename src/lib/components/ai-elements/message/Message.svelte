<script lang="ts">
	import { cn } from "$lib/components/ui/utils.js";
	import { User, Bot, Settings, Wrench } from "@lucide/svelte";
	import type { HTMLAttributes } from "svelte/elements";

	type MessageProps = HTMLAttributes<HTMLDivElement> & {
		from: "user" | "assistant" | "system" | "tool";
	};

	let { class: className = "", from, children, ...restProps }: MessageProps = $props();

	const messageClasses = $derived.by(() =>
		cn(
			"group flex w-full items-start gap-2.5 py-2",
			from === "user" ? "is-user" : from === "tool" ? "is-tool" : from === "system" ? "is-system is-assistant" : "is-assistant",
			className
		)
	);

	const iconConfig = $derived({
		user: { icon: User, bg: "bg-primary text-primary-foreground" },
		assistant: { icon: Bot, bg: "bg-secondary text-foreground" },
		system: { icon: Settings, bg: "bg-amber-500/10 text-amber-500" },
		tool: { icon: Wrench, bg: "bg-muted text-muted-foreground" },
	}[from]);
</script>

<div class={messageClasses} {...restProps}>
	<div class={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full", iconConfig.bg)}>
		<iconConfig.icon class="h-3.5 w-3.5" />
	</div>
	{@render children?.()}
</div>
