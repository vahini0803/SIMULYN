# SIMULYN

Virtual engineering labs for programming and electronics education. Students write code
against real compilers, measure circuits, and sit timed exams their instructor can watch
in real time.

- **Students** solve problems in Python, JavaScript, C++ or Java against hidden test
  cases, answer tolerance-checked electronics questions, ask a Socratic AI mentor for
  hints, and earn XP, levels, streaks and badges.
- **Teachers** author problems, assign them to classes, schedule exams, and invigilate
  live — violations stream in as they happen with a per-student integrity score.
- **Admins** manage accounts, bulk-import a cohort from CSV, and watch system health.

---

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Monorepo | Turborepo + pnpm workspaces | `apps/api`, `apps/web`, `packages/shared` |
| Backend | NestJS 11 (TypeScript) | REST + Socket.IO, Swagger at `/api/docs` |
| Frontend | Next.js 15 (App Router) | React 19, Tailwind CSS v4 |
| Database | Prisma 6 — SQLite in dev, PostgreSQL in production | one schema, provider derived for prod |
| Auth | JWT access (15 min) + rotating refresh cookie (7 days) | refresh tokens stored hashed |
| Editor | Monaco, self-hosted | no CDN — works with no outbound internet |
| Realtime | Socket.IO namespace `/proctoring` | JWT verified on handshake |
| AI | Ollama, optional Anthropic/OpenAI fallback | responses cached by code hash |

---

## Prerequisites

- **Node 20+** and **pnpm 9+** (`npm i -g pnpm`)
- **Python 3** and **Node** on `PATH` — needed to execute student submissions
- **g++** and **JDK 17** — optional locally, included in the Docker image
- **Ollama** — optional; the AI mentor degrades to a clear message without it
- **Docker + Compose** — for deployment only

---

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm db:push && pnpm db:seed
pnpm dev
```

- Web → <http://localhost:3000>
- API → <http://localhost:3001>
- API docs → <http://localhost:3001/api/docs>

### Demo accounts

| Role | Username | Password |
|---|---|---|
| Admin | `admin` | `admin123` |
| Teacher | `dr.sunitha` | `teacher1` |
| Students | `sunan`, `vivek`, `vahini`, `sanjan` | `student1` … `student4` |

Class **CSE 2026 Batch A**, join code `CSE2026A`, with all 15 seeded problems assigned.

Student accounts are seeded with `mustChangePassword: true`, so the first sign-in asks
for a new password. To skip that in a demo, set it to `false` in
`packages/shared/prisma/seed.ts` and re-seed.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | SQLite path resolves against `packages/shared/prisma/` |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | — | **Change for production.** Signing keys |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | `15m` / `7d` | Token lifetimes |
| `PORT` | `3001` | API port |
| `CORS_ORIGIN` | `http://localhost:3000` | Comma-separated allowed origins |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | Baked into the web build |
| `EXEC_MAX_CONCURRENCY` | `20` | Simultaneous executions before queuing |
| `EXEC_TIMEOUT_MS` | `8000` | Wall clock per test case |
| `PYTHON_BIN` / `CXX_BIN` / `JAVAC_BIN` / `JAVA_BIN` | auto-detected | Override toolchain paths |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `localhost:11434` / `phi3` | Local model |
| `CLOUD_LLM_PROVIDER` / `CLOUD_LLM_API_KEY` / `CLOUD_LLM_MODEL` | unset | `anthropic` or `openai` fallback |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | — | Docker only |

Live values are visible to an admin at **/admin/settings** with secrets masked.

---

## Project structure

