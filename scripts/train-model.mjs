import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { FEATURE_NAMES, HORIZON_DAYS, ageAt, featuresFor, predictLogValue, transferGroupKeys } from "../server/model.mjs";
import { loadRoleGrades } from "../server/role-grades.mjs";

const dataDir = resolve("data");
const forecastHorizonDays = Number(process.env.MODEL_HORIZON_DAYS || HORIZON_DAYS);
const targetToleranceDays = Number(process.env.MODEL_TARGET_TOLERANCE_DAYS || 30);
const outputPath = resolve(process.env.MODEL_OUTPUT_PATH || "artifacts/market-value-model.json");
const DAY = 86_400_000;
function parseLine(line) {
  const out = []; let value = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') quoted = false;
      else value += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(value); value = ""; }
    else value += c;
  }
  out.push(value); return out;
}
async function* csvRows(filename) {
  const input = createInterface({ input: createReadStream(resolve(dataDir, filename), { encoding: "utf8" }), crlfDelay: Infinity });
  let headers;
  for await (const line of input) {
    if (!headers) { headers = parseLine(line.replace(/^\uFEFF/, "")); continue; }
    if (!line) continue;
    const cells = parseLine(line), row = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = cells[i] ?? "";
    yield row;
  }
}
function solve(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error("Training matrix is singular");
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const scale = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= scale;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      for (let j = col; j <= n; j++) a[r][j] -= factor * a[col][j];
    }
  }
  return a.map(row => row[n]);
}
function fit(examples) {
  const dimensions = FEATURE_NAMES.length;
  const means = Array(dimensions).fill(0), scales = Array(dimensions).fill(0);
  for (const row of examples) for (let j = 0; j < dimensions; j++) means[j] += row.x[j] / examples.length;
  for (const row of examples) for (let j = 0; j < dimensions; j++) scales[j] += (row.x[j] - means[j]) ** 2 / examples.length;
  for (let j = 0; j < dimensions; j++) scales[j] = Math.sqrt(scales[j]) || 1;
  const size = dimensions + 1, matrix = Array.from({ length: size }, () => Array(size).fill(0)), vector = Array(size).fill(0);
  for (const row of examples) {
    const x = [1, ...row.x.map((v, j) => (v - means[j]) / scales[j])];
    for (let i = 0; i < size; i++) {
      vector[i] += x[i] * row.y;
      for (let j = 0; j < size; j++) matrix[i][j] += x[i] * x[j];
    }
  }
  const ridge = 4;
  for (let i = 1; i < size; i++) matrix[i][i] += ridge;
  const weights = solve(matrix, vector);
  return { means, scales, intercept: weights[0], coefficients: weights.slice(1), ridge };
}
const players = new Map();
for await (const player of csvRows("players.csv")) players.set(String(player.player_id), player);
console.log(`Loaded ${players.size.toLocaleString()} player records.`);
const playerRoleGrades = loadRoleGrades(dataDir, players);
const histories = new Map();
let valuationRows = 0;
let latestValuationDate = "";
for await (const record of csvRows("player_valuations.csv")) {
  const key = String(record.player_id);
  if (!histories.has(key)) histories.set(key, []);
  histories.get(key).push(record);
  valuationRows++;
  if (record.date > latestValuationDate) latestValuationDate = record.date;
}
console.log(`Loaded ${valuationRows.toLocaleString()} valuation observations.`);
const appearanceMonths = new Map();
let appearanceRows = 0;
for await (const row of csvRows("appearances.csv")) {
  const date = new Date(row.date + "T00:00:00Z");
  if (!row.player_id || !Number.isFinite(date.getTime())) continue;
  const playerId = String(row.player_id);
  const month = date.getUTCFullYear() * 12 + date.getUTCMonth();
  let months = appearanceMonths.get(playerId);
  if (!months) { months = new Map(); appearanceMonths.set(playerId, months); }
  let totals = months.get(month);
  if (!totals) { totals = { appearances: 0, goals: 0, assists: 0, minutes_played: 0, yellow_cards: 0, red_cards: 0 }; months.set(month, totals); }
  totals.appearances++;
  totals.goals += Number(row.goals) || 0;
  totals.assists += Number(row.assists) || 0;
  totals.minutes_played += Number(row.minutes_played) || 0;
  totals.yellow_cards += Number(row.yellow_cards) || 0;
  totals.red_cards += Number(row.red_cards) || 0;
  appearanceRows++;
}
console.log(`Loaded ${appearanceRows.toLocaleString()} appearance rows across ${appearanceMonths.size.toLocaleString()} players.`);
function seasonEndMs(label) {
  const value = String(label || "").trim();
  const split = value.match(/^(\d{2})\/(\d{2})$/);
  if (split) {
    const start = Number(split[1]) >= 50 ? 1900 + Number(split[1]) : 2000 + Number(split[1]);
    return Date.UTC(start + 1, 6, 1);
  }
  if (/^\d{4}$/.test(value)) return Date.UTC(Number(value) + 1, 0, 1);
  return NaN;
}
function statNumber(value) {
  const text = String(value || "").trim();
  if (!text || text === "-") return 0;
  if (/^\d{1,3}(\.\d{3})+'$/.test(text)) return Number(text.replace(/[.']/g, "")) || 0;
  return Number(text.replace(/[']/g, "")) || 0;
}
const playerSeasons = new Map();
let performanceRows = 0;
const performancePath = resolve(dataDir, "player_performances.csv");
if (existsSync(performancePath)) {
  for await (const row of csvRows("player_performances.csv")) {
    const playerId = String(row.player_id || ""), endMs = seasonEndMs(row.season_name);
    if (!players.has(playerId) || !Number.isFinite(endMs)) continue;
    let seasons = playerSeasons.get(playerId);
    if (!seasons) { seasons = new Map(); playerSeasons.set(playerId, seasons); }
    let totals = seasons.get(endMs);
    if (!totals) { totals = { appearances: 0, goals: 0, assists: 0, minutes_played: 0, clean_sheets: 0, goals_conceded: 0 }; seasons.set(endMs, totals); }
    totals.appearances += statNumber(row.nb_on_pitch);
    totals.goals += statNumber(row.goals);
    totals.assists += statNumber(row.assists);
    totals.minutes_played += statNumber(row.minutes_played);
    totals.clean_sheets += statNumber(row.clean_sheets);
    totals.goals_conceded += statNumber(row.goals_conceded);
    performanceRows++;
  }
}
console.log(`Loaded ${performanceRows.toLocaleString()} dated-by-season performance rows across ${playerSeasons.size.toLocaleString()} players.`);
const transferBins = new Map();
const playerTransferBins = new Map();
let transferRows = 0, usableTransferRows = 0;
for await (const row of csvRows("transfers.csv")) {
  transferRows++;
  const player = players.get(String(row.player_id));
  const fee = Number(row.transfer_fee), marketValue = Number(row.market_value_in_eur);
  const date = new Date(row.transfer_date + "T00:00:00Z");
  if (!player || !(fee > 0) || !(marketValue > 0) || !Number.isFinite(date.getTime())) continue;
  const age = ageAt(player.date_of_birth, row.transfer_date);
  if (age === null || age < 15 || age > 50) continue;
  const month = date.getUTCFullYear() * 12 + date.getUTCMonth();
  const logRatio = Math.max(-2.3, Math.min(2.3, Math.log(fee / marketValue)));
  const playerId = String(row.player_id);
  let ownGroups = playerTransferBins.get(playerId);
  if (!ownGroups) { ownGroups = new Map(); playerTransferBins.set(playerId, ownGroups); }
  for (const key of transferGroupKeys(player, age, marketValue)) {
    for (const bins of [transferBins, ownGroups]) {
      let months = bins.get(key);
      if (!months) { months = new Map(); bins.set(key, months); }
      let totals = months.get(month);
      if (!totals) { totals = { count: 0, logRatioSum: 0 }; months.set(month, totals); }
      totals.count++;
      totals.logRatioSum += logRatio;
    }
  }
  usableTransferRows++;
}
console.log(`Loaded ${transferRows.toLocaleString()} transfer rows; ${usableTransferRows.toLocaleString()} have known positive fee and market value.`);
const examples = [];
for (const [playerId, history] of histories) {
  const player = players.get(playerId);
  if (!player?.date_of_birth) continue;
  history.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const values = history.filter(r => Number(r.market_value_in_eur) > 0 && Number.isFinite(Date.parse(r.date)));
  for (let i = 0; i < values.length - 1; i++) {
    const startMs = Date.parse(values[i].date);
    let target = null, bestGap = Infinity;
    for (let j = i + 1; j < values.length; j++) {
      const days = (Date.parse(values[j].date) - startMs) / DAY;
      if (days > forecastHorizonDays + targetToleranceDays) break;
      if (days >= forecastHorizonDays - targetToleranceDays && Math.abs(days - forecastHorizonDays) < bestGap) { target = values[j]; bestGap = Math.abs(days - forecastHorizonDays); }
    }
    if (!target) continue;
    const sourceIndex = history.lastIndexOf(values[i]);
    const snapshotFeatures = featuresFor(player, history.slice(0, sourceIndex + 1), appearanceMonths.get(playerId), transferBins, playerTransferBins, playerSeasons.get(playerId), playerRoleGrades.get(playerId));
    if (!snapshotFeatures) continue;
    const y = Math.log(Number(target.market_value_in_eur));
    if (!Number.isFinite(y)) continue;
    examples.push({ playerId, x: snapshotFeatures.values, y, targetValue: Number(target.market_value_in_eur), sourceValue: snapshotFeatures.currentValue, sourceDate: snapshotFeatures.current.date, targetDate: target.date, horizonDays: Math.round((Date.parse(target.date) - Date.parse(snapshotFeatures.current.date)) / DAY) });
  }
}
examples.sort((a, b) => a.sourceDate.localeCompare(b.sourceDate));
if (examples.length < 1000) throw new Error(`Only ${examples.length} training examples were created; need at least 1,000. Check valuation dates and player metadata.`);
// Backtest the final year of observed targets. At the cutoff, all training labels are
// already known; each forecast snapshot is strictly after the cutoff.
const cutoff = new Date(Date.parse(latestValuationDate) - forecastHorizonDays * DAY).toISOString().slice(0, 10);
const latestEligibleHoldoutSourceDate = new Date(Date.parse(latestValuationDate) - (forecastHorizonDays - targetToleranceDays) * DAY).toISOString().slice(0, 10);
const train = examples.filter(row => row.targetDate < cutoff);
const holdoutByPlayer = new Map();
for (const row of examples) {
  if (row.sourceDate < cutoff || row.sourceDate > latestEligibleHoldoutSourceDate) continue;
  const previous = holdoutByPlayer.get(row.playerId);
  if (!previous || row.sourceDate > previous.sourceDate) holdoutByPlayer.set(row.playerId, row);
}
const holdout = [...holdoutByPlayer.values()];
if (train.length < 500 || holdout.length < 100) throw new Error(`Temporal split too small: ${train.length} train, ${holdout.length} unique-player holdout.`);
const model = fit(train);
// Keep the best evaluated baseline active: predict no change over the horizon.
model.predictionStrategy = "ridge";
const evaluated = holdout.map(row => {
  const predicted = Math.exp(predictLogValue(model, row.x));
  const actual = row.targetValue;
  const absPct = Math.abs(predicted - actual) / actual;
  const symmetricPct = 2 * Math.abs(predicted - actual) / (predicted + actual);
  const logError = Math.log(predicted) - Math.log(actual);
  return { ...row, predicted, absPct, symmetricPct, logError, absEur: Math.abs(predicted - actual) };
});
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = xs => { const sorted = [...xs].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
function summarize(rows) {
  return {
    examples: rows.length,
    meanAbsolutePercentageError: mean(rows.map(r => r.absPct)),
    medianAbsolutePercentageError: median(rows.map(r => r.absPct)),
    meanSymmetricAbsolutePercentageError: mean(rows.map(r => r.symmetricPct)),
    rootMeanSquaredLogError: Math.sqrt(mean(rows.map(r => r.logError ** 2))),
    meanAbsoluteErrorEur: mean(rows.map(r => r.absEur)),
    meanForecastHorizonDays: mean(rows.map(r => r.horizonDays)),
  };
}
const forecastToSourceRatios = evaluated.map(r => r.predicted / r.sourceValue);
const actualToSourceRatios = evaluated.map(r => r.targetValue / r.sourceValue);
const percentAboveSource = evaluated.filter(r => r.predicted > r.sourceValue * (1 + 1e-12)).length / evaluated.length * 100;
const actualPercentAboveSource = evaluated.filter(r => r.targetValue > r.sourceValue).length / evaluated.length * 100;
const modelMetrics = summarize(evaluated);
const carryForwardPctErrors = evaluated.map(r => Math.abs(r.sourceValue - r.targetValue) / r.targetValue);
const carryForward = mean(carryForwardPctErrors);
const carryForwardMedian = median(carryForwardPctErrors);
const carryForwardSmape = mean(evaluated.map(r => 2 * Math.abs(r.sourceValue - r.targetValue) / (r.sourceValue + r.targetValue)));
const carryForwardMae = mean(evaluated.map(r => Math.abs(r.sourceValue - r.targetValue)));
const growthBaseline = mean(evaluated.map(r => {
  const annualizedGrowth = Math.max(-2, Math.min(2, r.x[2]));
  const forecast = Math.max(1000, Math.min(300_000_000, Math.exp(r.x[0] + annualizedGrowth)));
  return Math.abs(forecast - r.targetValue) / r.targetValue;
}));
const byTargetYear = {};
for (const row of evaluated) {
  const year = row.targetDate.slice(0, 4);
  (byTargetYear[year] ||= []).push(row);
}
const byValueBand = { under_1m: [], "1m_to_10m": [], "10m_plus": [] };
for (const row of evaluated) byValueBand[row.targetValue < 1_000_000 ? "under_1m" : row.targetValue < 10_000_000 ? "1m_to_10m" : "10m_plus"].push(row);
const asPercentMetrics = summary => ({
  examples: summary.examples,
  meanAbsolutePercentageErrorPercent: summary.meanAbsolutePercentageError * 100,
  medianAbsolutePercentageErrorPercent: summary.medianAbsolutePercentageError * 100,
  meanSymmetricAbsolutePercentageErrorPercent: summary.meanSymmetricAbsolutePercentageError * 100,
  rootMeanSquaredLogError: summary.rootMeanSquaredLogError,
  meanAbsoluteErrorEur: summary.meanAbsoluteErrorEur,
  meanForecastHorizonDays: summary.meanForecastHorizonDays,
});
const metrics = {
  ...asPercentMetrics(modelMetrics),
  carryForwardMeanAbsolutePercentageErrorPercent: carryForward * 100,
  carryForwardMedianAbsolutePercentageErrorPercent: carryForwardMedian * 100,
  carryForwardMeanSymmetricAbsolutePercentageErrorPercent: carryForwardSmape * 100,
  carryForwardMeanAbsoluteErrorEur: carryForwardMae,
  annualizedTrendMeanAbsolutePercentageErrorPercent: growthBaseline * 100,
  improvementVsCarryForwardPercent: (carryForward - modelMetrics.meanAbsolutePercentageError) / carryForward * 100,
  percentForecastsAboveSourceValue: percentAboveSource,
  percentActualsAboveSourceValue: actualPercentAboveSource,
  meanForecastToSourceValueRatio: mean(forecastToSourceRatios),
  medianForecastToSourceValueRatio: median(forecastToSourceRatios),
  meanActualToSourceValueRatio: mean(actualToSourceRatios),
  byTargetYear: Object.fromEntries(Object.entries(byTargetYear).map(([year, rows]) => [year, asPercentMetrics(summarize(rows))])),
  byTargetValueBand: Object.fromEntries(Object.entries(byValueBand).map(([band, rows]) => [band, rows.length ? asPercentMetrics(summarize(rows)) : { examples: 0 }])),
};
const artifact = {
  version: `ridge-${forecastHorizonDays}d-v9-position-grades`,
  predictionStrategy: "ridge",
  horizonDays: forecastHorizonDays,
  featureNames: FEATURE_NAMES,
  ...model,
  trainedAt: new Date().toISOString(),
  training: {
    source: "Transfermarkt player-scores Kaggle dataset",
    target: `nearest recorded market value within ±${targetToleranceDays} days of ${forecastHorizonDays} days after snapshot`,
    features: "log current value, age, position, prior value trend, previous 12 complete months of performance, career-to-date stats, latest completed season performance, FBref role-specific performance grades from the latest completed season and recency-weighted last two seasons with data-coverage indicators, position-by-stat interactions, and prior comparable transfer fee-to-market ratios",
    splitMethod: "final-year backtest; training labels end before cutoff; one latest holdout snapshot per player starts at or after cutoff",
    uniquePlayerHoldout: true,
    trainingRows: train.length,
    holdoutRows: holdout.length,
    holdoutPlayers: holdout.length,
    latestDatasetValuationDate: latestValuationDate,
    validationCutoff: cutoff,
    trainTargetDateEnd: new Date(Date.parse(cutoff) - DAY).toISOString().slice(0, 10),
    holdoutSourceDateStart: cutoff,
    holdoutSourceDateEnd: holdout.reduce((latest, row) => row.sourceDate > latest ? row.sourceDate : latest, ""),
    latestEligibleHoldoutSourceDate,
    holdoutTargetDateStart: holdout.reduce((earliest, row) => row.targetDate < earliest ? row.targetDate : earliest, "9999-12-31"),
    holdoutTargetDateEnd: holdout.reduce((latest, row) => row.targetDate > latest ? row.targetDate : latest, ""),
    metrics,
  },
};
mkdirSync(resolve("artifacts"), { recursive: true });
writeFileSync(outputPath, JSON.stringify(artifact, null, 2) + "\n");
console.log(`Saved ${outputPath}`);
console.log(JSON.stringify({ trainingRows: train.length, holdoutPlayers: holdout.length, appearanceRows, performanceRows, performancePlayers: playerSeasons.size, usableTransferRows, latestDatasetValuationDate: latestValuationDate, validationCutoff: cutoff, holdoutSourceDateEnd: artifact.training.holdoutSourceDateEnd, holdoutTargetDateRange: [artifact.training.holdoutTargetDateStart, artifact.training.holdoutTargetDateEnd], metrics }, null, 2));
