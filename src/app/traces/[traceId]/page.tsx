import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TraceExplorer } from "@/components/TraceExplorer";
import { getTrace } from "@/lib/db";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ traceId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { traceId } = await params;
  return { title: `Trace ${traceId.slice(0, 12)} · ReactAgentDebugger` };
}

export default async function TracePage({ params }: PageProps) {
  const { traceId } = await params;

  let trace = null;
  let error: string | null = null;

  try {
    trace = getTrace(traceId);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-sm font-medium text-danger">Could not load trace</h1>
        <p className="mt-2 font-mono text-xs text-fg-muted">{error}</p>
      </main>
    );
  }

  if (!trace) notFound();

  return <TraceExplorer trace={trace} />;
}
