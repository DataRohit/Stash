import Link from "next/link";
import { footerColumns, site } from "@/lib/site";

export function Footer() {
  return (
    <footer className="border-hairline border-t bg-surface/20 backdrop-blur">
      <div className="mx-auto max-w-7xl px-6 py-12">
        <div className="glass overflow-hidden rounded-lg">
          <div className="flex flex-col gap-3 border-hairline border-b bg-foreground/[0.025] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="flex size-7 items-center justify-center rounded-sm border border-hairline bg-foreground font-bold font-mono text-background text-sm">
                S
              </span>
              <span className="font-semibold text-sm tracking-display">{site.name}</span>
            </Link>
            <div className="flex flex-wrap items-center gap-4 font-mono text-muted-foreground text-xs uppercase tracking-widest">
              <span>{site.version}</span>
              <span className="flex items-center gap-1.5">
                <span className="live-dot size-1.5" aria-hidden="true" />
                Active development
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5">
            <div className="col-span-2 border-hairline border-b p-5 md:col-span-1 md:border-b-0">
              <p className="max-w-xs text-muted-foreground text-sm leading-relaxed">
                {site.tagline}
              </p>
            </div>

            {footerColumns.map((column, index) => (
              <div
                key={column.title}
                className={`flex flex-col gap-3 border-hairline p-5 ${
                  index % 2 === 0 ? "border-r md:border-r-0" : ""
                } ${index > 1 ? "border-t md:border-t-0" : ""} md:border-l`}
              >
                <span className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-widest">
                  {column.title}
                </span>
                <ul className="flex flex-col gap-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-9 items-center rounded-sm text-foreground text-sm transition-colors hover:text-muted-foreground"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-3 border-hairline border-t bg-foreground/[0.018] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <span className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
              MIT Licensed
            </span>
            <p className="font-mono text-muted-foreground text-xs">
              © 2026{" "}
              <a
                href={site.authorUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-foreground"
              >
                {site.author}
              </a>
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
