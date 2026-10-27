# Touchline — Product Requirements and Current Product Specification

**Product status: 26 October 2026**  
**Release stage: Public MVP, deployed to Vercel**

This document describes the product as it exists now, rather than the original aspirational build plan. It records implemented behavior, current architecture, model limitations, and the next work that is still open. The source code and deployed environment remain the implementation authority if a detail here becomes outdated.

## 1. Product summary

Touchline is a public football player discovery and market-value estimation website. Visitors can search and browse dataset players, inspect player profiles and available statistics, see a model estimate, and compare two players.

The app distinguishes three kinds of number:

- **Recorded market valuation:** a value recorded in the source dataset on a particular date.
- **Model estimate:** the model's estimated market value at its forecast date.
- **Transfer fee:** a fee associated with a recorded transfer, if available.

They are different measures and must not be described as interchangeable. The player profile intentionally does not show the recorded valuation card or valuation history chart. Recorded values still anchor the prediction internally and appear where appropriate in discovery and comparison views.

## 2. Product status and scope

### Implemented public MVP

- Public landing page with player search and featured records from the dataset.
- Player directory with name search, suggestions, portraits/fallbacks, filters, sorting, result counts, and pagination/load-more behavior.
- Player profile with available player information, image, aggregate appearance statistics, model estimate, and an explanation of the model's inputs and limitations.
- Two-player comparison selected by player name, with side-by-side player cards and available statistics/model information.
- Actual recorded valuation history is available to comparison where records exist; profiles hide the recorded-value card and history chart by product decision.
- Loading, empty, not-found, missing-data, and API error states, including retry behavior in relevant views.
- Light/dark theme switch and responsive styling, keyboard support for search suggestions, and reduced-motion handling.
- Vercel-hosted React frontend and serverless Node API backed by Neon PostgreSQL.

### Deferred

- Sign-up, sign-in, user accounts, saved players, saved comparisons, and account menus.
- Admin workflows and user/role administration.
- Trophy counts or trophy-based prediction features.
- Man of the Match awards and match-rating inputs.
- Live retraining or automatic dataset refresh.
- Claims that the estimate is a guaranteed transfer fee or a precise professional appraisal.

## 3. Audience and core user tasks

The current MVP is for visitors who want to:

1. Find a player by name or browse/filter the supported dataset.
2. Open a player profile and see the available dataset information and model estimate.
3. Compare two existing players using the same available fields.
4. Understand what data goes into the estimate and what the estimate does not mean.

The app does not support custom or hypothetical player records; a player must exist in the imported dataset.

## 4. Pages and user-facing behavior

### `/` — Home

- Shows the Touchline identity, public navigation, player search, and a UCL-inspired Starlight visual treatment.
- Uses a trophy silhouette in the hero artwork, a subtle dot-field background, and featured player records sourced from the API.
- Offers a route into the player directory and a short explanation of the product.
- Displays a real-data empty/error state if the API cannot provide records; production must not quietly fill the page with invented sample players.

### `/players` — Player directory

- Searches existing players by name and supports the available position, age, league, and club filters.
- Supports sorting by name, age, and recorded market value where available.
- Shows player portrait where the dataset provides an image URL, with a neutral fallback if the image is absent or fails to load.
- Shows the record's available club/position/value details and links to the player's profile.
- Provides result count, clear-filter behavior, and incremental loading/pagination.
- Search suggestions support keyboard navigation and selection.

### `/players/:id` — Player profile

- Shows the player portrait/fallback, name, club, position, and other available profile attributes.
- Shows aggregate appearance-record totals when available: appearances, goals, assists, minutes, yellow cards, and red cards.
- Shows the model-estimated value, source valuation date, forecast date, model horizon, and role-grade information when available.
- Explains the model inputs and limitations in plain language.
- Does not display a recorded valuation card or recorded valuation history chart. The source value is still used internally as the model's starting point.
- A missing prediction must not prevent the rest of the profile from rendering.

### `/compare` — Player comparison

