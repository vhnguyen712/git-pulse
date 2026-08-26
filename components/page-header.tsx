export function PageHeader({
  title,
  description,
}: {
  title: string;
  description: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <h1 className="font-heading text-xl font-semibold text-on-surface">{title}</h1>
      <p className="text-sm text-on-surface-variant">{description}</p>
    </div>
  );
}
