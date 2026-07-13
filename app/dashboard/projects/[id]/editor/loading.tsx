import { DataSkeleton } from "@/components/ui/data-state";

export default function EditorLoading() {
  return (
    <main className="flex h-dvh w-full flex-col px-3 pt-32 pb-4 sm:px-6 lg:pt-24">
      <section className="glass min-h-0 w-full flex-1 overflow-hidden rounded-lg">
        <DataSkeleton label="Loading editor" rows={8} className="h-full" />
      </section>
    </main>
  );
}
