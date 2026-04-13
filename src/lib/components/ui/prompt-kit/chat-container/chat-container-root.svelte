<script lang="ts">
	import { setChatContainerContext, type ResizeMode, type InitialMode } from "./chat-container-context.svelte";
	import { cn } from "$lib/components/ui/utils";

	let {
		children,
		class: className,
		resize = "smooth" as ResizeMode,
		initial = "instant" as InitialMode,
		...restProps
	}: {
		children?: import("svelte").Snippet;
		class?: string;
		resize?: ResizeMode;
		initial?: InitialMode;
		[key: string]: any;
	} = $props();

	// These are intentionally read once at mount — resize/initial modes don't change after init
	const resizeMode = resize;
	const initialMode = initial;
	const context = setChatContainerContext(resizeMode, initialMode);

	function attachContainer(element: HTMLElement) {
		context.setElement(element);
	}
</script>

<div
	{@attach attachContainer}
	class={cn("flex flex-col overflow-y-auto", className)}
	role="log"
	{...restProps}
>
	{@render children?.()}
</div>
