const items = [
  "Fast",
  "Secure",
  "Open API",
  "Self-Hosted",
  "Typesafe",
  "Real-Time",
  "Version History",
  "Collaborative",
];

export function Marquee() {
  return (
    <section
      className="overflow-hidden border-hairline border-b bg-surface/35 py-3 backdrop-blur"
      aria-hidden="true"
    >
      <div className="marquee-track flex w-max">
        {[0, 1].map((track) => (
          <ul key={track} className="flex shrink-0 items-center">
            {items.map((item) => (
              <li
                key={item}
                className="flex items-center font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest"
              >
                <span className="px-6">{item}</span>
                <span className="text-signal">/</span>
              </li>
            ))}
          </ul>
        ))}
      </div>
    </section>
  );
}
