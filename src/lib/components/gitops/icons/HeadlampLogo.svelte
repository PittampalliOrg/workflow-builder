<!--
  Official Headlamp icon. Sourced from the upstream Headlamp repository:
  https://github.com/kubernetes-sigs/headlamp/blob/main/frontend/src/resources/icon-light.svg
-->
<script lang="ts">
	type Props = {
		class?: string;
		title?: string;
	};

	let { class: className = "size-4", title = "Headlamp" }: Props = $props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	viewBox="0 0 25.506045 31.999998"
	fill="none"
	class={className}
	role="img"
	aria-label={title}
>
	<title>{title}</title>
	<path
		d="M25.506044 20.31088v-7.516407l-1.989637-2.597582V5.8307426L17.132988 3.5371329V0H8.3730569v3.5371329L1.9896373 5.8307426v4.3661484L0 12.794473v7.516407l1.9896373 2.680484L0 29.181347l12.766839 2.818652 12.739205-2.818652-1.989637-6.189983Z"
		fill="#fff200"
	/>
	<path
		d="M12.766839 22.991364c3.525472 0 6.38342-2.857948 6.38342-6.38342 0-3.525471-2.857948-6.383419-6.38342-6.383419s-6.3834194 2.857948-6.3834194 6.383419c0 3.525472 2.8579481 6.38342 6.3834194 6.38342Z"
		fill="#000"
	/>
</svg>
