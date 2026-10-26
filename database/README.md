# Vercel deployment scaffold

React remains the frontend framework. Vercel serves the Vite-built site and will host Node.js API functions under `/api`. Neon PostgreSQL is the planned data store because Vercel functions cannot keep a local CSV directory between invocations.

`database/schema.sql` defines normalized player, valuation, appearance, season-performance, and role-grade tables. Raw CSVs must be imported into these tables; do not upload the source files to the frontend or commit them to Git.

## Current migration status

- Vite/React frontend: already implemented.
- Vercel SPA routing config: added in `vercel.json`.
- Neon schema: drafted in `database/schema.sql`.
- Existing Node API still reads local CSVs; it must be ported to Vercel function handlers backed by Neon before the hosted app can return dataset-backed results.
- Create a fresh Neon project. Copy `.env.example` to `.env` and put its pooled connection URL in that file as `DATABASE_URL=...`, then run `npm run import:neon`. The import clears/reloads project tables; use a fresh database and do not run it against a database with data you want to keep. Add the same value as a private `DATABASE_URL` environment variable in Vercel. Never use a `VITE_` prefix for database credentials.
