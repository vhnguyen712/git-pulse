import { getAllSuggestions } from "@/lib/suggestions";
import { SuggestionsDashboard } from "@/components/suggestions-dashboard";
import { PageHeader } from "@/components/page-header";

// Reflects local DB state that changes as syncs run and items are pushed/removed.
export const dynamic = "force-dynamic";

export default async function SuggestionsPage() {
  const data = await getAllSuggestions();

  return (
    <div className="flex h-full flex-col px-4 py-6 sm:px-6">
      <PageHeader
        title="Suggestions"
        description="Every next step and idea across your repos, in one place."
      />
      <SuggestionsDashboard initial={data} />
    </div>
  );
}
