export function MastraAgentIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-label="Mastra Agent"
      className={className}
      width="48"
      height="48"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Mastra Agent</title>
      <rect x="3" y="4" width="18" height="12" rx="2" fill="#6366F1" />
      <circle cx="9" cy="10" r="1.5" fill="white" />
      <circle cx="15" cy="10" r="1.5" fill="white" />
      <path d="M9 13h6" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 16v2" stroke="#6366F1" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M16 16v2" stroke="#6366F1" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6 20h12" stroke="#6366F1" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
