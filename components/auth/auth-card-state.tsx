export function AuthCardLoading() {
  return (
    <section
      aria-label="Loading authentication"
      aria-busy="true"
      className="glass h-[26rem] w-full max-w-[25rem] animate-pulse rounded-xl p-8"
    >
      <div className="mx-auto h-7 w-36 rounded bg-foreground/10" />
      <div className="mx-auto mt-3 h-4 w-56 rounded bg-foreground/5" />
      <div className="mt-8 h-10 rounded bg-foreground/5" />
      <div className="mt-4 h-10 rounded bg-foreground/5" />
      <div className="mt-6 h-10 rounded bg-foreground/10" />
    </section>
  );
}

export function AuthCardFailed() {
  return (
    <section role="alert" className="glass max-w-[25rem] rounded-xl p-8 text-center">
      <h1 className="font-serif text-2xl tracking-display">Authentication unavailable</h1>
      <p className="mt-3 text-muted-foreground text-sm leading-relaxed">
        The sign-in service could not load. Check your connection and refresh the page.
      </p>
    </section>
  );
}