- Lets the visitor select exactly two existing players by name through suggestions rather than requiring them to know numeric IDs.
- Shows both player portraits and summary information in side-by-side cards.
- Displays shared available statistics and estimates side by side, with missing values represented honestly.
- Can show historical recorded valuations where the comparison view has them; these remain labeled as recorded data.
- Does not claim that differing or unavailable fields are equivalent, and does not fabricate values.

### Other paths

Sign-in, sign-up, saved-item, and admin pages are not part of the current public release. Navigation must not imply that unavailable account functions work.

## 5. Design system and interaction

- **Visual direction:** editorial football scouting interface, named “Starlight.”
- **Palette:** midnight navy (`#080D1B`), dark card surfaces (`#111C31`), blue accent (`#3978FF`), cyan highlight (`#76D7FF`), light primary text (`#F4F6FA`), muted text (`#A7B8D5`).
- **Motifs:** restrained dot-field/starlight texture, blue/cyan highlights, and a trophy silhouette on the home hero.
- **Cards:** dark outlined analytics surfaces with restrained hover/focus changes; player cards include portraits where data permits.
- **Typography:** editorial display headings paired with readable sans-serif interface text and legible numeric values.
- **Motion/accessibility:** animations respect reduced-motion settings. Keyboard focus is visible, interactive search can be navigated from the keyboard, and status should not rely only on color.
- **Responsive behavior:** layouts adapt to smaller screens; dense comparison content may need horizontal scrolling rather than compressed unreadable columns.

The implementation uses React components and project CSS. It does not currently depend on a separate component framework for all UI elements.

## 6. Data and provenance

The project uses the Kaggle Transfermarkt player-scores dataset and supplementary season performance CSVs. Raw CSVs are kept in the local `data/` directory and ignored by Git; summarized/usable data is imported into Neon for the deployed API.

Imported data includes:

- Player records and image URLs.
- Dated market valuations.
- Appearance rows aggregated into player-month totals.
- Player performance rows aggregated by season.
- Competition labels.
- Role grades derived from available season-stat files.
- Transfer-fee-to-market-value comparison aggregates, where the transfer and value are both positive and usable.

The latest valuation date in the active model artifact is **12 June 2026**. The available 2025/26 and 2024/25 season-stat files are used for role grades when they can be matched. Trophy winners have not been linked to player/team/season records in the current product. The 2026/27 season-stat file, if partial, is not automatically treated as a complete season grade.

Images are taken from the dataset's player image URL field when available. The app falls back to a neutral silhouette/initial treatment when no usable image is supplied. The app does not scrape other image sources.

### Database tables

- `players`: searchable player fields plus the source player record.
- `valuations`: dated recorded valuation observations.
- `appearance_months`: monthly appearance/stat aggregates.
- `season_performance`: season-level totals.
- `role_grades`: computed player/season/role scores and coverage.
- `competitions`: competition names and league codes.
- `transfer_monthly`: grouped transfer comparison counts and ratios.
- `player_transfer_monthly`: corresponding groups that include a player's own transfer history.

## 7. Prediction behavior and limitations

### Current prediction definition

The active model is a **120-day relative-change ridge regression model**, version `ridge-relative-120d-v10-bounded-change`. It forecasts 120 days after the player's latest dated positive recorded valuation. The forecast date is player-specific. With a latest dataset valuation of 12 June 2026, a player whose latest record is that date has a 10 October 2026 forecast date.

The model uses the latest recorded value as the starting anchor, predicts a change from it, applies historical change bounds for the starting-value band, and returns a bounded estimate. It can estimate an increase, decrease, or little/no change. A forecast is not a transfer-fee prediction and is not guaranteed to equal a future observed valuation.

### Input groups currently represented

- Starting recorded valuation, age, position, and valuation trend.
- Recent prior-12-full-month appearance, goal, assist, and minute totals.
- Career appearance totals available in the appearance dataset.
- Latest completed-season totals from the player-performance dataset.
- Position-specific seasonal grades and coverage from the supplementary statistics files.
- Position/stat interactions so the regression can learn different relationships by goalkeeper, defender, midfielder, and attacker group.
- Comparable historical transfer fee-to-recorded-value ratios and counts, where qualifying comparisons exist.

