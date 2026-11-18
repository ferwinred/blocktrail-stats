const test = require("node:test");
const assert = require("node:assert");
const { parseCsv } = require("./sources");

test("reads a Play Console report", () => {
  const rows = parseCsv("Date,Package Name,Daily User Installs,Daily Crashes\r\n2026-11-10,com.ferwin.blockquest,4,1\r\n\r\n");
  assert.deepStrictEqual(rows, [{ Date: "2026-11-10", "Package Name": "com.ferwin.blockquest", "Daily User Installs": "4", "Daily Crashes": "1" }]);
});

test("reads a quoted Unity CSV", () => {
  const rows = parseCsv('"timestamp","revenue_sum"\n"2026-11-10T00:00:00.000Z","0.12"\n');
  assert.strictEqual(rows[0].revenue_sum, "0.12");
  assert.strictEqual(rows[0].timestamp.slice(0, 10), "2026-11-10");
});

test("an empty report has no rows", () => {
  assert.deepStrictEqual(parseCsv(""), []);
});

test("parseCsv keeps a quoted comma inside its field", () => {
  const rows = parseCsv('Date,Country,Installs\r\n2026-11-10,"Korea, Republic of",3\r\n2026-11-11,"Say ""hi""",4\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Country, "Korea, Republic of");
  assert.equal(rows[0].Installs, "3");
  assert.equal(rows[1].Country, 'Say "hi"');
});

test("admobAccount picks the account that owns the app", () => {
  const { admobAccount } = require("./sources");
  const accounts = [{ name: "accounts/pub-1", publisherId: "pub-1" }, { name: "accounts/pub-9104124048191994", publisherId: "pub-9104124048191994" }];
  assert.strictEqual(admobAccount(accounts, "ca-app-pub-9104124048191994~7609228329").publisherId, "pub-9104124048191994");
  assert.strictEqual(admobAccount([accounts[0]], "ca-app-pub-9~1").name, "accounts/pub-1");
  assert.throws(() => admobAccount(accounts, "ca-app-pub-7~1"));
});
