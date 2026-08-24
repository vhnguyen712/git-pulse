import Link from "next/link";
import { KeyRound } from "lucide-react";

export function ConfigNotice({ message }: { message: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-outline-variant bg-surface p-6 text-center">
      <KeyRound className="size-6 text-accent-amber" />
      <h2 className="font-heading text-sm font-semibold text-on-surface">
        Setup required
      </h2>
      <p className="text-xs text-on-surface-variant">{message}</p>
      <Link
        href="/settings"
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-opacity hover:opacity-90"
      >
        Go to Settings
      </Link>
      <p className="text-[11px] text-on-surface-variant">
        Or set it in <code className="font-mono">.env.local</code> and restart.
      </p>
    </div>
  );
}