The role grade uses available attacking, passing, defensive, or goalkeeper metrics with role-dependent weights, position-season percentiles, minutes, and coverage. It is a derived summary feature, not a manually verified scouting grade.

### Not currently included

- Trophy wins, team-season trophy attribution, or joint final winners.
- Man of the Match awards or match ratings.
- Injury, contract, agent, tactical, and reliable live availability information.
- A production guarantee that all relevant stats are complete for every player.

### Evaluation status

The active artifact contains a chronological holdout evaluation with 143 unique players. Its reported mean absolute percentage error is approximately **20.6%**, median absolute percentage error approximately **11.6%**. On the same holdout, carrying the starting value forward unchanged had a reported mean percentage error of approximately **18.3%**. Therefore, in that evaluation, the model did **not** outperform the simple carry-forward baseline.

The holdout's average target interval is about 92 days, although production forecasts are 120 days, because the trainer accepts target valuations within ±30 days of the intended horizon and the available endpoint of the data constrains the holdout. All 143 holdout targets were below €10 million; the holdout contains no €10m+ targets. These metrics do not establish model quality for elite players or exact 120-day forecasts. Present the estimate as experimental guidance, not a validated appraisal.

The model artifact also includes mean absolute error, symmetric percentage error, log error, value-band summaries, and baseline comparisons. Do not label one metric as “accuracy” without naming the metric and describing its evaluation set.

## 8. Technical architecture and runtime

- **Frontend:** React, built with Vite.
- **Styling and visual components:** project CSS and reusable React components.
- **Production API:** Node.js serverless functions on Vercel.
- **Database:** Neon PostgreSQL, accessed with `@neondatabase/serverless`.
- **Model inference:** JavaScript functions in the API using a versioned JSON model artifact.
- **Offline training:** Node.js script; it reads local CSVs and writes a model artifact.
- **Local development API:** a separate Node HTTP server that reads local CSVs from `data/`.
- **Deployment:** Vercel serves the frontend and API; GitHub is the source repository.

The Vercel API uses the private `DATABASE_URL` server environment variable. Database credentials must not be placed in frontend `VITE_` variables, committed to Git, or included in public artifacts. The Vercel functions include the active model JSON artifact. The raw CSV folder is not shipped with the frontend.

### Main API contracts currently implemented

- `GET /api/health` — API/database/model readiness summary.
- `GET /api/filter-options` — available positions and league options.
- `GET /api/players` — searchable/filterable/sortable paginated player records.
- `GET /api/players/:id` — player record.
- `GET /api/players/:id/stats` — aggregate appearance statistics.
- `GET /api/players/:id/value-history` — recorded valuation history.
- `GET /api/players/:id/prediction` — model estimate and supported grade summary.

Requests are read-only GET routes in the current public API. Unsupported paths return a not-found response. Production errors should not expose database credentials or stack traces to visitors; detailed errors belong in deployment logs.

## 9. Current repository responsibilities

- `src/main.jsx`: page rendering, simple path-based navigation, frontend API requests, search, directory, profiles, and comparisons.
- `src/design.jsx`: reusable dot-field, dynamic text, theme switch, animated dial, and metric-card components.
- `src/style.css`: design tokens, layouts, responsive rules, themes, focus/hover states, charts, and reduced-motion styling.
- `index.html`: Vite HTML entry point and React mount shell.
- `server/index.mjs`: local CSV-backed API and static-file serving for local use.
- `server/model.mjs`: feature construction, position grouping, transfer comparison features, and inference.
- `server/role-grades.mjs`: matching season-stat rows to players and calculating position-specific grades.
- `api/_handler.mjs`: shared Vercel API logic and Neon queries.
- `api/health.mjs`, `api/filter-options.mjs`, `api/players.mjs`, `api/players/[id].mjs`, `api/players/[id]/[action].mjs`: Vercel route entry points.
- `scripts/dev.mjs`: starts local API and Vite together.
- `scripts/import-neon.mjs`: creates schema and imports/aggregates local CSV data into Neon. It truncates the target project tables before a full import; run it only against the intended database.
- `scripts/train-model.mjs`: creates training snapshots, fits the ridge model, evaluates temporal holdout and baselines, and writes the model JSON.
- `database/schema.sql`: Neon table and index definitions.
- `database/README.md`: database setup notes.
- `artifacts/market-value-model.json`: active model loaded by the API.
- `artifacts/market-value-model-*-candidate.json`: experimental candidates, not loaded by production unless explicitly substituted.
- `vercel.json`: SPA routing and model-artifact inclusion for serverless functions.
- `package.json`: dependencies and project commands; `package-lock.json` locks resolved dependency versions.
- `README.md`: development and deployment setup notes.
- `prd.md`: this current product specification.
- `# Football Player Market Value Predictor.md`: earlier product/interface specification; this is not the current status source.
- `.gitignore`: excludes dependencies, build output, secrets, and local datasets.