```
simulyn/
├── apps/
│   ├── api/                 NestJS backend
│   │   ├── src/modules/     auth · users · classes · problems · execution ·
│   │   │                    submissions · exams · proctoring · gamification ·
│   │   │                    mentor · analytics · discussions · admin
│   │   ├── src/common/      guards, decorators, filters, interceptors, DTOs
│   │   └── test/            smoke suites (run against a live server)
│   └── web/                 Next.js frontend
│       ├── src/app/         landing · login · student/* · teacher/* · admin/*
│       ├── src/components/  ui primitives, problem solver, charts, discussion
│       └── test/            unit tests (node:test)
└── packages/shared/
    ├── prisma/              schema, migrations, seed, generated postgres schema
    └── src/                 constants, types, JSON helpers
```

### How code execution works

`POST /execute/run` runs a file as written. `POST /submissions` wraps the student's
function in a generated driver — one per language — that parses each test case from
stdin, calls the function, and prints the result after an internal marker so debug
`print()` calls never corrupt grading. Test input is **one JSON literal per line** in
parameter order; expected output is a single JSON literal. Supported parameter types:
`int`, `double`, `string`, `bool`, `intArray`, `stringArray`, `listNode`, `treeNode`,
`grid`.

Compiled languages are compiled once per submission and run per test case. A counting
semaphore caps concurrency; every run has a wall-clock timeout, truncated output and a
code-length limit.

> **Isolation:** submissions run as child processes, not in a kernel sandbox. Run the API
> in its container (below), which is what the resource limits in
> `docker-compose.prod.yml` are for.

---

## Commands

```bash
pnpm dev                    # api :3001 and web :3000, both watching
pnpm build                  # build all packages
pnpm lint                   # typecheck everything

pnpm db:push                # sync schema without a migration (dev)
pnpm db:seed                # wipe and repopulate demo data
pnpm db:studio              # browse the database

pnpm --filter web test      # frontend unit tests
pnpm --filter api test:smoke    # 96 API checks — needs a running server
pnpm --filter api test:phase5   # 59 teaching/exam/proctoring checks
```

The API smoke suites mutate data. Re-run `pnpm db:seed` afterwards.

---

## Deployment

The stack is three containers: `web`, `api` and `db` (PostgreSQL). The API image ships
Python, Node, g++ and JDK 17, so all four languages execute in production even if the
host has none of them.

```bash
git clone <repo> simulyn && cd simulyn
cp .env.example .env        # fill in POSTGRES_*, JWT_*, CORS_ORIGIN, NEXT_PUBLIC_API_URL
./scripts/deploy.sh --seed  # --seed only on a fresh install
```

Subsequent deploys:

```bash
./scripts/deploy.sh         # pull, build, migrate, restart
```

`deploy.sh` refuses to run with an incomplete `.env`, applies migrations in a throwaway
container so a failure never leaves a half-started API, and waits for health checks.

### Schema changes

`packages/shared/prisma/schema.prisma` is the single source of truth and stays
SQLite-compatible — no `@db.Text`, no native arrays (JSON is stored as strings). The
PostgreSQL schema is **derived**, never hand-edited:

```bash
pnpm --filter @simulyn/shared db:migration:init     # SQLite migration
pnpm --filter @simulyn/shared db:postgres:migrate   # derive pg schema + migration
```

Both migration sets are committed. Production runs `db:postgres:deploy`.

---

## Contributing

- **Match the surrounding code.** The backend leans on the global `JwtAuthGuard` with
  `@Public()`, `@Roles()` and `@CurrentUser()`; the frontend on the `api` client,
  `useAuth`, and the `ui/` primitives. Reuse them rather than adding parallel ones.
- **The global `ValidationPipe` runs with `whitelist: true`** — a DTO property with no
  class-validator decorator is silently stripped. Free-form values need `@IsDefined()`.
- **Pagination caps `limit` at 100.** Never request more from the client.
- **Design tokens live in `apps/web/src/app/globals.css`.** Use the named colours
  (`ink`, `violet`, `brass`, `paper`, `trace`, `fault`) rather than new hex values, and
  the `.glass`, `.instrument` and `.hairline` utilities.
- **Verify before claiming done:** `pnpm build`, `pnpm lint`, the unit tests, and the
  smoke suites against a running server.
