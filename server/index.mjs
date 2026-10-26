import { createServer } from "node:http";
import { createReadStream, readFileSync, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { extname, resolve, sep } from "node:path";
import { ageAt, featuresFor, positionBucket, predictValue, roleGradeFeatures, transferGroupKeys } from "./model.mjs";
import { loadRoleGrades } from "./role-grades.mjs";

const root = resolve(process.env.DATA_DIR || "data");
const staticRoot = resolve(process.env.STATIC_DIR || "dist");
const port = Number(process.env.PORT || process.env.API_PORT || 3001);
const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const modelPath = resolve(process.env.MODEL_PATH || "artifacts/market-value-model.json");
let players = [];
let ids = new Map();
let history = new Map();
let playerStats = new Map();
let playerAppearanceMonths = new Map();
let playerSeasonPerformance = new Map();
let playerRoleGrades = new Map();
let transferBins = new Map();
let playerTransferBins = new Map();
let transfersReady = false;
let transferMessage = "";
let ready = false;
let message = "";
let statsReady = false;
let seasonPerformanceReady = false;
let seasonPerformanceMessage = "";
let model = null;
let modelMessage = "";
let competitionNameByCode = new Map();
let filterOptions = { positions: [], leagues: [] };

function parseLine(line) {
  const out = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { out.push(value); value = ""; }
    else value += char;
  }
  out.push(value);
  return out;
}
function readCsv(file) {
  const path = resolve(root, file);
  if (!existsSync(path)) throw new Error("Missing " + file);
  const lines = readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = parseLine(lines.shift() || "");
  return lines.map(line => {
    const values = parseLine(line), row = {};
    headers.forEach((header, i) => row[header] = values[i] || "");
    return row;
  });
}
function ageOf(player) {
  const birth = new Date(player.date_of_birth);
  if (!player.date_of_birth || Number.isNaN(+birth)) return null;
  const target = new Date();
  let age = target.getUTCFullYear() - birth.getUTCFullYear();
  if (target.getUTCMonth() < birth.getUTCMonth() || (target.getUTCMonth() === birth.getUTCMonth() && target.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}
async function loadTransferComparables() {
  const path = resolve(root, "transfers.csv");
  if (!existsSync(path)) {
    transferMessage = "transfers.csv is missing; transfer comparables are unavailable.";
    transfersReady = true;
    return;
  }
  const input = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let headers = null, rows = 0, usable = 0;
  for await (const line of input) {
    if (!headers) { headers = parseLine(line.replace(/^\uFEFF/, "")); continue; }
    if (!line) continue;
    const cells = parseLine(line), get = key => cells[headers.indexOf(key)] || "";
    rows++;
    const player = ids.get(String(get("player_id")));
    const fee = Number(get("transfer_fee")), marketValue = Number(get("market_value_in_eur"));
    const transferDate = get("transfer_date"), date = new Date(transferDate + "T00:00:00Z");
    if (!player || !(fee > 0) || !(marketValue > 0) || !Number.isFinite(date.getTime())) continue;
    const age = ageAt(player.date_of_birth, transferDate);
    if (age === null || age < 15 || age > 50) continue;
    const month = date.getUTCFullYear() * 12 + date.getUTCMonth();
    const logRatio = Math.max(-2.3, Math.min(2.3, Math.log(fee / marketValue)));
    const playerId = String(get("player_id"));
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
    usable++;
  }
  transfersReady = true;
  console.log("Loaded " + rows + " transfer rows; " + usable + " have known fees and market values");
}async function loadAppearanceStats() {
  const path = resolve(root, "appearances.csv");
  if (!existsSync(path)) return;
  const input = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let headers = null;
  for await (const line of input) {
    if (!headers) { headers = parseLine(line.replace(/^\uFEFF/, "")); continue; }
    if (!line) continue;
    const row = parseLine(line);
    const get = key => row[headers.indexOf(key)] || "";
    const playerId = get("player_id");
    if (!ids.has(String(playerId))) continue;
    const appearanceDate = new Date(get("date") + "T00:00:00Z");
    if (Number.isFinite(appearanceDate.getTime())) {
      const monthKey = appearanceDate.getUTCFullYear() * 12 + appearanceDate.getUTCMonth();
      let months = playerAppearanceMonths.get(String(playerId));
      if (!months) { months = new Map(); playerAppearanceMonths.set(String(playerId), months); }
      let monthly = months.get(monthKey);
      if (!monthly) { monthly = { appearances: 0, goals: 0, assists: 0, minutes_played: 0, yellow_cards: 0, red_cards: 0 }; months.set(monthKey, monthly); }
      monthly.appearances++;
      for (const key of ["goals", "assists", "minutes_played", "yellow_cards", "red_cards"]) monthly[key] += Number(get(key)) || 0;
    }
    let stats = playerStats.get(String(playerId));
    if (!stats) stats = { appearances: 0, goals: 0, assists: 0, minutes_played: 0, yellow_cards: 0, red_cards: 0 };
    stats.appearances++;
    for (const key of ["goals", "assists", "minutes_played", "yellow_cards", "red_cards"]) stats[key] += Number(get(key)) || 0;
    playerStats.set(String(playerId), stats);
  }
  statsReady = true;
  console.log("Aggregated match statistics from appearances.csv for " + playerStats.size + " players");
}
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
async function loadSeasonPerformance() {
  const path = resolve(root, "player_performances.csv");
  if (!existsSync(path)) { seasonPerformanceMessage = "player_performances.csv is missing; completed-season features are unavailable."; seasonPerformanceReady = true; return; }
  const input = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let headers = null, rows = 0, matched = 0;
  for await (const line of input) {
    if (!headers) { headers = parseLine(line.replace(/^\uFEFF/, "")); continue; }
    if (!line) continue;
    const cells = parseLine(line), get = key => cells[headers.indexOf(key)] || "";
    const playerId = String(get("player_id")), seasonEnd = seasonEndMs(get("season_name"));
    if (!ids.has(playerId) || !Number.isFinite(seasonEnd)) continue;
    let seasons = playerSeasonPerformance.get(playerId);
    if (!seasons) { seasons = new Map(); playerSeasonPerformance.set(playerId, seasons); }
    let totals = seasons.get(seasonEnd);
    if (!totals) { totals = { appearances: 0, goals: 0, assists: 0, minutes_played: 0, clean_sheets: 0, goals_conceded: 0 }; seasons.set(seasonEnd, totals); }
    totals.appearances += statNumber(get("nb_on_pitch"));
    totals.goals += statNumber(get("goals"));
    totals.assists += statNumber(get("assists"));
    totals.minutes_played += statNumber(get("minutes_played"));
    totals.clean_sheets += statNumber(get("clean_sheets"));
    totals.goals_conceded += statNumber(get("goals_conceded"));
    rows++; matched++;
  }
  seasonPerformanceReady = true;
  console.log("Loaded " + rows + " completed-season performance rows for " + matched + " player records");
}function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" });
  res.end(JSON.stringify(body));
}
function serveBuiltApp(pathname, res) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return send(res, 400, { error: "invalid_path" }); }
  const candidate = resolve(staticRoot, "." + decoded);
  if (candidate !== staticRoot && !candidate.startsWith(staticRoot + sep)) return send(res, 400, { error: "invalid_path" });
  const file = existsSync(candidate) && statSync(candidate).isFile() ? candidate : resolve(staticRoot, "index.html");
  if (!existsSync(file)) return send(res, 503, { error: "frontend_unavailable", message: "Run npm run build before starting the production server." });
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon" };
  res.writeHead(200, { "Content-Type": types[extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable" });
  createReadStream(file).on("error", () => { if (!res.headersSent) res.writeHead(500); res.end(); }).pipe(res);
}

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*" }); return res.end(); }
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/health") return send(res, 200, { ok: true, datasetLoaded: ready, players: players.length, appearancesLoaded: statsReady, seasonPerformanceLoaded: seasonPerformanceReady, seasonPerformanceMessage: seasonPerformanceMessage || null, modelLoaded: Boolean(model), modelVersion: model?.version || null, transfersLoaded: transfersReady, transferMessage: transferMessage || null, message: message || null, modelMessage: modelMessage || null });
  if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") return process.env.NODE_ENV === "production" ? serveBuiltApp(url.pathname, res) : send(res, 404, { error: "not_found" });
  if (!ready) return send(res, 503, { error: "dataset_unavailable", message });
  if (url.pathname === "/api/filter-options") return send(res, 200, filterOptions);
  const parts = url.pathname.slice(5).split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "players") return send(res, 404, { error: "not_found" });
  if (parts.length === 1) {
    const query = (url.searchParams.get("q") || "").toLowerCase();
    const position = (url.searchParams.get("position") || "").toLowerCase();
    const club = (url.searchParams.get("club") || "").toLowerCase();
    const league = (url.searchParams.get("league") || "").toLowerCase();
    let result = players.filter(player => {
      const text = [player.name, player.player_code, player.current_club_name, player.position, player.sub_position].join(" ").toLowerCase();
      const age = ageOf(player);
      return (!query || text.includes(query)) &&
        (!position || (player.position || "").toLowerCase().includes(position)) &&
        (!club || (player.current_club_name || "").toLowerCase().includes(club)) &&
        (!league || [player.current_club_domestic_competition_id, competitionNameByCode.get(player.current_club_domestic_competition_id)].join(" ").toLowerCase().includes(league)) &&
        (!url.searchParams.has("minAge") || (age !== null && age >= Number(url.searchParams.get("minAge")))) &&
        (!url.searchParams.has("maxAge") || (age !== null && age <= Number(url.searchParams.get("maxAge"))));
    });
    const sort = url.searchParams.get("sort") || "name";
    const direction = url.searchParams.get("order") === "desc" ? -1 : 1;
    result.sort((a, b) => direction * (sort === "market_value"
      ? Number(a.market_value_in_eur || 0) - Number(b.market_value_in_eur || 0)
      : sort === "age" ? (ageOf(a) ?? 999) - (ageOf(b) ?? 999)
      : String(a.name || "").localeCompare(String(b.name || ""))));
    const total = result.length;
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 40)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    return send(res, 200, { players: result.slice(offset, offset + limit), total, limit, offset });
  }
  if (parts.length === 2) {
    const player = ids.get(parts[1]);
    return player ? send(res, 200, player) : send(res, 404, { error: "player_not_found" });
  }
  if (parts.length === 3 && parts[2] === "prediction") {
    const player = ids.get(parts[1]);
    if (!player) return send(res, 404, { error: "player_not_found" });
    if (!model) return send(res, 503, { error: "model_unavailable", message: modelMessage || "Train the model first." });
    const playerHistory = history.get(parts[1]) || [];
    let sourceDate, sourceValue, estimatedValue;
    if (model.predictionStrategy === "carry-forward") {
      const latest = playerHistory.filter(row => row.date && Number(row.market_value_in_eur) > 0)
        .sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1);
      if (!latest) return send(res, 200, { available: false, message: "A dated market valuation is needed for this estimate." });
      sourceDate = latest.date;
      sourceValue = Number(latest.market_value_in_eur);
      estimatedValue = sourceValue;
    } else {
      if ((!statsReady && existsSync(resolve(root, "appearances.csv"))) || (!seasonPerformanceReady && existsSync(resolve(root, "player_performances.csv"))) || (!transfersReady && existsSync(resolve(root, "transfers.csv")))) return send(res, 503, { error: "model_initializing", message: "Performance and comparable-transfer features are still loading." });
      const input = featuresFor(player, playerHistory, playerAppearanceMonths.get(parts[1]), transferBins, playerTransferBins, playerSeasonPerformance.get(parts[1]), playerRoleGrades.get(parts[1]));
      if (!input) return send(res, 200, { available: false, message: "A dated valuation and date of birth are needed for this estimate." });
      sourceDate = input.current.date;
      sourceValue = input.currentValue;
      estimatedValue = predictValue(model, input.values);
    }
    const forecastDate = new Date(new Date(sourceDate + "T00:00:00Z").getTime() + model.horizonDays * 86_400_000).toISOString().slice(0, 10);
    const gradeValues = roleGradeFeatures(sourceDate, playerRoleGrades.get(parts[1]));
    const completedGrades = [...(playerRoleGrades.get(parts[1]) || new Map()).entries()]
      .filter(([endMs]) => endMs <= new Date(sourceDate + "T00:00:00Z").getTime())
      .sort((a, b) => a[0] - b[0]).slice(-2).reverse();
    const seasonLabel = endMs => { const endYear = new Date(endMs).getUTCFullYear(); return `${endYear - 1}/${String(endYear).slice(-2)}`; };
    return send(res, 200, {
      available: Number.isFinite(estimatedValue), model: model.version,
      horizon_days: model.horizonDays, source_date: sourceDate,
      forecast_date: forecastDate, source_value_in_eur: sourceValue,
      estimated_value_in_eur: estimatedValue,
      performance_grade: {
        available: gradeValues[2] > 0,
        position: positionBucket(player),
        latest_completed: completedGrades[0] ? { season: seasonLabel(completedGrades[0][0]), score: gradeValues[0], coverage: gradeValues[2] } : null,
        last_two_seasons: { score: gradeValues[1], coverage: gradeValues[3], seasons: completedGrades.map(([endMs]) => seasonLabel(endMs)) },
      },
    });
  }  if (parts.length === 3 && parts[2] === "value-history") {
    return ids.has(parts[1]) ? send(res, 200, history.get(parts[1]) || []) : send(res, 404, { error: "player_not_found" });
  }
  if (parts.length === 3 && parts[2] === "stats") {
    if (!ids.has(parts[1])) return send(res, 404, { error: "player_not_found" });
    if (!statsReady) return send(res, 200, { available: false, message: "Add appearances.csv to the data folder to load match statistics." });
    const stats = playerStats.get(parts[1]);
    return stats ? send(res, 200, { available: true, coverage: "appearances in the dataset", ...stats }) : send(res, 200, { available: false, message: "No appearance records are available for this player in the dataset." });
  }
  return send(res, 404, { error: "not_found" });
});

