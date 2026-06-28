export const site = {
  name: "Stash",
  version: "v0.1.0",
  tagline: "A collaborative workspace for Markdown and HTML documents.",
  repo: "https://github.com/datarohit/stash",
  issues: "https://github.com/datarohit/stash/issues",
  readme: "https://github.com/datarohit/stash#getting-started",
  license: "https://github.com/datarohit/stash/blob/master/LICENSE",
  author: "Rohit Vilas Ingole",
  authorUrl: "https://github.com/datarohit",
};

export const navLinks = [
  { label: "Features", href: "#features" },
  { label: "Workflow", href: "#workflow" },
  { label: "Architecture", href: "#architecture" },
  { label: "Pricing", href: "#pricing" },
];

export const footerColumns = [
  {
    title: "Documentation",
    links: [
      { label: "Getting started", href: site.readme },
      { label: "README", href: site.repo },
      { label: "Conventions", href: `${site.repo}#conventions` },
    ],
  },
  {
    title: "API",
    links: [
      { label: "Convex backend", href: "https://convex.dev" },
      { label: "Schema", href: `${site.repo}/tree/master/convex` },
      { label: "Quality gate", href: `${site.repo}#the-quality-gate` },
    ],
  },
  {
    title: "Community",
    links: [
      { label: "Issues", href: site.issues },
      { label: "Discussions", href: `${site.repo}/discussions` },
    ],
  },
  {
    title: "GitHub",
    links: [
      { label: "Repository", href: site.repo },
      { label: "Releases", href: `${site.repo}/releases` },
      { label: "License", href: site.license },
    ],
  },
];
