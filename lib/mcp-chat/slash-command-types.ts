export type SlashCommandScope = {
	id: string; // "server:Demo" or "tool:Demo/weather_dashboard"
	type: "server" | "tool";
	serverName: string;
	toolName?: string; // only when type === "tool"
	label: string; // display text for badge
};

export type AutocompleteItem =
	| { type: "server"; serverName: string; toolCount: number }
	| {
			type: "tool";
			serverName: string;
			toolName: string;
			description?: string;
	  };

export const BUILTIN_TOOLS = [
	{ name: "weather_dashboard", description: "Interactive weather dashboard" },
	{ name: "metric_dashboard", description: "KPI/metrics dashboard" },
	{ name: "color_palette", description: "Color palette generator" },
	{ name: "code_viewer", description: "Code syntax highlighting" },
];
