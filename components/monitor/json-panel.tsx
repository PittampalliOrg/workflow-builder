"use client";

import { Check } from "lucide-react";
import { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ============================================================================
// SyntaxHighlightedJson Component
// ============================================================================

type SyntaxHighlightedJsonProps = {
  data: unknown;
  className?: string;
  fontSize?: string;
};

export function SyntaxHighlightedJson({
  data,
  className,
  fontSize = "0.75rem",
}: SyntaxHighlightedJsonProps) {
  const jsonString = JSON.stringify(data, null, 2);

  return (
    <SyntaxHighlighter
      className={cn("!m-0 !p-0 !bg-transparent", className)}
      codeTagProps={{
        className: "font-mono",
        style: { fontSize },
      }}
      customStyle={{
        margin: 0,
        padding: 0,
        fontSize,
        background: "transparent",
        overflowX: "auto",
        overflowWrap: "break-word",
        wordBreak: "break-all",
      }}
      language="json"
      style={oneDark}
    >
      {jsonString}
    </SyntaxHighlighter>
  );
}

// ============================================================================
// JsonPanel Component
// ============================================================================

type JsonPanelProps = {
  title: string;
  data: unknown;
  className?: string;
  maxHeight?: string;
  showExpand?: boolean;
};

export function JsonPanel({
  title,
  data,
  className,
  maxHeight = "300px",
  showExpand = true,
}: JsonPanelProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const jsonString = JSON.stringify(data, null, 2);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(jsonString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <>
      <div
        className={cn(
          "overflow-hidden rounded-lg border bg-[#1e2433]",
          className
        )}
      >
        {/* Header - Diagrid style */}
        <div className="flex items-center justify-between border-gray-700 border-b px-4 py-2">
          <span className="font-medium text-gray-300 text-sm">{title}</span>
          <Button
            className="h-auto px-0 py-0 text-teal-400 hover:bg-transparent hover:text-teal-300"
            onClick={handleCopy}
            size="sm"
            variant="ghost"
          >
            {copied ? (
              <span className="flex items-center gap-1">
                <Check className="h-3.5 w-3.5" />
                Copied
              </span>
            ) : (
              "Copy"
            )}
          </Button>
        </div>

        {/* Content with syntax highlighting */}
        <div className="relative overflow-auto p-4" style={{ maxHeight }}>
          <SyntaxHighlightedJson data={data} />

          {/* Expand button - bottom right */}
          {showExpand && (
            <Button
              className="absolute right-2 bottom-2 h-auto gap-1 px-2 py-1 text-teal-400 hover:bg-transparent hover:text-teal-300"
              onClick={() => setExpanded(true)}
              size="sm"
              variant="ghost"
            >
              <svg
                fill="none"
                height="14"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
                width="14"
              >
                <title>Expand</title>
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" x2="14" y1="3" y2="10" />
                <line x1="3" x2="10" y1="21" y2="14" />
              </svg>
              Expand
            </Button>
          )}
        </div>
      </div>

      {/* Expanded Modal */}
      <Dialog onOpenChange={setExpanded} open={expanded}>
        <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col border-gray-700 bg-[#1a1f2e]">
          <DialogHeader className="flex flex-row items-center justify-between">
            <DialogTitle className="text-gray-200">{title}</DialogTitle>
            <Button
              className="h-auto px-0 py-0 text-teal-400 hover:bg-transparent hover:text-teal-300"
              onClick={handleCopy}
              size="sm"
              variant="ghost"
            >
              {copied ? (
                <span className="flex items-center gap-1">
                  <Check className="h-3.5 w-3.5" />
                  Copied
                </span>
              ) : (
                "Copy"
              )}
            </Button>
          </DialogHeader>
          <div className="flex-1 overflow-auto rounded-lg border border-gray-700 bg-[#1e2433] p-4">
            <SyntaxHighlightedJson data={data} fontSize="0.875rem" />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
