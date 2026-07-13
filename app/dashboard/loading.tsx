import { DataSkeleton } from "@/components/ui/data-state";

export default function DashboardLoading() {
  return (
    <main className="flex w-full flex-col items-center px-3 pt-32 pb-16 sm:px-6 lg:pt-28">
      <section className="glass w-full max-w-7xl rounded-lg">
        <DataSkeleton label="Loading workspace" rows={6} />
      </section>
    </main>
  );
}
