export default function ObservabilityLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<div className="pointer-events-auto h-full overflow-y-auto">{children}</div>
	);
}
