import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReactAgentDebugger",
  description:
    "A debugger for ReAct agents — trace replay, waterfalls, and root-cause analysis over OTLP/GenAI spans.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas text-fg antialiased">{children}</body>
    </html>
  );
}
