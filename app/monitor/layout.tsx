// Monitor layout - sidebar is provided by root layout
// This layout just ensures pointer-events work correctly for monitor pages
export default function MonitorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="pointer-events-auto h-full">{children}</div>;
}
