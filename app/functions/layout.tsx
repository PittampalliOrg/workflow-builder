import type { ReactNode } from "react";

export default function FunctionsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-auto min-h-screen bg-background">
      {children}
    </div>
  );
}
