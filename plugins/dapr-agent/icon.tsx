export function DaprAgentIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-label="Dapr Agent"
			className={className}
			fill="none"
			height="48"
			viewBox="0 0 24 24"
			width="48"
			xmlns="http://www.w3.org/2000/svg"
		>
			<title>Dapr Agent</title>
			<rect fill="#0F766E" height="12" rx="2" width="16" x="4" y="7" />
			<path
				d="M8 5h8"
				stroke="#0F766E"
				strokeLinecap="round"
				strokeWidth="1.5"
			/>
			<path
				d="M8 19h8"
				stroke="#0F766E"
				strokeLinecap="round"
				strokeWidth="1.5"
			/>
			<circle cx="9" cy="13" fill="white" r="1.5" />
			<circle cx="15" cy="13" fill="white" r="1.5" />
			<path
				d="M12 7V3"
				stroke="#0F766E"
				strokeLinecap="round"
				strokeWidth="1.5"
			/>
			<path
				d="M12 23v-4"
				stroke="#0F766E"
				strokeLinecap="round"
				strokeWidth="1.5"
			/>
		</svg>
	);
}
