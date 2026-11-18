import test from "node:test";
import assert from "node:assert/strict";
import { cellValue, compare, toCsv, csvName } from "../docs/table.js";

test("cellValue reads the numbers as the page writes them", () => {
  assert.equal(cellValue("1.234"), 1234);
  assert.equal(cellValue("12,3 %"), 12.3);
  assert.equal(cellValue("12,3 %*"), 12.3);
  assert.equal(cellValue("US$ 0,125"), 0.125);
  assert.equal(cellValue("−4,0 pts"), -4);
  assert.equal(cellValue("+4,0 pts"), 4);
  assert.equal(cellValue("1,25×"), 1.25);
  assert.equal(cellValue("—"), null);
  assert.equal(cellValue(""), null);
  assert.equal(cellValue("1.0.4"), "1.0.4");
  assert.equal(cellValue("Colombia"), "Colombia");
});

test("compare puts empty cells last in both directions", () => {
  const vals = [3, null, 10, "b", "a"];
  assert.deepEqual([...vals].sort((a, b) => compare(a, b, 1)), [3, 10, "a", "b", null]);
  assert.deepEqual([...vals].sort((a, b) => compare(a, b, -1)), [10, 3, "b", "a", null]);
  assert.ok(compare("nivel 2", "nivel 10") < 0);
});

test("toCsv quotes what a spreadsheet would split", () => {
  const csv = toCsv(["País", "Valor"], [["Corea; Sur", "1,5"], ['Di "hola"', null]]);
  assert.equal(csv, '\ufeffPaís;Valor\r\n"Corea; Sur";1,5\r\n"Di ""hola""";\r\n');
});

test("csvName makes a plain file name with the date", () => {
  assert.equal(csvName("Retención por semana", new Date(2026, 10, 18)), "retencion-por-semana-2026-11-18.csv");
});
