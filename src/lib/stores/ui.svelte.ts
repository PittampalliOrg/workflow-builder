export type Theme = 'light' | 'dark' | 'system';
export type RightPanelTab = 'properties' | 'code' | 'ai' | 'runs';

export function createUiStore() {
	let theme = $state<Theme>('system');
	let sidebarCollapsed = $state(false);
	let rightPanelOpen = $state(true);
	let rightPanelTab = $state<RightPanelTab>('ai');
	let rightPanelWidth = $state<string | null>(null);

	function toggleSidebar() {
		sidebarCollapsed = !sidebarCollapsed;
	}

	/** Toggle the right panel. If tab is provided and panel is already open on that tab, close it. Otherwise open on that tab. */
	function toggleRightPanel(tab?: RightPanelTab) {
		if (rightPanelOpen && (!tab || rightPanelTab === tab)) {
			rightPanelOpen = false;
		} else {
			rightPanelOpen = true;
			if (tab) rightPanelTab = tab;
		}
	}

	function openRightPanel(tab: RightPanelTab) {
		rightPanelOpen = true;
		rightPanelTab = tab;
	}

	function closeRightPanel() {
		rightPanelOpen = false;
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
		get rightPanelOpen() { return rightPanelOpen; },
		set rightPanelOpen(v) { rightPanelOpen = v; },
		get rightPanelTab() { return rightPanelTab; },
		set rightPanelTab(v: RightPanelTab) { rightPanelTab = v; },
		get rightPanelWidth() { return rightPanelWidth; },
		set rightPanelWidth(v) { rightPanelWidth = v; },
		// Legacy compat — maps to right panel AI tab
		get aiPanelOpen() { return rightPanelOpen && rightPanelTab === 'ai'; },
		set aiPanelOpen(v: boolean) {
			if (v) { rightPanelOpen = true; rightPanelTab = 'ai'; }
			else if (rightPanelTab === 'ai') { rightPanelOpen = false; }
		},
		toggleSidebar,
		toggleRightPanel,
		openRightPanel,
		closeRightPanel,
		toggleAiPanel() { toggleRightPanel('ai'); },
		setTheme
	};
}
