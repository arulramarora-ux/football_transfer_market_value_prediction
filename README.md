# Touchline — Football Player Market Value Predictor

Touchline is a React/Vite scouting interface with a Node.js API and a 120-day relative-change ridge model.

## Local development

```powershell
cd C:\Users\Arul\Downloads\football_transfer_market_value_predictor
npm install
npm run dev
```

Open the Vite URL in the terminal (normally `http://localhost:5173`). The local API runs at `http://localhost:3001/api`; check `/api/health` for readiness and model version.

Place the Kaggle source files in `data/` for local development. Required files include `players.csv` and `player_valuations.csv`; appearances, performances, transfers, competitions, and season-stat CSVs enrich stats and model features. Raw datasets are gitignored.

Train locally with `npm run train:model`; build the frontend with `npm run build`.

## Deployment target: Vercel + Neon

React is already the frontend. `vercel.json` configures SPA fallback, and `database/schema.sql` is the initial Neon PostgreSQL schema. A Vercel Node.js catch-all API supports health, search, player records, history, stats, and prediction. The import script aggregates CSV data before loading it into Neon. Create a fresh Neon project, copy `.env.example` to `.env`, fill in the Neon connection URL, then run `npm run import:neon` to create/populate the schema and tables.

After importing the data, connect the GitHub repository to Vercel and set the pooled Neon connection string as the private Vercel environment variable `DATABASE_URL`. Never put database credentials in frontend `VITE_` variables or Git. The local API continues to be used by `npm run dev`; the Vercel functions serve the production API. The importer clears the target tables before each full import, so only run it against the intended database.

Sign-in, saved items, and admin workflows are deferred. The player profile hides the recorded-value card/history by request; recorded values still anchor the forecast internally.
