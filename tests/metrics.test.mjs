import test from "node:test";
import assert from "node:assert/strict";
import { change, cohortWeeks, datesOf, funnel, levelRows, summary, weekOf, windowsFor } from "../docs/metrics.js";

const today = new Date(2026, 10, 17); // 17 Nov 2026, local time

test("periods end yesterday and the previous one sits right before", () => {
  const w = windowsFor(7, today);
  assert.deepEqual(w.cur, ["2026-11-10", "2026-11-16"]);
  assert.deepEqual(w.prev, ["2026-11-03", "2026-11-09"]);
  assert.equal(datesOf(w.cur).length, 7);
});

test("the summary adds AdMob, Unity and purchases and divides by DAU-days", () => {
  const days = datesOf(windowsFor(7, today).cur);
  const prevDays = datesOf(windowsFor(7, today).prev);
  const analytics = { daily: [...prevDays, ...days].map((d) => ({ date: d.replaceAll("-", ""), activeUsers: 100, purchaseRevenue: 1 })) };
  const admob = { rows: days.map((d) => ({ date: d, earnings: 2, impressions: 300, requests: 400, matched: 360 })) };
  const unity = { rows: days.map((d) => ({ date: d, revenue: 0.5, views: 50 })) };
  const s = summary({ analytics, admob, unity }, 7, today);
  const tile = (k) => s.tiles.find((t) => t.key === k);
  assert.equal(tile("revenue").cur, 7 * 3.5);
  assert.equal(tile("revenue").prev, 7 * 1);
  assert.equal(tile("arpdau").cur, 3.5 / 100);
  assert.equal(tile("impsPerDau").cur, 3.5);
  assert.equal(tile("fill").cur, 0.9);
  assert.equal(tile("fill").prev, null);
  assert.equal(tile("revenue").series.length, 7);
  assert.equal(tile("d1").cur, null);
});

test("D1 counts only the cohorts of the period that reached day 1", () => {
  const retention = { days: [1, 7], cohorts: [
    { date: "2026-11-16", size: 50, active: {} },
    { date: "2026-11-15", size: 100, active: { 1: 40 } },
    { date: "2026-11-05", size: 100, active: { 1: 20, 7: 5 } },
  ] };
  const s = summary({ retention }, 7, today);
  const d1 = s.tiles.find((t) => t.key === "d1");
  assert.equal(d1.cur, 0.4);
  assert.equal(d1.prev, 0.2);
  assert.equal(d1.small, false);
});

test("a change on a small sample is not coloured", () => {
  assert.deepEqual(change(120, 100), { text: "+20 %", tone: "up" });
  assert.equal(change(120, 100, { small: true }).tone, null);
  assert.equal(change(80, 100, { goodWhenUp: false }).tone, "up");
  assert.equal(change(5, 0).text, "nuevo");
  assert.equal(change(null, 3).text, "");
});

test("cohorts group by install week and only count days already reached", () => {
  assert.equal(weekOf("2026-11-17"), "2026-11-16");
  const rows = cohortWeeks({ days: [1, 7], cohorts: [
    { date: "2026-11-16", size: 10, active: {} },
    { date: "2026-11-10", size: 30, active: { 1: 9, 7: 3 } },
    { date: "2026-11-09", size: 20, active: { 1: 4 } },
  ] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].week, "2026-11-16");
  assert.equal(rows[0].rates[1], null);
  assert.equal(rows[1].week, "2026-11-09");
  assert.equal(rows[1].size, 50);
  assert.equal(rows[1].rates[1], 13 / 50);
  assert.equal(rows[1].rates[7], 3 / 30);
  assert.equal(rows[1].partial[7], true);
  assert.equal(rows[1].partial[1], false);
});

test("funnel steps keep the share of the first and previous step", () => {
  const f = funnel(["a", "b", "c"], { a: 100, b: 50, c: 40 });
  assert.deepEqual(f.map((s) => s.ofFirst), [1, 0.5, 0.4]);
  assert.deepEqual(f.map((s) => s.ofPrev), [1, 0.5, 0.8]);
});

test("level rows compare the win rate with the expected one", () => {
  const rows = levelRows([
    { id: "1", startedUsers: 100, wins: 60, losses: 40, expectedWin: 0.7 },
    { id: "2", startedUsers: 80, wins: 0, losses: 0, expectedWin: null },
  ]);
  assert.equal(rows[0].winRate, 0.6);
  assert.ok(Math.abs(rows[0].gap - -0.1) < 1e-9);
  assert.equal(rows[0].continueRate, 0.8);
  assert.equal(rows[1].winRate, null);
});
