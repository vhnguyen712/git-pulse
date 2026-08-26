import { SettingsForm } from "@/components/settings-form";
import { PageHeader } from "@/components/page-header";

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <PageHeader
        title="Settings"
        description={
          <>
            Stored locally in <code className="font-mono">.gitpulse/data.db</code> —
            never leaves this machine. Values here take priority over{" "}
            <code className="font-mono">.env.local</code>.
          </>
        }
      />
      <SettingsForm />
    </div>
  );
}
