import { LockKeyhole } from "lucide-react";
import type { ReactNode } from "react";

export function SharedEmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <section className="glass flex w-full max-w-md flex-col items-center gap-3 rounded-lg p-6 text-center">
        <LockKeyhole className="size-5 text-muted-foreground" aria-hidden="true" />
        <h1 className="font-serif text-2xl tracking-display">{title}</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
        {action ? <div className="pt-1">{action}</div> : null}
      </section>
    </main>
  );
}
