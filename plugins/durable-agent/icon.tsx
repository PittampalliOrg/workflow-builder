export function DurableAgentIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-label="Durable Agent"
      className={className}
      width="48"
      height="48"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Durable Agent</title>
      <path d="M12 8V4H8" stroke="#6366F1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="4" y="8" width="16" height="12" rx="2" fill="#6366F1" />
      <path d="M2 14h2" stroke="#6366F1" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M20 14h2" stroke="#6366F1" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="9" cy="14" r="1.5" fill="white" />
      <circle cx="15" cy="14" r="1.5" fill="white" />
    </svg>
  );
}