## 10. Operations and maintenance

- `npm run dev` starts the local frontend and CSV-backed local API. Local data files must be present for the local API to populate data.
- `npm run build` builds the frontend; it does not import data or train the model.
- `npm run import:neon` imports CSV data and rebuilds the database tables. It is destructive to the target project's existing imported rows because it truncates tables first.
- `npm run train:model` trains from local CSVs and replaces the active artifact by default. Review evaluation and artifact metadata before committing/redeploying a newly trained model.
- Pushing the intended commit to the connected GitHub branch triggers a Vercel deployment if automatic deployments are enabled.
- Keep `.env` and Vercel `DATABASE_URL` private. `.env.example` is a template and should not contain real secrets.
- After deploying API changes, verify the deployed frontend, `/api/health`, player search, a player profile, and a prediction request. A successful frontend build alone does not prove Neon connectivity or model inference is healthy.

## 11. Known issues and next priorities

1. **Improve model validation first.** Add a larger, genuinely forward-in-time holdout with enough players above €10m and €50m, and compare candidate models against carry-forward and other simple baselines. Avoid overstating the current reported performance.
2. **Validate the horizon.** Evaluate near-exact 120-day targets separately from observations accepted by the ±30-day training tolerance.
3. **Investigate large-value behavior.** Check predictions by value band, age, position, and data coverage, and guard against implausible changes without flattening all player predictions to the baseline.
4. **Data quality and coverage.** Document date coverage and missingness by source; confirm the supported season and player joins before adding another source.
5. **Trophies are a future feature.** Only add trophies after reliably identifying competition winners by season and linking their team-season to player appearances. Joint winners may be represented when a final is level after penalties if the chosen product rule is retained, but this is not part of the current model.
6. **Live status check.** Confirm the deployed health endpoint, prediction route, and active model version after the latest code deployment.
7. **Accessibility/responsive polish.** Continue checking the real pages at small screen widths and with keyboard/reduced-motion settings.
8. **Authentication, saved items, and admin tools** remain deferred until public browsing and data/model behavior are stable.

## 12. Acceptance criteria for the current public MVP

The current release is considered operational when:

- Home, player directory, player profile, and two-player comparison load against the deployed API.
- Search suggestions resolve a selected player to that player's profile.
- Supported filters, ordering, and result counts use real dataset fields.
- The profile shows available overall stats and clearly labels the model estimate and its forecast date.
- Profiles do not show the recorded valuation card/history chart, while the model can still use recorded valuations internally.
- Comparison presents two selected players side by side and does not invent missing values.
- API and data failures are shown as errors/empty states, not disguised with fake records.
- The health endpoint reports whether the dataset and model are available; the prediction route returns a valid response or a clear unavailable state.
- Dataset files and credentials remain out of Git and browser-visible frontend configuration.
- The model's current limitations and evaluation status are disclosed as described in this document.

## 13. Product decisions recorded

- Public browsing and deployment take priority over sign-in.
- The selected hosting stack is React/Vite on Vercel with a Node API and Neon PostgreSQL.
- The active forecast horizon is 120 days from each player's latest recorded valuation date.
- Player profiles show overall available statistics and the model estimate, but hide recorded valuation history/card.
- The home visual direction is UCL-inspired Starlight with a trophy silhouette.
- Player names, rather than IDs, are the intended user-facing inputs for search and comparison.
- The model is experimental and must be judged against simple baselines before being described as accurate.
