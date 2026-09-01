"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/** Two-step destructive action — no window.confirm, no accidental wipe. */
export function ClearTracesButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="h-8 rounded-md border border-line bg-surface px-3 text-xs text-fg-muted transition-colors hover:border-danger-dim hover:text-danger"
      >
        Clear all
      </button>
    );
  }

  const run = () => {
    startTransition(async () => {
      await fetch("/api/admin/traces", { method: "DELETE" });
      setConfirming(false);
      router.refresh();
    });
  };

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="h-8 rounded-md border border-danger-dim bg-danger/10 px-3 text-xs text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
      >
        {pending ? "Clearing…" : "Confirm delete"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={pending}
        className="h-8 rounded-md border border-line bg-surface px-3 text-xs text-fg-muted transition-colors hover:text-fg"
      >
        Cancel
      </button>
    </span>
  );
}
