export function PageHeader({
  title,
  description,
  eyebrow,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
}) {
  return (
    <header className="mb-8">
      {eyebrow && (
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-rose-600 dark:text-rose-400">
          {eyebrow}
        </p>
      )}
      <h1 className="bg-gradient-to-r from-rose-600 via-fuchsia-600 to-violet-600 bg-clip-text text-3xl font-bold tracking-tight text-transparent dark:from-rose-400 dark:via-fuchsia-400 dark:to-violet-400 md:text-4xl">
        {title}
      </h1>
      {description && (
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-zinc-600 dark:text-zinc-400">
          {description}
        </p>
      )}
    </header>
  );
}