server.on("error", error => {
  console.error("API server could not start on port " + port + ": " + error.message + ". Stop the other API process or set API_PORT to a free port.");
  process.exitCode = 1;
});
server.listen(port, host, () => console.log("Touchline server at http://" + host + ":" + port + "; health at /api/health"));

async function start() {
  try {
    players = readCsv("players.csv");
    const valuations = readCsv("player_valuations.csv");
    try {
      model = JSON.parse(readFileSync(modelPath, "utf8"));
      console.log("Loaded model " + model.version);
    } catch (error) {
      modelMessage = "Model artifact unavailable: " + error.message + ". Run npm run train:model.";
      console.warn(modelMessage);
    }
    ids = new Map(players.map(player => [String(player.player_id), player]));
    try {
      const competitions = readCsv("competitions.csv");
      competitionNameByCode = new Map(competitions.filter(row => row.domestic_league_code).map(row => [row.domestic_league_code, row.name || row.competition_code || row.domestic_league_code]));
    } catch { competitionNameByCode = new Map(); }
    filterOptions = {
      positions: [...new Set(players.map(player => player.position).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
      leagues: [...new Set(players.map(player => player.current_club_domestic_competition_id).filter(Boolean))].map(code => ({ code, name: competitionNameByCode.get(code) || code })).sort((a, b) => a.name.localeCompare(b.name)),
    };
    playerRoleGrades = loadRoleGrades(root, ids);
    for (const row of valuations) {
      const key = String(row.player_id);
      if (!history.has(key)) history.set(key, []);
      history.get(key).push(row);
    }
    for (const records of history.values()) records.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    ready = true;
    console.log("Loaded " + players.length + " players and " + valuations.length + " valuations");
    // Player search and predictions can serve immediately; appearance aggregation runs in the background.
    loadTransferComparables().catch(error => { transferMessage = error.message; transfersReady = true; console.warn("Could not load transfers.csv: " + error.message); });
    loadSeasonPerformance().catch(error => { seasonPerformanceMessage = error.message; seasonPerformanceReady = true; console.warn("Could not load player_performances.csv: " + error.message); });
    loadAppearanceStats().then(() => {
      console.log("Appearance statistics and rolling model features are ready.");
    }).catch(error => {
      console.warn("Could not load appearances.csv: " + error.message); statsReady = true;
    });
  } catch (error) {
    message = error.message;
    console.warn("Dataset unavailable: " + message + ". Put players.csv and player_valuations.csv in " + root);
  }
}
start();