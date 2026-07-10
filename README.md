# Stash

[![Quality](https://github.com/datarohit/stash/actions/workflows/quality.yml/badge.svg)](https://github.com/datarohit/stash/actions/workflows/quality.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Biome](https://img.shields.io/badge/Biome-2-60A5FA?logo=biome&logoColor=white)](https://biomejs.dev)

**A collaborative workspace for Markdown, HTML, and rich-text documents.**

Stash organizes documentation, planning notes, and web content into projects with nested folders. Work in Markdown, HTML, or rich text; collaborate on the same file in real time; review version history; and share read-only links when the document is ready.

## Features

- **Document workspace** — create Markdown (`.md`), HTML (`.html`), and rich-text documents in nested project folders; upload image and SVG assets alongside them.
- **Live collaboration** — Yjs-backed collaborative editing keeps Markdown, HTML, and rich-text files synchronized, with remote cursors, presence, incremental updates, and clear sync or quota states.
- **Safe previews** — preview Markdown, Mermaid diagrams, and HTML in a sandboxed iframe. Mermaid SVG is rendered locally, and linked assets or documents resolve from the project tree.
- **Search and discussion** — search project files, leave anchored comment threads in every document format, reply, resolve or reopen, and notify mentioned collaborators.
- **Version history** — create checkpoints, compare revisions with inline diffs, preview an older version, and restore Markdown, HTML, or rich-text revisions as an administrator.
- **Export and sharing** — export a Markdown file, standalone HTML, print/PDF, or a whole-project ZIP. Admins can create private, organization-only, or public read-only links for every document format.
- **Organizations and access** — Clerk organizations, invitations, project-level grants, plan limits, and server-side authorization keep workspaces isolated.

## Project status

Stash is in active development, but the collaborative document workspace is implemented: authentication, organization onboarding, membership management, project access, the real-time editor, rich-text files, comments, version history, sharing, search, exports, and plan-limit enforcement are all present. Expect product and integration details to keep evolving.

## Tech stack

| Area | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router) + React 19 |
| Language | TypeScript 5 (strict) |
| Backend | [Convex](https://convex.dev) (reactive database) |
| Auth & billing | [Clerk](https://clerk.com) (sessions, organizations, roles, plans) |
| Collaboration | [Yjs](https://yjs.dev) + CodeMirror 6 + Tiptap |
| Styling | Tailwind CSS v4 + [next-themes](https://github.com/pacocoursey/next-themes) |
| UI extras | [Sonner](https://sonner.emilkowal.ski) toasts, [DiceBear](https://dicebear.com) generated org icons |
| Package manager | pnpm |

## Quality toolchain

| Concern | Tool |
| --- | --- |
| Formatting + import/class sorting | [Biome](https://biomejs.dev) |
| Linting (Next.js framework rules) | [ESLint](https://eslint.org) + `eslint-config-next` |
| Type checking | TypeScript (`tsc --noEmit`) |
| Unused files / exports / deps | [Knip](https://knip.dev) |
| Spell checking | [CSpell](https://cspell.org) |
| Secret scanning | [secretlint](https://github.com/secretlint/secretlint) |
| Markdown linting | [markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2) |
| No-comments policy | Custom script (`tools/check-no-comments.mjs`) |
| `package.json` order | [sort-package-json](https://github.com/keithamus/sort-package-json) |
| Git hooks | [Husky](https://typicode.github.io/husky) + [lint-staged](https://github.com/lint-staged/lint-staged) |
| Commit messages | [commitlint](https://commitlint.js.org) (Conventional Commits) |

### Lint and format split

Biome is the formatter and the import/Tailwind-class organizer. ESLint runs only `eslint-config-next` to keep the Next.js framework rules Biome does not provide (for example `no-html-link-for-pages` and the React Hooks rules). There is no Prettier — Biome replaces it.

## Prerequisites

- [Node.js](https://nodejs.org) `>=20` (the repo pins `22` via `.nvmrc`)
- [pnpm](https://pnpm.io) `11` (run `corepack enable` to use the version pinned in `package.json`)

## Getting started

```bash
pnpm install
pnpm dev:local
```

`pnpm dev:local` provisions a local Convex backend if needed, writes the Convex-managed values to `.env.local`, then runs the Convex dev server and the Next.js dev server together. Open [http://localhost:3000](http://localhost:3000) to view the app. To initialize only the local database without starting the web server, use `pnpm db:setup`. To run only the web server, use `pnpm dev:web`.

## Sample documents

Two matching product-tour files are provided for exercising previews, Mermaid rendering, custom HTML styles and scripts, cross-file links, sharing, and exports:

- [Markdown demo](./examples/demo.md)
- [HTML demo](./examples/demo.html)

Upload either file to a project or paste its contents into a new file in the editor.

## Backend (Convex)

The backend is [Convex](https://convex.dev), a reactive database with type-safe functions.

- **Local development** runs an open-source Convex backend on your machine — no account needed. `pnpm db:setup` runs the Convex local initialization once and writes `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL`, and `NEXT_PUBLIC_CONVEX_SITE_URL` to `.env.local`. `pnpm dev:local` starts local Convex and Next.js together; `pnpm dev:db` starts only Convex.
- **Schema** lives in `convex/schema.ts`. It models organizations, members, projects and access grants, the document tree, Yjs updates and snapshots, presence, comments and notifications, and document shares. Backend functions live in `convex/`; generated types in `convex/_generated/` are committed.
- **Data lifecycle** — project and document removal is marked first, then drained in bounded batches. Scheduled jobs compact collaboration state, prune version history, clear stale presence, and clean up obsolete notifications and share events.
- **Clerk is wired to Convex** via `convex/auth.config.ts` (using `CLERK_JWT_ISSUER_DOMAIN`), so Convex functions can read the signed-in identity from the Clerk session token.
- **Generated code** in `convex/_generated/` is produced by the Convex CLI and committed so the project type-checks in CI. It is excluded from formatting, linting, spell-checking, and the no-comments policy.
- **Dashboard** for the local backend runs at `http://127.0.0.1:6790`. `pnpm dev:local` prints its URL once the backend is up; or open it any time with `pnpm db:dashboard`.
- **Deploying to the cloud** later is a matter of running `npx convex login` and `npx convex deploy`; no app code changes.

The React client is wired in `components/providers/ConvexClientProvider.tsx` and mounted in `app/layout.tsx`. It falls back to a placeholder URL when `NEXT_PUBLIC_CONVEX_URL` is unset, so builds without a backend (such as CI) never fail.

## Authentication, organizations & billing

Authentication and billing run on [Clerk](https://clerk.com); set the Clerk keys from `.env.example` before signing in.

- **Auth** — `proxy.ts` protects `/dashboard` and `/onboarding`. A signed-in user without an active organization is redirected into onboarding.
- **Organizations are mandatory** — every user must create or select an organization before reaching the dashboard. Orgs are created through a server action (not Clerk's client widgets) so the plan cap is always enforced.
- **Plan-based limits** — the active plan and its limits are read straight from the Clerk billing API (`lib/subscription.ts`, `lib/plan-limits.ts`) rather than the session token, so a fresh upgrade takes effect immediately. Free allows one organization; Pro allows more.
- **Per-org customization** — an organization's name and icon are stored in Clerk while its description and tags live in Convex (`convex/organizations.ts`). The icon reuses Clerk's org logo: a [DiceBear](https://dicebear.com) image is uploaded as the default on creation, admins can replace it with their own upload, and Clerk hosts and serves it so the app and Clerk's own widgets show the same icon. Admins can also delete the organization (a two-step confirmation that switches to another org and blocks deleting the last one).
- **Real-time members & invitations** — admins invite existing users by email (with a role), cancel pending invites, and remove members, capped per plan by a `N_organization_members` billing feature (`lib/plan-limits.ts`). Clerk remains authoritative; Convex holds a denormalized read model for live dashboard updates. In a hosted deployment, configure Clerk webhooks for `/api/webhooks/clerk` and set `CLERK_WEBHOOK_SIGNING_SECRET` plus a strong `CONVEX_PURGE_SECRET`. Local development falls back to a throttled dashboard reconciliation.
- **Plan status** — the dashboard navbar shows a badge for the current plan (Free or Pro) with the renewal or cancellation date, read from the Clerk billing API (`lib/subscription.ts`).
- **Projects** — under `/dashboard/projects`, admins create projects (icon, title, description, and tags) capped by the `N_projects_per_organization` billing feature. Admins manage metadata, access grants, sharing, and file-tree changes; people granted project access can open the workspace. Convex enforces `org_id`, `org_role`, and user identity checks at its public API boundary, and deletion revokes related access and data.
- **Project document editor** — each project opens `/dashboard/projects/[id]/editor`. It includes a nested file tree; Markdown, HTML, and rich-text documents; local Mermaid rendering in a sandboxed preview; live Yjs collaboration and presence; file search; threaded comments; version history with diff and restore; document sharing; and individual or ZIP exports. Files are limited to 512 KB, while project capacity is limited by the active plan (Free defaults to 8 MB and Pro defaults to 64 MB).

To fully activate members/invitations, two one-time steps are needed in the Clerk dashboard (the code ships with safe fallbacks until then): add a `N_organization_members` feature to the Free and Pro plans (e.g. `3_organization_members` / `25_organization_members`), and add `org_id`/`org_role` claims (`{"org_id": "{{org.id}}", "org_role": "{{org.role}}"}`) to the `convex` JWT template so Convex can scope reads to the caller's organization.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm db:setup` | Initialize local Convex once and write Convex-managed env vars to `.env.local` |
| `pnpm db:dashboard` | Open the local Convex dashboard |
| `pnpm dev:web` | Start the Next.js dev server |
| `pnpm dev:db` | Start the Convex dev server (local backend) |
| `pnpm dev:local` | Run local Convex + web together; prints the backend, web, and dashboard URLs |
| `pnpm build` | Create a production build |
| `pnpm start` | Serve the production build |
| `pnpm check` | Run the full quality gate (all checks below + build) |
| `pnpm fix` | Auto-fix formatting, lint, and `package.json` order |
| `pnpm format` | Format and organize imports/classes (Biome, writes) |
| `pnpm format:check` | Verify formatting and organization (Biome, read-only) |
| `pnpm lint` | Lint with ESLint (`--max-warnings 0`) |
| `pnpm lint:fix` | Lint and auto-fix with ESLint |
| `pnpm typecheck` | Type-check with TypeScript |
| `pnpm knip` | Report unused files, exports, and dependencies |
| `pnpm spellcheck` | Spell-check source and docs |
| `pnpm secrets` | Scan the repo for committed secrets |
| `pnpm markdownlint` | Lint Markdown files |
| `pnpm comments:check` | Fail if any comment exists in `.ts`, `.tsx`, or `.css` |
| `pnpm package:check` | Verify `package.json` key order |
| `pnpm package:fix` | Sort `package.json` keys |
| `pnpm prepare` | Install Husky git hooks |

## The quality gate

`pnpm check` runs, in order and fail-fast:

```text
package:check → format:check → lint → typecheck → knip
→ spellcheck → secrets → markdownlint → comments:check → build
```

The same command runs in CI on every push and pull request, so green locally means green on the server. Run `pnpm fix` first to auto-resolve most failures.

## Conventions

- **No comments.** Authored `.ts`, `.tsx`, and `.css` files must contain zero comments or doc-strings. Write code that explains itself; the gate enforces this.
- **Conventional Commits.** Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org) (for example `feat: add search`). `commitlint` validates each message.
- **No arbitrary Tailwind values.** Register design tokens in `@theme` and push complex styles into `@layer components` rather than using bracketed arbitrary values.
- **Pre-commit checks.** Husky runs `lint-staged` (format + lint of staged files) and validates the commit message automatically.

## Project structure

```text
app/                 App Router routes (landing, auth, onboarding, dashboard), layout, and global styles
components/          UI primitives, providers, and landing-page sections
lib/                 Server/client helpers (Clerk billing, plan limits, Convex access, org avatars)
convex/              Convex backend: schema and functions (_generated is committed)
docs/                Product roadmap and design documents
examples/            Matching Markdown and HTML files for manual workspace testing
tools/               Repo automation (no-comments checker, dashboard URL printer)
.github/             CI workflow, Dependabot, issue/PR templates, CODEOWNERS
.husky/              Git hooks (pre-commit, commit-msg)
convex.json          Convex project configuration
package.json         Project metadata, dependencies, and scripts
pnpm-workspace.yaml  pnpm workspace and approved build-script policy
biome.json           Formatter + linter (Biome)
eslint.config.mjs    ESLint flat config (Next.js rules)
knip.json            Unused-code configuration
cspell.json          Spell-check dictionary and ignores
```

## Continuous integration

- **Quality workflow** (`.github/workflows/quality.yml`) installs with a frozen lockfile and runs `pnpm check` on every push and pull request.
- **Dependabot** (`.github/dependabot.yml`) opens monthly grouped updates for npm and GitHub Actions, with a 7-day cooldown to avoid pnpm's `minimumReleaseAge` install failures on fresh releases. Major version bumps are ignored to keep CI green; do those manually.

## License

[MIT](./LICENSE) © [Rohit Vilas Ingole](https://github.com/datarohit)

## Links

- Repository: [github.com/datarohit/stash](https://github.com/datarohit/stash)
- Issues: [github.com/datarohit/stash/issues](https://github.com/datarohit/stash/issues)
