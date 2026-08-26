import { getAllSuggestions } from "@/lib/suggestions";
import { SuggestionsDashboard } from "@/components/suggestions-dashboard";

// Reflects local DB state that changes as syncs run and items are pushed/removed.
export const dynamic = "force-dynamic";

export default async function SuggestionsPage() {
  const data = await getAllSuggestions();

  return (
    <div className="flex h-full flex-col px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="font-heading text-xl font-semibold text-on-surface">
          Suggestions
        </h1>
        <p className="text-sm text-on-surface-variant">
          Every next step and idea across your repos, in one place.
        </p>
      </div>
      <SuggestionsDashboard initial={data} />
    </div>
  );
}
