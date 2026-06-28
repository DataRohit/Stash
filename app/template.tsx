export default function Template({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="route-scene flex min-h-full flex-1 flex-col">{children}</div>;
}
