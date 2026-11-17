// Daily aggregates in BigQuery, from the Google Analytics export
// (analytics_<property>.events_YYYYMMDD). Once a day, after the export lands,
// the last few days are rebuilt in the dataset `blocktrail_stats`:
//
//   daily_kpis         date, active and new players, sessions, minutes per player, ad and purchase revenue
//   retention_cohorts  install date, size, players back on day 1, 3, 7, 14 and 30
//   level_funnel       date, level, players who started, wins, losses, mean expected_win
//
// Testers (user property tester = "yes") are left out. Until the export is
// linked in Firebase ▸ Project settings ▸ Integrations ▸ BigQuery, the job only
// logs that it is waiting. Nothing here is read by the page yet: it is the base
// for the panels to read precomputed numbers instead of asking Analytics live.

const { BigQuery } = require("@google-cloud/bigquery");

const DATASET = "blocktrail_stats";
/** Rebuilt every day: the export can still add events to the last 3 days. */
const REBUILD_DAYS = 3;

const sql = {
  dailyKpis: (src) => `
    CREATE TABLE IF NOT EXISTS \`${DATASET}.daily_kpis\` (
      date DATE, active_users INT64, new_users INT64, sessions INT64, minutes_per_user FLOAT64,
      ad_revenue FLOAT64, purchase_revenue FLOAT64, purchasers INT64, updated_at TIMESTAMP)
    PARTITION BY date;
    DELETE FROM \`${DATASET}.daily_kpis\` WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL ${REBUILD_DAYS} DAY);
    INSERT INTO \`${DATASET}.daily_kpis\`
    WITH ev AS (
      SELECT PARSE_DATE('%Y%m%d', event_date) AS date, user_pseudo_id, event_name, event_params, ecommerce,
             (SELECT value.string_value FROM UNNEST(user_properties) WHERE key = 'tester') AS tester
      FROM \`${src}.events_*\`
      WHERE _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL ${REBUILD_DAYS} DAY)))
    SELECT date,
      COUNT(DISTINCT user_pseudo_id),
      COUNT(DISTINCT IF(event_name = 'first_open', user_pseudo_id, NULL)),
      COUNTIF(event_name = 'session_start'),
      SAFE_DIVIDE(SUM((SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'engagement_time_msec')) / 60000,
                  COUNT(DISTINCT user_pseudo_id)),
      SUM(IF(event_name = 'ad_paid', (SELECT COALESCE(value.double_value, value.float_value, value.int_value) FROM UNNEST(event_params) WHERE key = 'value'), 0)),
      SUM(IF(event_name = 'in_app_purchase', ecommerce.purchase_revenue_in_usd, 0)),
      COUNT(DISTINCT IF(event_name = 'in_app_purchase', user_pseudo_id, NULL)),
      CURRENT_TIMESTAMP()
    FROM ev WHERE IFNULL(tester, 'no') != 'yes'
    GROUP BY date;`,

  retention: (src) => `
    CREATE TABLE IF NOT EXISTS \`${DATASET}.retention_cohorts\` (
      install_date DATE, size INT64, d1 INT64, d3 INT64, d7 INT64, d14 INT64, d30 INT64, updated_at TIMESTAMP);
    DELETE FROM \`${DATASET}.retention_cohorts\` WHERE install_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 40 DAY);
    INSERT INTO \`${DATASET}.retention_cohorts\`
    WITH ev AS (
      SELECT user_pseudo_id, PARSE_DATE('%Y%m%d', event_date) AS date, event_name,
             (SELECT value.string_value FROM UNNEST(user_properties) WHERE key = 'tester') AS tester
      FROM \`${src}.events_*\`
      WHERE _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 75 DAY))),
    installs AS (
      SELECT user_pseudo_id, MIN(date) AS install_date FROM ev WHERE event_name = 'first_open' AND IFNULL(tester, 'no') != 'yes'
      GROUP BY user_pseudo_id HAVING install_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 40 DAY)),
    days AS (SELECT DISTINCT user_pseudo_id, date FROM ev)
    SELECT i.install_date, COUNT(DISTINCT i.user_pseudo_id),
      COUNT(DISTINCT IF(DATE_DIFF(d.date, i.install_date, DAY) = 1, i.user_pseudo_id, NULL)),
      COUNT(DISTINCT IF(DATE_DIFF(d.date, i.install_date, DAY) = 3, i.user_pseudo_id, NULL)),
      COUNT(DISTINCT IF(DATE_DIFF(d.date, i.install_date, DAY) = 7, i.user_pseudo_id, NULL)),
      COUNT(DISTINCT IF(DATE_DIFF(d.date, i.install_date, DAY) = 14, i.user_pseudo_id, NULL)),
      COUNT(DISTINCT IF(DATE_DIFF(d.date, i.install_date, DAY) = 30, i.user_pseudo_id, NULL)),
      CURRENT_TIMESTAMP()
    FROM installs i LEFT JOIN days d USING (user_pseudo_id)
    GROUP BY i.install_date;`,

  levels: (src) => `
    CREATE TABLE IF NOT EXISTS \`${DATASET}.level_funnel\` (
      date DATE, level_id STRING, started_users INT64, wins INT64, losses INT64, expected_win FLOAT64, updated_at TIMESTAMP)
    PARTITION BY date;
    DELETE FROM \`${DATASET}.level_funnel\` WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL ${REBUILD_DAYS} DAY);
    INSERT INTO \`${DATASET}.level_funnel\`
    WITH ev AS (
      SELECT PARSE_DATE('%Y%m%d', event_date) AS date, user_pseudo_id, event_name,
             (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'level_id') AS level_id,
             (SELECT COALESCE(value.double_value, value.float_value) FROM UNNEST(event_params) WHERE key = 'expected_win') AS expected_win,
             (SELECT value.string_value FROM UNNEST(user_properties) WHERE key = 'tester') AS tester
      FROM \`${src}.events_*\`
      WHERE _TABLE_SUFFIX >= FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL ${REBUILD_DAYS} DAY))
        AND event_name IN ('level_start', 'level_complete', 'level_fail'))
    SELECT date, level_id,
      COUNT(DISTINCT IF(event_name = 'level_start', user_pseudo_id, NULL)),
      COUNTIF(event_name = 'level_complete'), COUNTIF(event_name = 'level_fail'),
      AVG(IF(event_name != 'level_start', expected_win, NULL)), CURRENT_TIMESTAMP()
    FROM ev WHERE level_id IS NOT NULL AND IFNULL(tester, 'no') != 'yes'
    GROUP BY date, level_id;`,
};

/** Builds the aggregates; returns what it did, or why it waited. */
async function buildAggregates(property, { client = new BigQuery() } = {}) {
  const source = `analytics_${property}`;
  const [exists] = await client.dataset(source).exists();
  if (!exists) return { waiting: `No existe el dataset ${source}: vincula Analytics con BigQuery en Firebase.` };
  const [ours] = await client.dataset(DATASET).exists();
  if (!ours) {
    const [meta] = await client.dataset(source).getMetadata();
    await client.createDataset(DATASET, { location: meta.location });
  }
  const done = [];
  for (const [name, build] of Object.entries(sql)) {
    await client.query({ query: build(source), location: undefined });
    done.push(name);
  }
  return { done };
}

module.exports = { buildAggregates, sql, DATASET };
