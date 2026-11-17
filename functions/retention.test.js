const test = require("node:test");
const assert = require("node:assert");
const { cohortRows, levelTable } = require("./sources");

test("cohort rows keep only the days each cohort has reached", () => {
  const today = new Date(Date.UTC(2026, 10, 17));
  const rows = cohortRows([
    { cohort: "20261115", cohortNthDay: "0000", cohortActiveUsers: 10, cohortTotalUsers: 10 },
    { cohort: "20261115", cohortNthDay: "0001", cohortActiveUsers: 4, cohortTotalUsers: 10 },
    { cohort: "20261108", cohortNthDay: "0001", cohortActiveUsers: 6, cohortTotalUsers: 20 },
    { cohort: "20261108", cohortNthDay: "0007", cohortActiveUsers: 2, cohortTotalUsers: 20 },
  ], today);
  assert.deepStrictEqual(rows.map((r) => r.date), ["2026-11-15", "2026-11-08"]);
  assert.deepStrictEqual(rows[0].active, { 1: 4 });
  assert.deepStrictEqual(rows[1].active, { 1: 6, 3: 0, 7: 2 });
  assert.strictEqual(rows[1].size, 20);
});

test("the level table sorts ids naturally and joins the expected win rate", () => {
  const rows = levelTable([
    { "customEvent:level_id": "w1_l10", eventName: "level_start", eventCount: 5, totalUsers: 4 },
    { "customEvent:level_id": "w1_l2", eventName: "level_start", eventCount: 9, totalUsers: 8 },
    { "customEvent:level_id": "w1_l2", eventName: "level_complete", eventCount: 6, totalUsers: 6 },
    { "customEvent:level_id": "w1_l2", eventName: "level_fail", eventCount: 3, totalUsers: 2 },
    { "customEvent:level_id": "(not set)", eventName: "level_start", eventCount: 1, totalUsers: 1 },
  ], [{ "customEvent:level_id": "w1_l2", "averageCustomEvent:expected_win": "0.72" }]);
  assert.deepStrictEqual(rows.map((r) => r.id), ["w1_l2", "w1_l10"]);
  assert.strictEqual(rows[0].wins, 6);
  assert.strictEqual(rows[0].losses, 3);
  assert.strictEqual(rows[0].expectedWin, 0.72);
});
