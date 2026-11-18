// Sortable tables and CSV export, shared by the stats page and the content
// panel (a copy lives in tools/admin-dashboard/shared/table.js). The pure part
// (reading a cell, comparing, writing CSV) runs in Node for the tests; the DOM
// part only in the browser.

/**
 * The value a shown cell sorts by: a number when the text is one as the page
 * writes them (es-CO: "1.234,5", "12,3 %", "US$ 0,12", "+4,0 pts", "1,25×"),
 * null for an empty or "—" cell, otherwise the text itself.
 */
export function cellValue(text) {
  const t = String(text ?? "").replace(/ /g, " ").trim();
  if (!t || t === "—" || t === "-") return null;
  const m = t.match(/^([+\-−]?)\s*(?:US\$|\$)?\s*(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?)\s*(%|pts|×|x|\*)?\s*\*?$/);
  if (!m) return t;
  const n = Number(m[2].replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n)) return t;
  return m[1] === "-" || m[1] === "−" ? -n : n;
}

/** Ascending or descending, numbers before text, empty cells always last. */
export function compare(a, b, dir = 1) {
  if (a == null || b == null) return a == null && b == null ? 0 : a == null ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * dir;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return String(a).localeCompare(String(b), "es", { numeric: true, sensitivity: "base" }) * dir;
}

/**
 * CSV the way a spreadsheet in Spanish opens it with a double click: ";"
 * between fields (the comma is the decimal mark), CRLF lines and a BOM so the
 * accents survive Excel.
 */
export function toCsv(header, rows) {
  const field = (v) => {
    const s = v == null ? "" : String(v);
    return /[";\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return "﻿" + [header, ...rows].map((r) => r.map(field).join(";")).join("\r\n") + "\r\n";
}

/** "Jugadores por día" -> "jugadores-por-dia-2026-11-18.csv". */
export function csvName(title, today = new Date()) {
  const slug = String(title).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tabla";
  const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return `${slug}-${d}.csv`;
}

/** Hands the browser a CSV file to save. */
export function downloadCsv(name, csv) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const textOf = (cell) => (cell.dataset.v != null ? cell.dataset.v : cell.textContent);

/**
 * Makes a static table sortable by any column (a button in each header, with
 * aria-sort) and adds «Exportar CSV» before it. Rows filled later keep the
 * chosen order.
 */
export function enhanceTable(table, title) {
  const head = [...table.tHead.rows[0].cells];
  const body = table.tBodies[0];
  let col = -1, dir = 1;
  // Re-sorts rows the page fills in later. Moving the rows is itself a change
  // the observer sees: those records are dropped, or it would sort forever.
  const watcher = new MutationObserver(() => apply());

  const apply = () => {
    if (col < 0) return;
    const rows = [...body.rows];
    const sorted = [...rows].sort((x, y) => compare(cellValue(textOf(x.cells[col] ?? x)), cellValue(textOf(y.cells[col] ?? y)), dir));
    if (sorted.every((r, i) => r === rows[i])) return;
    body.append(...sorted);
    watcher.takeRecords();
  };

  head.forEach((th, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "sort";
    b.append(...th.childNodes);
    th.append(b);
    b.onclick = () => {
      dir = col === i ? -dir : 1;
      col = i;
      head.forEach((h, j) => (j === i ? h.setAttribute("aria-sort", dir > 0 ? "ascending" : "descending") : h.removeAttribute("aria-sort")));
      apply();
    };
  });
  watcher.observe(body, { childList: true });

  const csv = document.createElement("button");
  csv.type = "button"; csv.className = "csv small-btn"; csv.textContent = "Exportar CSV";
  csv.onclick = () => downloadCsv(csvName(title), toCsv(head.map((h) => h.textContent.trim()),
    [...body.rows].map((r) => [...r.cells].map((c) => c.textContent.trim()))));
  (table.closest(".table-wrap") ?? table).before(csv);
}
