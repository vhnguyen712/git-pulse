import { Clock } from "lucide-react";

export function RateLimitNotice({ resetAt }: { resetAt: number }) {
  const resetDate = new Date(resetAt * 1000);
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-outline-variant bg-surface p-6 text-center">
      <Clock className="size-6 text-accent-orange" />
      <h2 className="font-heading text-sm font-semibold text-on-surface">
        GitHub rate limit reached
      </h2>
      <p className="text-xs text-on-surface-variant">
        Resets at {resetDate.toLocaleTimeString()} ({resetDate.toLocaleDateString()}).
        Try again after that.
      </p>
    </div>
  );
}
