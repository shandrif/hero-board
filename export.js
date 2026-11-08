// Hero Board — polished Excel compliance report (ExcelJS, loaded on demand)
// buildWeekReport(ctx) → downloads "Hero Board - <week>.xlsx"
//   ctx = { week, rows, trend, staff, products, scope, stores }
//   rows: weekRows() for the week, already filtered to the dashboard's area scope

const XL = {
  ink: "FF111111", ink2: "FF3D3833", muted: "FF6E655B", line: "FFE4D7C5", bg: "FFF8F3EC", white: "FFFFFFFF",
  tan: "FFD4B38B", tanD: "FFA9875F", tanSoft: "FFEFE2D0",
  teal: "FF84C6B2", tealD: "FF2F8A72", tealSoft: "FFDDF0EA",
  red: "FFC2412D", redSoft: "FFF8E1DB", amber: "FFA8691C", amberSoft: "FFF7E6CC",
};
const XL_FONT = "Calibri";

function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";
    s.onload = () => window.ExcelJS ? res(window.ExcelJS) : rej(new Error("Could not load the Excel library"));
    s.onerror = () => rej(new Error("Could not load the Excel library. Check your internet connection."));
    document.head.appendChild(s);
  });
}

// Excel has no time zones: shift so the cell shows Riyadh time (UTC+3, no DST)
const xlDate = v => v ? new Date(new Date(v).getTime() + 3 * 36e5) : null;
const xlDay = v => v ? new Date(v + "T00:00:00Z") : null;
const ratio = (a, b) => b > 0 ? a / b : null;
const tc = s => !s ? "" : /[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

// ---------- metrics ----------
function storeCompliance(r) {
  if (r.status === "Pending") return "Non-compliant";
  return r.total > 0 && r.staffN >= r.total ? "Compliant" : "Partial";
}
function summarize(rows) {
  const n = rows.length, acked = rows.filter(r => r.status !== "Pending"), onTime = rows.filter(r => r.status === "On time");
  const withTotal = rows.filter(r => r.total > 0);
  const staffAware = withTotal.reduce((a, r) => a + Math.min(r.staffN, r.total), 0), staffTotal = withTotal.reduce((a, r) => a + r.total, 0);
  const compliant = rows.filter(r => storeCompliance(r) === "Compliant").length;
  const ackRate = ratio(acked.length, n), staffRate = ratio(staffAware, staffTotal);
  const ackHours = acked.map(r => r.hours).filter(h => h != null).sort((a, b) => a - b);
  return {
    n, acked: acked.length, onTime: onTime.length, late: acked.length - onTime.length, pending: n - acked.length,
    staffAware, staffTotal, signoffs: rows.reduce((a, r) => a + r.staffN, 0), noCount: n - withTotal.length,
    compliant, partial: acked.length - compliant,
    ackRate, onTimeRate: ratio(onTime.length, n), staffRate,
    compliantRate: ratio(compliant, n),
    score: n ? ((ackRate || 0) * 0.5 + (staffRate || 0) * 0.5) : null,
    medianHours: ackHours.length ? ackHours[Math.floor((ackHours.length - 1) / 2)] : null,
  };
}
function groupBy(rows, key) {
  const m = new Map();
  rows.forEach(r => { const k = r[key] || ""; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  return [...m.entries()].map(([k, rr]) => ({ key: k, rows: rr, ...summarize(rr) }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.n - a.n || a.key.localeCompare(b.key));
}

// ---------- styling helpers ----------
const fill = argb => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const thin = argb => ({ style: "thin", color: { argb } });
const boxBorder = argb => ({ top: thin(argb), left: thin(argb), bottom: thin(argb), right: thin(argb) });
function setCell(ws, addr, value, style = {}) {
  const c = ws.getCell(addr); c.value = value;
  c.font = { name: XL_FONT, size: 11, color: { argb: XL.ink }, ...(style.font || {}) };
  if (style.fill) c.fill = fill(style.fill);
  if (style.numFmt) c.numFmt = style.numFmt;
  c.alignment = { vertical: "middle", ...(style.align || {}) };
  if (style.border) c.border = style.border;
  return c;
}
function banner(ws, lastCol, title, subtitle) {
  ws.mergeCells(1, 1, 1, lastCol); ws.mergeCells(2, 1, 2, lastCol);
  setCell(ws, "A1", title, { font: { size: 18, bold: true, color: { argb: XL.white } }, fill: XL.ink, align: { indent: 1 } });
  setCell(ws, "A2", subtitle, { font: { size: 10, color: { argb: XL.tan } }, fill: XL.ink, align: { indent: 1 } });
  for (let c = 1; c <= lastCol; c++) { ws.getCell(1, c).fill = fill(XL.ink); ws.getCell(2, c).fill = fill(XL.ink); }
  ws.getRow(1).height = 34; ws.getRow(2).height = 20; ws.getRow(3).height = 10;
}
function sectionTitle(ws, row, col, lastCol, text, note) {
  ws.mergeCells(row, col, row, lastCol);
  setCell(ws, ws.getCell(row, col).address, note ? { richText: [{ text, font: { name: XL_FONT, bold: true, size: 13, color: { argb: XL.ink } } }, { text: "   " + note, font: { name: XL_FONT, size: 10, color: { argb: XL.muted } } }] } : text,
    { font: { bold: true, size: 13 } });
  for (let c = col; c <= lastCol; c++) ws.getCell(row, c).border = { bottom: { style: "medium", color: { argb: XL.tan } } };
  ws.getRow(row).height = 22;
}
// Writes a styled table. cols: [{ h, key|get, w?, fmt?, align?, bar?: argb, scale?: true, status?: true }]
function table(ws, top, left, cols, data, opts = {}) {
  cols.forEach((c, i) => {
    setCell(ws, ws.getCell(top, left + i).address, c.h, {
      font: { bold: true, size: 10, color: { argb: XL.white } }, fill: XL.ink2,
      align: { horizontal: c.align || (c.fmt ? "center" : "left"), wrapText: true }, border: boxBorder(XL.ink2),
    });
  });
  ws.getRow(top).height = opts.headH || 30;
  data.forEach((d, ri) => {
    const r = top + 1 + ri, zebra = ri % 2 ? XL.bg : XL.white;
    cols.forEach((c, i) => {
      const v = c.get ? c.get(d) : d[c.key];
      const st = c.status ? statusStyle(v) : null;
      setCell(ws, ws.getCell(r, left + i).address, v ?? (c.fmt ? null : ""), {
        fill: st ? st.fill : (opts.totalRow && ri === data.length - 1 ? XL.tanSoft : zebra),
        font: { size: 10, bold: (opts.totalRow && ri === data.length - 1) || c.bold || !!st, color: { argb: st ? st.color : XL.ink } },
        numFmt: c.fmt, align: { horizontal: c.align || (c.fmt || st ? "center" : "left"), wrapText: !!c.wrap },
        border: { bottom: thin(XL.line) },
      });
    });
  });
  const bottom = top + Math.max(1, data.length);
  const lastData = opts.totalRow ? bottom - 1 : bottom;
  cols.forEach((c, i) => {
    if (!data.length || lastData <= top) return;
    const col = ws.getColumn(left + i).letter, ref = `${col}${top + 1}:${col}${lastData}`;
    if (c.bar) ws.addConditionalFormatting({ ref, rules: [{ type: "dataBar", minLength: 0, maxLength: 100, gradient: false, cfvo: [{ type: "num", value: 0 }, { type: "num", value: 1 }], color: { argb: c.bar } }] });
    if (c.scale) ws.addConditionalFormatting({ ref, rules: [{ type: "colorScale", cfvo: [{ type: "num", value: 0 }, { type: "num", value: 0.5 }, { type: "num", value: 1 }], color: [{ argb: "FFF4C7BD" }, { argb: "FFF7E6CC" }, { argb: "FFBFE5D7" }] }] });
  });
  return bottom;
}
function statusStyle(v) {
  return {
    "Compliant": { fill: XL.tealSoft, color: XL.tealD }, "On time": { fill: XL.tealSoft, color: XL.tealD }, "Yes": { fill: XL.tealSoft, color: XL.tealD },
    "Partial": { fill: XL.amberSoft, color: XL.amber }, "Late": { fill: XL.amberSoft, color: XL.amber }, "Staff incomplete": { fill: XL.amberSoft, color: XL.amber }, "Staff count not set": { fill: XL.amberSoft, color: XL.amber },
    "Good": { fill: XL.tealSoft, color: XL.tealD }, "Needs attention": { fill: XL.amberSoft, color: XL.amber }, "At risk": { fill: XL.redSoft, color: XL.red },
    "Non-compliant": { fill: XL.redSoft, color: XL.red }, "Not acknowledged": { fill: XL.redSoft, color: XL.red }, "No": { fill: XL.redSoft, color: XL.red },
  }[v] || null;
}
function kpiTile(ws, row, col, label, value, sub, color, fmt) {
  ws.mergeCells(row, col, row, col + 1); ws.mergeCells(row + 1, col, row + 1, col + 1); ws.mergeCells(row + 2, col, row + 2, col + 1);
  const edge = { left: { style: "thick", color: { argb: color } } };
  setCell(ws, ws.getCell(row, col).address, label, { font: { size: 9, bold: true, color: { argb: XL.muted } }, fill: XL.white, align: { indent: 1 }, border: edge });
  setCell(ws, ws.getCell(row + 1, col).address, value, { font: { size: 24, bold: true, color: { argb: color } }, fill: XL.white, numFmt: fmt, align: { indent: 1, horizontal: "left" }, border: edge });
  setCell(ws, ws.getCell(row + 2, col).address, sub, { font: { size: 9, color: { argb: XL.muted } }, fill: XL.white, align: { indent: 1, wrapText: true }, border: edge });
  [row, row + 1, row + 2].forEach(r => { ws.getCell(r, col + 1).fill = fill(XL.white); ws.getCell(r, col).border = edge; });
}
const PCT = "0%", INT = "#,##0", HRS = '0.0" h"', DT = "dd mmm yyyy, hh:mm AM/PM", DAY = "dd mmm yyyy";

// ---------- report ----------
async function buildWeekReport(ctx) {
  const ExcelJS = await loadExcelJS();
  const { week: w, rows, scope } = ctx;
  const S0 = summarize(rows);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Hero Board"; wb.created = new Date(); wb.title = `Hero Board – ${w.title}`;
  const sub = `${fmtDate(w.start_date)} – ${fmtDate(w.end_date)}   ·   Published ${fmtDateTime(w.published_at)}   ·   Scope: ${scope}   ·   Generated ${fmtDateTime(new Date().toISOString())}`;
  const print = { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  const sheetOpts = c => ({ views: [{ showGridLines: false, state: "frozen", ySplit: c }], properties: { tabColor: { argb: XL.tan } }, pageSetup: { ...print, printTitlesRow: `${c}:${c}` } });

  // ===== 1. Dashboard =====
  const d = wb.addWorksheet("Dashboard", { views: [{ showGridLines: false }], properties: { tabColor: { argb: XL.ink } }, pageSetup: print });
  d.columns = [5, 24, 20, 12, 13, 12, 12, 13, 14, 12, 12, 16].map(width => ({ width }));
  banner(d, 12, `Hero Board · ${w.title} · Compliance Report`, sub);
  const sc = v => v == null ? XL.muted : v >= 0.85 ? XL.tealD : v >= 0.6 ? XL.amber : XL.red;
  kpiTile(d, 4, 1, "COMPLIANCE SCORE", S0.score, "50% store acknowledgement + 50% staff coverage", sc(S0.score), PCT);
  kpiTile(d, 4, 3, "STORES ACKNOWLEDGED", S0.ackRate, `${S0.acked} of ${S0.n} stores`, XL.tealD, PCT);
  kpiTile(d, 4, 5, "ON TIME (≤ 24 H)", S0.onTimeRate, `${S0.onTime} on time · ${S0.late} late`, S0.onTimeRate >= 0.85 ? XL.tealD : XL.amber, PCT);
  kpiTile(d, 4, 7, "NOT ACKNOWLEDGED", S0.pending, S0.pending ? "stores still pending" : "every store acknowledged", S0.pending ? XL.red : XL.tealD, INT);
  kpiTile(d, 4, 9, "STAFF COVERAGE", S0.staffRate, S0.staffTotal ? `${S0.staffAware} of ${S0.staffTotal} staff aware` : "no store has set a staff count", XL.tanD, PCT);
  kpiTile(d, 4, 11, "FULLY COMPLIANT STORES", S0.compliant, `of ${S0.n} · acknowledged + all staff aware`, XL.ink, INT);
  d.getRow(4).height = 18; d.getRow(5).height = 36; d.getRow(6).height = 28;

  // Status mix + quick facts
  let r = 8;
  sectionTitle(d, r, 2, 6, "Store status");
  table(d, r + 1, 2, [
    { h: "Status", key: "s", status: true, align: "left" }, { h: "Stores", key: "n", fmt: INT }, { h: "Share", key: "p", fmt: PCT, bar: XL.tan },
    { h: "What it means", key: "m", wrap: true },
  ], [
    { s: "Compliant", n: S0.compliant, p: ratio(S0.compliant, S0.n), m: "Acknowledged and every staff member aware" },
    { s: "Partial", n: S0.partial, p: ratio(S0.partial, S0.n), m: "Acknowledged, staff not complete or count not set" },
    { s: "Non-compliant", n: S0.pending, p: ratio(S0.pending, S0.n), m: "Manager has not acknowledged" },
  ]);
  for (let i = 1; i <= 4; i++) d.mergeCells(r + i, 5, r + i, 6);
  [r + 2, r + 3, r + 4].forEach(x => d.getRow(x).height = 28);

  sectionTitle(d, r, 8, 12, "Quick facts");
  const facts = [
    ["Stores in scope", S0.n, INT], ["Median time to acknowledge", S0.medianHours, HRS],
    ["Total staff sign-offs", S0.signoffs, INT], ["Stores without a staff count", S0.noCount, INT],
  ];
  facts.forEach(([k, v, f], i) => {
    const rr = r + 1 + i; d.mergeCells(rr, 8, rr, 11);
    setCell(d, d.getCell(rr, 8).address, k, { font: { size: 10, color: { argb: XL.ink2 } }, fill: i % 2 ? XL.bg : XL.white, border: { bottom: thin(XL.line) }, align: { indent: 1 } });
    setCell(d, d.getCell(rr, 12).address, v ?? "—", { font: { size: 11, bold: true }, numFmt: f, fill: i % 2 ? XL.bg : XL.white, border: { bottom: thin(XL.line) }, align: { horizontal: "right", indent: 1 } });
  });

  // Weekly trend
  r = 15;
  sectionTitle(d, r, 2, 12, "Weekly trend", "last published weeks, same scope");
  const trendRows = ctx.trend.map(t => ({ week: t.week.title, start: xlDay(t.week.start_date), ...summarize(t.rows) }));
  let end = table(d, r + 1, 2, [
    { h: "Week", key: "week", bold: true }, { h: "Starts", key: "start", fmt: DAY }, { h: "Stores", key: "n", fmt: INT },
    { h: "Acknowledged", key: "ackRate", fmt: PCT, bar: XL.teal }, { h: "On time", key: "onTimeRate", fmt: PCT, bar: XL.teal },
    { h: "Staff coverage", key: "staffRate", fmt: PCT, bar: XL.tan }, { h: "Compliant stores", key: "compliant", fmt: INT },
    { h: "Score", key: "score", fmt: PCT, scale: true },
  ], trendRows);
  for (let x = r + 1; x <= end; x++) { d.mergeCells(x, 10, x, 12); }
  setCell(d, d.getCell(r + 1, 10).address, "Trend", { font: { bold: true, size: 10, color: { argb: XL.white } }, fill: XL.ink2, border: boxBorder(XL.ink2) });
  trendRows.forEach((t, i) => {
    const prev = trendRows[i - 1]; const delta = prev && t.score != null && prev.score != null ? t.score - prev.score : null;
    setCell(d, d.getCell(r + 2 + i, 10).address, delta == null ? "—" : `${delta >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(delta * 100))} pts vs previous week`,
      { font: { size: 10, bold: delta != null, color: { argb: delta == null ? XL.muted : delta >= 0 ? XL.tealD : XL.red } }, fill: i % 2 ? XL.bg : XL.white, border: { bottom: thin(XL.line) } });
  });

  // Area manager leaderboard
  r = end + 2;
  const byAm = groupBy(rows, "area_manager");
  sectionTitle(d, r, 1, 12, "Area manager scorecard", "sorted by compliance score");
  end = table(d, r + 1, 1, [
    { h: "#", get: x => x._rank, fmt: INT }, { h: "Area manager", get: x => x.key ? tc(x.key) : "Not set", bold: true },
    { h: "ROM", get: x => tc([...new Set(x.rows.map(y => y.rom).filter(Boolean))].join(", ")) },
    { h: "Stores", key: "n", fmt: INT }, { h: "Acknowledged", key: "ackRate", fmt: PCT, bar: XL.teal }, { h: "On time", key: "onTimeRate", fmt: PCT },
    { h: "Pending", key: "pending", fmt: INT }, { h: "Staff aware", get: x => x.staffTotal ? `${x.staffAware} / ${x.staffTotal}` : "—", align: "center" },
    { h: "Staff coverage", key: "staffRate", fmt: PCT, bar: XL.tan }, { h: "Compliant", key: "compliant", fmt: INT },
    { h: "Score", key: "score", fmt: PCT, scale: true }, { h: "Rating", get: x => rating(x.score), status: true },
  ], byAm.map((x, i) => ({ ...x, _rank: i + 1 })));

  // Definitions
  r = end + 2;
  sectionTitle(d, r, 1, 12, "How the numbers are calculated");
  [
    ["Acknowledged", "The store manager tapped “I acknowledge” for this week."],
    ["On time", "Acknowledged within 24 hours of the week being published."],
    ["Staff coverage", "Staff who tapped “I'm aware”, divided by each store's total staff (stores without a staff count are left out)."],
    ["Compliant store", "Acknowledged, and every staff member is aware."],
    ["Compliance score", "50% store acknowledgement rate + 50% staff coverage rate."],
    ["Rating", "Good ≥ 85% · Needs attention 60–84% · At risk < 60%."],
  ].forEach(([k, v], i) => {
    const rr = r + 1 + i; d.mergeCells(rr, 1, rr, 2); d.mergeCells(rr, 3, rr, 12);
    setCell(d, d.getCell(rr, 1).address, k, { font: { size: 10, bold: true }, align: { indent: 1 } });
    setCell(d, d.getCell(rr, 3).address, v, { font: { size: 10, color: { argb: XL.ink2 } } });
  });

  // ===== 2. By Manager =====
  const m = wb.addWorksheet("By Manager", sheetOpts(3));
  const groupCols = (label) => [
    { h: "#", get: x => x._rank, fmt: INT, w: 5 }, { h: label, get: x => x.key ? tc(x.key) : "Not set", bold: true, w: 24 },
    { h: "Stores", key: "n", fmt: INT, w: 9 }, { h: "Acknowledged", key: "acked", fmt: INT, w: 13 }, { h: "Ack %", key: "ackRate", fmt: PCT, bar: XL.teal, w: 11 },
    { h: "On time", key: "onTime", fmt: INT, w: 9 }, { h: "Late", key: "late", fmt: INT, w: 8 }, { h: "Pending", key: "pending", fmt: INT, w: 9 },
    { h: "Staff aware", key: "staffAware", fmt: INT, w: 11 }, { h: "Staff total", key: "staffTotal", fmt: INT, w: 11 }, { h: "Staff %", key: "staffRate", fmt: PCT, bar: XL.tan, w: 11 },
    { h: "Compliant", key: "compliant", fmt: INT, w: 11 }, { h: "Score", key: "score", fmt: PCT, scale: true, w: 10 }, { h: "Rating", get: x => rating(x.score), status: true, w: 16 },
  ];
  const withTotal = (list) => [...list.map((x, i) => ({ ...x, _rank: i + 1 })), { key: "Total", _rank: null, ...S0 }];
  const gc = groupCols("Area manager"); m.columns = gc.map(c => ({ width: c.w }));
  banner(m, gc.length, `${w.title} · Performance by area manager and ROM`, sub);
  sectionTitle(m, 4, 1, gc.length, "By area manager");
  end = table(m, 5, 1, gc, withTotal(byAm), { totalRow: true });
  sectionTitle(m, end + 2, 1, gc.length, "By ROM");
  table(m, end + 3, 1, groupCols("ROM"), withTotal(groupBy(rows, "rom")), { totalRow: true });

  // ===== 3. By Location =====
  const l = wb.addWorksheet("By Location", sheetOpts(3));
  l.columns = gc.map(c => ({ width: c.w }));
  banner(l, gc.length, `${w.title} · Performance by region and city`, sub);
  sectionTitle(l, 4, 1, gc.length, "By region");
  end = table(l, 5, 1, groupCols("Region"), withTotal(groupBy(rows, "region")), { totalRow: true });
  sectionTitle(l, end + 2, 1, gc.length, "By city");
  table(l, end + 3, 1, groupCols("City"), withTotal(groupBy(rows, "city")), { totalRow: true });

  // ===== 4. Stores =====
  const st = wb.addWorksheet("Stores", sheetOpts(4));
  const storeCols = [
    { h: "Store ID", key: "code", w: 10 }, { h: "Store", key: "name", bold: true, w: 34 }, { h: "Branch", key: "branch_code", w: 9 },
    { h: "Area manager", get: x => tc(x.area_manager), w: 20 }, { h: "ROM", get: x => tc(x.rom), w: 18 }, { h: "Region", key: "region", w: 16 }, { h: "City", key: "city", w: 14 },
    { h: "Compliance", get: storeCompliance, status: true, w: 15 }, { h: "Manager", get: x => x.status === "Pending" ? "Not acknowledged" : x.status, status: true, w: 17 },
    { h: "Acknowledged at", get: x => xlDate(x.ack), fmt: DT, w: 22 }, { h: "Hours after publish", get: x => x.hours == null ? null : Math.round(x.hours * 10) / 10, fmt: '0.0', w: 11 },
    { h: "Staff aware", key: "staffN", fmt: INT, w: 10 }, { h: "Total staff", get: x => x.total || null, fmt: INT, w: 10 },
    { h: "Staff %", get: x => x.total ? Math.min(1, x.staffN / x.total) : null, fmt: PCT, bar: XL.tan, w: 11 },
    { h: "Action needed", get: actionFor, w: 46 },
  ];
  st.columns = storeCols.map(c => ({ width: c.w }));
  banner(st, storeCols.length, `${w.title} · Store detail`, sub);
  const sorted = [...rows].sort((a, b) => ({ "Non-compliant": 0, "Partial": 1, "Compliant": 2 })[storeCompliance(a)] - ({ "Non-compliant": 0, "Partial": 1, "Compliant": 2 })[storeCompliance(b)] || (a.area_manager || "~").localeCompare(b.area_manager || "~") || a.code.localeCompare(b.code));
  end = table(st, 4, 1, storeCols, sorted);
  st.autoFilter = { from: { row: 4, column: 1 }, to: { row: end, column: storeCols.length } };

  // ===== 5. Follow-up =====
  const f = wb.addWorksheet("Follow-up", { ...sheetOpts(4), properties: { tabColor: { argb: XL.red } } });
  const follow = rows.filter(x => storeCompliance(x) !== "Compliant").map(x => ({ ...x, issue: x.status === "Pending" ? "Not acknowledged" : !x.total ? "Staff count not set" : "Staff incomplete" }))
    .sort((a, b) => (a.area_manager || "~").localeCompare(b.area_manager || "~") || ["Not acknowledged", "Staff incomplete", "Staff count not set"].indexOf(a.issue) - ["Not acknowledged", "Staff incomplete", "Staff count not set"].indexOf(b.issue) || a.code.localeCompare(b.code));
  const fCols = [
    { h: "Area manager", get: x => tc(x.area_manager) || "Not set", bold: true, w: 22 }, { h: "ROM", get: x => tc(x.rom), w: 18 },
    { h: "Store ID", key: "code", w: 10 }, { h: "Store", key: "name", w: 34 }, { h: "City", key: "city", w: 14 },
    { h: "Issue", key: "issue", status: true, w: 20 }, { h: "Staff", get: x => x.total ? `${x.staffN} / ${x.total}` : x.staffN ? String(x.staffN) : "—", align: "center", w: 10 },
    { h: "Missing staff", get: x => x.total ? Math.max(0, x.total - x.staffN) : null, fmt: INT, w: 11 },
    { h: "Action needed", get: actionFor, w: 46 },
  ];
  f.columns = fCols.map(c => ({ width: c.w }));
  banner(f, fCols.length, `${w.title} · Follow-up list (${follow.length} store${follow.length === 1 ? "" : "s"})`, sub);
  end = table(f, 4, 1, fCols, follow.length ? follow : [{ name: "All stores are compliant 🎉" }]);
  if (follow.length) f.autoFilter = { from: { row: 4, column: 1 }, to: { row: end, column: fCols.length } };

  // ===== 6. Staff =====
  const s = wb.addWorksheet("Staff", sheetOpts(4));
  const byId = new Map(rows.map(x => [x.id, x]));
  const pub = new Date(w.published_at);
  const staff = ctx.staff.filter(x => byId.has(x.store_id)).map(x => ({ ...x, st: byId.get(x.store_id) }));
  const sCols = [
    { h: "#", get: x => x._i, fmt: INT, w: 6 }, { h: "Employee name", key: "staff_name", bold: true, w: 28 }, { h: "Employee ID", key: "employee_id", w: 14 },
    { h: "Store ID", get: x => x.st.code, w: 10 }, { h: "Store", get: x => x.st.name, w: 32 }, { h: "Area manager", get: x => tc(x.st.area_manager), w: 20 },
    { h: "ROM", get: x => tc(x.st.rom), w: 18 }, { h: "Region", get: x => x.st.region, w: 16 }, { h: "City", get: x => x.st.city, w: 14 },
    { h: "Acknowledged at", get: x => xlDate(x.acked_at), fmt: DT, w: 22 }, { h: "Hours after publish", get: x => Math.round((new Date(x.acked_at) - pub) / 36e5 * 10) / 10, fmt: "0.0", w: 11 },
  ];
  s.columns = sCols.map(c => ({ width: c.w }));
  banner(s, sCols.length, `${w.title} · Staff acknowledgements (${staff.length})`, sub);
  end = table(s, 4, 1, sCols, staff.length ? staff.map((x, i) => ({ ...x, _i: i + 1 })) : [{ st: {}, staff_name: "No staff acknowledgements yet" }]);
  if (staff.length) s.autoFilter = { from: { row: 4, column: 1 }, to: { row: end, column: sCols.length } };

  // ===== 7. Heroes =====
  const h = wb.addWorksheet("Heroes", sheetOpts(4));
  const hCols = [
    { h: "Daypart", get: x => x.slot ? slotLabel(x.slot).split(" · ")[0] : "—", bold: true, w: 12 }, { h: "Type", get: x => x.slot ? slotInfo(x.slot)[2] : "Hero product", w: 14 },
    { h: "Product", key: "name", bold: true, w: 30 }, { h: "Price (SAR)", key: "price", fmt: "#,##0.00", w: 12 }, { h: "Description", key: "description", wrap: true, w: 52 },
    { h: "Photo", get: x => x.photo_url ? { text: "View photo", hyperlink: x.photo_url } : "No photo", w: 12 },
  ];
  h.columns = hCols.map(c => ({ width: c.w }));
  banner(h, hCols.length, `${w.title} · Hero products`, sub);
  table(h, 4, 1, hCols, ctx.products.length ? ctx.products : [{ name: "No products" }]);
  ctx.products.forEach((p, i) => { if (p.photo_url) h.getCell(5 + i, 6).font = { name: XL_FONT, size: 10, color: { argb: XL.tealD }, underline: true }; });

  // ---- download ----
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `Hero Board - ${w.title}${ctx.scopeShort ? " - " + ctx.scopeShort : ""}.xlsx`.replace(/[\\/:*?"<>|]/g, "");
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function rating(v) { return v == null ? "" : v >= 0.85 ? "Good" : v >= 0.6 ? "Needs attention" : "At risk"; }
function actionFor(r) {
  if (r.status === "Pending") return "Acknowledge in Hero Board, then share the staff link";
  if (!r.total) return "Set the store's total staff count";
  if (r.staffN < r.total) return `${r.total - r.staffN} staff still to tap “I'm aware”`;
  return "";
}
