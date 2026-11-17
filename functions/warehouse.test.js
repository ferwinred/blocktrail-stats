const test = require("node:test");
const assert = require("node:assert");
const { buildAggregates, sql } = require("./warehouse");

test("waits while the Analytics export is not linked", async () => {
  const client = { dataset: () => ({ exists: async () => [false] }) };
  const out = await buildAggregates("123", { client });
  assert.match(out.waiting, /analytics_123/);
});

test("builds the three tables from the export, without testers", async () => {
  const queries = [];
  const client = {
    dataset: () => ({ exists: async () => [true], getMetadata: async () => [{ location: "US" }] }),
    createDataset: async () => {},
    query: async ({ query }) => { queries.push(query); return [[]]; },
  };
  const out = await buildAggregates("123", { client });
  assert.deepStrictEqual(out.done, ["dailyKpis", "retention", "levels"]);
  for (const q of queries) {
    assert.match(q, /analytics_123\.events_\*/);
    assert.match(q, /tester/);
  }
  assert.match(sql.levels("x"), /expected_win/);
});
