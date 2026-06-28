# Stash

[![Quality](https://github.com/datarohit/stash/actions/workflows/quality.yml/badge.svg)](https://github.com/datarohit/stash/actions/workflows/quality.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Biome](https://img.shields.io/badge/Biome-2-60A5FA?logo=biome&logoColor=white)](https://biomejs.dev)

**A collaborative workspace for Markdown and HTML documents.**

Stash lets you host your documents — documentation, planning docs, notes, or anything written in Markdown or HTML — and organize them into projects with nested folders. Invite collaborators, share read-only links, keep a full version history, and edit the same file together in real time.

## Features

- **Markdown & HTML documents** — host documentation, plans, notes, or any Markdown/HTML content.
- **Projects, folders & nesting** — group documents into projects, with nested folders and files inside each.
- **Organizations** — Pro users can create an organization that holds multiple projects for a team.
- **File limits** — per-plan quotas on the number and size of files.
- **Shareable links** — publish read-only links to a document or a whole project.
- **Version history** — track every change to a document and roll back when needed.
- **Invites & collaboration** — invite collaborators and manage their access per project.
- **Real-time collaborative editing** — multiple people work on the same file simultaneously, live.

## Project status

Early development. The product features above are the roadmap; this repository currently ships the production-grade foundation (toolchain, quality gate, and CI) that the app is being built on. Expect rapid change.

## Tech stack

| Area | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router) + React 19 |
| Language | TypeScript 5 (strict) |
| Backend | [Convex](https://convex.dev) (reactive database) |
| Styling | Tailwind CSS v4 + [next-themes](https://github.com/pacocoursey/next-themes) |
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

## Backend (Convex)

The backend is [Convex](https://convex.dev), a reactive database with type-safe functions.

- **Local development** runs an open-source Convex backend on your machine — no account needed. `pnpm db:setup` runs the Convex local initialization once and writes `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL`, and `NEXT_PUBLIC_CONVEX_SITE_URL` to `.env.local`. `pnpm dev:local` starts local Convex and Next.js together; `pnpm dev:db` starts only Convex.
- **Schema** lives in `convex/schema.ts` (it starts empty — add your tables there). Backend functions go in `convex/`.
- **Generated code** in `convex/_generated/` is produced by the Convex CLI and committed so the project type-checks in CI. It is excluded from formatting, linting, spell-checking, and the no-comments policy.
- **Dashboard** for the local backend runs at `http://127.0.0.1:6790`. `pnpm dev:local` prints its URL once the backend is up; or open it any time with `pnpm db:dashboard`.
- **Deploying to the cloud** later is a matter of running `npx convex login` and `npx convex deploy`; no app code changes.

The React client is wired in `components/providers/ConvexClientProvider.tsx` and mounted in `app/layout.tsx`. It falls back to a placeholder URL when `NEXT_PUBLIC_CONVEX_URL` is unset, so builds without a backend (such as CI) never fail.

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
app/                 App Router routes, layout, and global styles
convex/              Convex backend: schema and functions (_generated is committed)
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
- **Dependabot** (`.github/dependabot.yml`) opens weekly grouped updates for npm and GitHub Actions, with a 7-day cooldown to avoid pnpm's `minimumReleaseAge` install failures on fresh releases.

## License

[MIT](./LICENSE) © [Rohit Vilas Ingole](https://github.com/datarohit)

## Links

- Repository: [github.com/datarohit/stash](https://github.com/datarohit/stash)
- Issues: [github.com/datarohit/stash/issues](https://github.com/datarohit/stash/issues)
