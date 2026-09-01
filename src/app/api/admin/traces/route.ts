import { clearAll, stats } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Local debugging tool — destructive, guarded by an explicit user action. */
export async function DELETE(): Promise<Response> {
  try {
    clearAll();
    return Response.json({ ok: true, ...stats() });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<Response> {
  try {
    return Response.json({ ok: true, ...stats() });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
