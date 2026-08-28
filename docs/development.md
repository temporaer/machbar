# Development

## Requirements

- Node.js 22 or later
- npm 10 or later

## Setup

```bash
git clone https://github.com/temporaer/machbar.git
cd machbar
npm install
cp .env.example .env
npm run dev
```

The root development command starts the Fastify API and Vite frontend
together. Vite proxies `/api` to the API process.

## Workspace commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start API and web development servers |
| `npm run build` | Build shared, web, and API workspaces |
| `npm run typecheck` | Type-check all workspaces that define the script |
| `npm run test` | Run workspace unit tests |
| `npm run test:e2e` | Run the Playwright configuration |
| `npm run db:migrate` | Apply pending Drizzle migrations |
| `npm run db:seed` | Insert sample household data |

See [Architecture](architecture.md) for package boundaries and domain design.

## Packages

```text
apps/api       Fastify server, domain logic, Drizzle, and SQLite
apps/web       React/Vite PWA
packages/shared  Shared TypeScript contracts and vocabulary
```

In production the API serves the built web assets, so one process and port
handle both surfaces.

## Database location

Outside the container, the defaults come from `.env.example`:

```dotenv
DATA_DIR=./data
DATABASE_FILE=machbar.db
```

Be careful with relative `DATA_DIR` values when invoking workspace scripts:
the API migration script executes with `apps/api` as its working directory.
Use an absolute path when rehearsing a migration against a copied database.

## Migrations

The schema source is `apps/api/src/db/schema.ts`. Generate a new forward
migration from `apps/api`:

```bash
cd apps/api
npx drizzle-kit generate --name describe_the_change
```

Commit the generated SQL, snapshot, and journal update. Do not rewrite an
existing migration that may already have run on another installation.

Before changing production data, rehearse on a backup:

```bash
sqlite3 data/machbar.db ".backup /absolute/path/to/copy/machbar.db"
DATA_DIR=/absolute/path/to/copy npm run db:migrate
```

SQLite table rebuilds need particular care around foreign keys. Review
`apps/api/src/db/migrate.ts` and the migration acceptance tests before
introducing a rebuild migration.

## Seed data

```bash
npm run db:seed
```

The seed is for development, demonstrations, and screenshots. It should not be
run casually against an established household database.

## Documentation screenshots

Use only seed/demo data for public screenshots. Keep a consistent mobile
viewport, avoid personal URLs or profile images, and store final images in
`docs/images/` with descriptive filenames and alt text where embedded.

