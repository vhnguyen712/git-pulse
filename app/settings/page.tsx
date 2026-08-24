import { SettingsForm } from "@/components/settings-form";

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="font-heading text-xl font-semibold text-on-surface">
          Settings
        </h1>
        <p className="text-sm text-on-surface-variant">
          Stored locally in <code className="font-mono">.gitpulse/data.db</code> —
          never leaves this machine. Values here take priority over{" "}
          <code className="font-mono">.env.local</code>.
        </p>
      </div>
      <SettingsForm />
    </div>
  );
}
