export type Theme = 'light' | 'dark' | 'system';

export function createUiStore() {
	let theme = $state<Theme>('system');
	let sidebarCollapsed = $state(false);
	let rightPanelWidth = $state<string | null>(null);

	function toggleSidebar() {
		sidebarCollapsed = !sidebarCollapsed;
	}

	function setTheme(t: Theme) {
		theme = t;
		if (typeof document !== 'undefined') {
			const root = document.documentElement;
			root.classList.remove('light', 'dark');
			if (t === 'system') {
				const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
				root.classList.add(prefersDark ? 'dark' : 'light');
			} else {
				root.classList.add(t);
			}
		}
	}

	return {
		get theme() { return theme; },
		get sidebarCollapsed() { return sidebarCollapsed; },
		set sidebarCollapsed(v) { sidebarCollapsed = v; },
		get rightPanelWidth() { return rightPanelWidth; },
		set rightPanelWidth(v) { rightPanelWidth = v; },
		toggleSidebar,
		setTheme
	};
}
