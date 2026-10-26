export const HORIZON_DAYS = 120;
const POSITION_GROUPS = ["goalkeeper", "defense", "midfield", "attack"];
const POSITION_STAT_NAMES = [
  "recent_appearances", "recent_goals", "recent_assists", "recent_minutes",
  "career_appearances", "career_goals", "career_assists", "career_minutes", "career_yellow_cards", "career_red_cards",
  "season_appearances", "season_goals", "season_assists", "season_minutes", "season_clean_sheets", "season_goals_conceded",
];
export const FEATURE_NAMES = [
  "log_current_value",
  "age_years",
  "annualized_value_growth",
  "years_since_previous_valuation",
  "position_goalkeeper",
  "position_defense",
  "position_midfield",
  "position_attack",
  "position_unknown",
  "appearances_previous_12_full_months",
  "goals_previous_12_full_months",
  "assists_previous_12_full_months",
  "minutes_previous_12_full_months",
  "career_appearances_before_source_month",
  "career_goals_before_source_month",
  "career_assists_before_source_month",
  "career_minutes_before_source_month",
  "career_yellow_cards_before_source_month",
  "career_red_cards_before_source_month",
  "last_completed_season_appearances",
  "last_completed_season_goals",
  "last_completed_season_assists",
  "last_completed_season_minutes",
  "last_completed_season_clean_sheets",
  "last_completed_season_goals_conceded",
  "latest_completed_position_grade",
  "last_two_seasons_position_grade",
  "latest_position_grade_coverage",
  "two_season_position_grade_coverage",
  ...POSITION_GROUPS.flatMap(position => POSITION_STAT_NAMES.map(stat => `${position}_${stat}`)),
  "comparable_transfer_log_fee_to_value_ratio",
  "log1p_comparable_transfer_count",
];
const DAY = 86_400_000;
const VALUE_TREND_LOOKBACK_DAYS = 365;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function dateMs(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.getTime() : NaN;
}
export function ageAt(birthDate, targetDate) {
  const born = dateMs(birthDate), target = dateMs(targetDate);
  if (!Number.isFinite(born) || !Number.isFinite(target)) return null;
  return (target - born) / (365.2425 * DAY);
}
export function positionBucket(player) {
  const p = String(player.position || player.sub_position || "").toLowerCase();
  if (p.includes("goalkeeper")) return "goalkeeper";
  if (p.includes("defen") || p.includes("back")) return "defense";
  if (p.includes("midfield")) return "midfield";
  if (p.includes("attack") || p.includes("forward")) return "attack";
  return "unknown";
}
function ageBand(age) {
  if (age < 21) return "u21";
  if (age < 25) return "21_24";
  if (age < 29) return "25_28";
  return "29_plus";
}
export function valueBand(value) {
  if (value < 1_000_000) return "under_1m";
  if (value < 5_000_000) return "1m_5m";
  if (value < 20_000_000) return "5m_20m";
  if (value < 50_000_000) return "20m_50m";
  return "50m_plus";
}
export function transferGroupKeys(player, age, marketValue) {
  const position = positionBucket(player);
  const ageGroup = ageBand(clamp(age, 15, 50));
  const valueGroup = valueBand(marketValue);
  return [
    `${position}|${ageGroup}|${valueGroup}`,
    `${position}|${ageGroup}|*`,
    `${position}|*|*`,
    `*|*|*`,
  ];
}
function previousTwelveMonths(sourceDate, monthlyStats) {
  const target = new Date(sourceDate + "T00:00:00Z");
  const currentMonth = target.getUTCFullYear() * 12 + target.getUTCMonth();
  const totals = { appearances: 0, goals: 0, assists: 0, minutes_played: 0 };
  if (monthlyStats) {
    for (let offset = 1; offset <= 12; offset++) {
      const month = monthlyStats.get(currentMonth - offset);
      if (!month) continue;
      for (const key of Object.keys(totals)) totals[key] += month[key] || 0;
    }
  }
  return [totals.appearances, totals.goals, totals.assists, totals.minutes_played];
}
function careerStatsToDate(sourceDate, monthlyStats) {
  if (!monthlyStats) return [0, 0, 0, 0, 0, 0];
  const target = new Date(sourceDate + "T00:00:00Z");
  const currentMonth = target.getUTCFullYear() * 12 + target.getUTCMonth();
  const totals = { appearances: 0, goals: 0, assists: 0, minutes_played: 0, yellow_cards: 0, red_cards: 0 };
  for (const [monthIndex, month] of monthlyStats) {
    if (monthIndex >= currentMonth) continue;
    for (const key of Object.keys(totals)) totals[key] += month[key] || 0;
  }
  return [totals.appearances, totals.goals, totals.assists, totals.minutes_played, totals.yellow_cards, totals.red_cards];
}
export function roleGradeFeatures(sourceDate, playerRoleGrades) {
  const sourceMs = dateMs(sourceDate);
  const completed = playerRoleGrades
    ? [...playerRoleGrades.entries()].filter(([endMs, grade]) => endMs <= sourceMs && Number.isFinite(grade.grade)).sort((a, b) => a[0] - b[0]).slice(-2).reverse().map(([, grade]) => grade)
    : [];
  if (!completed.length) return [50, 50, 0, 0];
  const latest = completed[0];
  let scoreSum = 0, weightSum = 0, coverageSum = 0;
  const recencyWeights = [0.65, 0.35];
  completed.forEach((grade, index) => {
    const recency = recencyWeights[index], weight = recency * Math.max(0, Math.min(1, grade.coverage));
    scoreSum += grade.grade * weight;
    coverageSum += grade.coverage * recency;
    weightSum += weight;
  });
  const overall = weightSum ? scoreSum / weightSum : 50;
  const coverageDenominator = recencyWeights.slice(0, completed.length).reduce((a, b) => a + b, 0);
  return [latest.grade, overall, latest.coverage, coverageSum / coverageDenominator];
}
function positionPerformanceInteractions(bucket, recent, career, season) {
  const stats = [
    ["recent_appearances", recent[0]], ["recent_goals", recent[1]], ["recent_assists", recent[2]], ["recent_minutes", recent[3]],
    ["career_appearances", career[0]], ["career_goals", career[1]], ["career_assists", career[2]], ["career_minutes", career[3]],
    ["career_yellow_cards", career[4]], ["career_red_cards", career[5]],
    ["season_appearances", season[0]], ["season_goals", season[1]], ["season_assists", season[2]], ["season_minutes", season[3]],
    ["season_clean_sheets", season[4]], ["season_goals_conceded", season[5]],
  ];
  return POSITION_GROUPS.flatMap(position => stats.map(([, value]) => position === bucket ? value : 0));
}
function completedSeasonStats(sourceDate, playerSeasons) {
  const sourceMs = dateMs(sourceDate);
  let latest = null;
  if (playerSeasons) {
    for (const [seasonEndMs, totals] of playerSeasons) {
      if (seasonEndMs <= sourceMs && (!latest || seasonEndMs > latest.seasonEndMs)) latest = { seasonEndMs, totals };
    }
  }
  if (!latest) return [0, 0, 0, 0, 0, 0];
  const t = latest.totals;
  return [t.appearances, t.goals, t.assists, t.minutes_played, t.clean_sheets, t.goals_conceded];
}function transferFeatures(sourceDate, player, age, value, bins, playerBins) {
  if (!bins) return [0, 0];
  const current = new Date(sourceDate + "T00:00:00Z");
  const currentMonth = current.getUTCFullYear() * 12 + current.getUTCMonth();
const groups = transferGroupKeys(player, age, value);
  const ownGroups = playerBins?.get(String(player.player_id));
  const countFor = key => {
    const months = bins.get(key), ownMonths = ownGroups?.get(key);
    if (!months) return { count: 0, logRatioSum: 0 };
    let count = 0, logRatioSum = 0;
    for (let offset = 1; offset <= 36; offset++) {
      const monthKey = currentMonth - offset;
      const stats = months.get(monthKey), own = ownMonths?.get(monthKey);
      if (stats) { count += stats.count; logRatioSum += stats.logRatioSum; }
      if (own) { count -= own.count; logRatioSum -= own.logRatioSum; }
    }
    return { count, logRatioSum };
  };  const minimumCounts = [5, 10, 20, 30];
  let chosen = { count: 0, logRatioSum: 0 }, specificity = 0;
  for (let i = 0; i < groups.length; i++) {
    const candidate = countFor(groups[i]);
    if (candidate.count >= minimumCounts[i]) { chosen = candidate; specificity = groups.length - i - 1; break; }
    if (candidate.count > chosen.count) { chosen = candidate; specificity = groups.length - i - 1; }
  }
  if (!chosen.count) return [0, 0];
  return [
    clamp(chosen.logRatioSum / chosen.count, -2.3, 2.3),
    Math.log1p(chosen.count),
  ];
}
export function featuresFor(player, records, monthlyStats, transferBins, playerTransferBins, playerSeasons, playerRoleGrades) {
  if (!Array.isArray(records) || !records.length) return null;
  const ordered = records.filter(r => Number(r.market_value_in_eur) > 0 && r.date).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!ordered.length) return null;
  const current = ordered[ordered.length - 1];
  const currentValue = Number(current.market_value_in_eur);
  const currentMs = dateMs(current.date);
  const age = ageAt(player.date_of_birth, current.date);
  if (!(currentValue > 0) || !Number.isFinite(currentMs) || age === null) return null;
  let previous = null, previousDelta = Infinity;
  for (let i = ordered.length - 2; i >= 0; i--) {
    const delta = (currentMs - dateMs(ordered[i].date)) / DAY;
    if (delta > 550) break;
    if (delta >= 180 && Math.abs(delta - VALUE_TREND_LOOKBACK_DAYS) < previousDelta) {
      previous = ordered[i];
      previousDelta = Math.abs(delta - VALUE_TREND_LOOKBACK_DAYS);
    }
  }
  const daysSincePrevious = previous ? (currentMs - dateMs(previous.date)) / DAY : 0;
  const growth = previous
    ? clamp(Math.log(currentValue / Number(previous.market_value_in_eur)) / (daysSincePrevious / VALUE_TREND_LOOKBACK_DAYS), -2, 2)
    : 0;
  const bucket = positionBucket(player);
  const recent = previousTwelveMonths(current.date, monthlyStats);
  const career = careerStatsToDate(current.date, monthlyStats);
  const season = completedSeasonStats(current.date, playerSeasons);
  const positionInteractions = positionPerformanceInteractions(bucket, recent, career, season);
  const values = [
    Math.log(currentValue),
    clamp(age, 15, 50),
    growth,
    previous ? daysSincePrevious / VALUE_TREND_LOOKBACK_DAYS : 0,
    Number(bucket === "goalkeeper"),
    Number(bucket === "defense"),
    Number(bucket === "midfield"),
    Number(bucket === "attack"),
    Number(bucket === "unknown"),
    ...recent,
    ...career,
    ...season,
    ...roleGradeFeatures(current.date, playerRoleGrades),
    ...positionInteractions,
    ...transferFeatures(current.date, player, age, currentValue, transferBins, playerTransferBins),
  ];
  return { values, current, currentValue };
}
export function predictLogValue(model, values) {
  // Carry-forward baseline: features[0] is log(latest recorded market value).
  if (model.predictionStrategy === "carry-forward") return values[0];
  let result = model.intercept;
  for (let i = 0; i < values.length; i++) {
    result += model.coefficients[i] * ((values[i] - model.means[i]) / model.scales[i]);
  }
  if (model.predictionStrategy === "ridge-relative") {
    const band = valueBand(Math.exp(values[0]));
    const bounds = model.changeBounds?.[band] || model.changeBounds?.all;
    if (bounds && Number.isFinite(bounds.lowerLogChange) && Number.isFinite(bounds.upperLogChange)) {
      result = clamp(result, bounds.lowerLogChange, bounds.upperLogChange);
    }
    return values[0] + result;
  }
  return result;
}
export function predictValue(model, values) {
  const logValue = predictLogValue(model, values);
  if (!Number.isFinite(logValue)) return null;
  return Math.round(clamp(Math.exp(clamp(logValue, Math.log(1000), Math.log(300_000_000))), 1000, 300_000_000));
}

