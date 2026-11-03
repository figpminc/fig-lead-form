// One-page-or-more PDF invoice from FIG Maintenance, no dependencies.
// Port of .claude/skills/owner-service-billing/scripts/make_invoices.py (same layout).

const FROM = ["FIG Maintenance", "1719 N Central St", "Knoxville, TN 37917", "accounting@figpminc.com"];
const W = 612, H = 792, M = 54; // US Letter, points

const latin1 = s => String(s).replace(/[^\x00-\xff]/g, "?");
const esc = s => latin1(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const money = v => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Helvetica average glyph width is about 0.5 em; good enough for layout.
const textWidth = (s, size) => String(s).length * size * 0.5;

function wrap(s, size, width) {
  const lines = [];
  let cur = "";
  for (const w of String(s).split(/\s+/).filter(Boolean)) {
    const trial = (cur + " " + w).trim();
    if (textWidth(trial, size) > width && cur) { lines.push(cur); cur = w; } else cur = trial;
  }
  return cur ? [...lines, cur] : lines;
}

class Page {
  constructor() { this.ops = []; }
  text(x, y, s, size = 10, bold = false, right = false) {
    if (right) x -= textWidth(s, size);
    this.ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${esc(s)}) Tj ET`);
  }
  line(x1, y1, x2, y2, w = 0.6) { this.ops.push(`${w.toFixed(1)} w ${x1.toFixed(1)} ${y1.toFixed(1)} m ${x2.toFixed(1)} ${y2.toFixed(1)} l S`); }
  fill(x, y, w, h, gray = 0.93) { this.ops.push(`${gray.toFixed(2)} g ${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f 0 g`); }
}

function pdfBytes(pages) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"];
  const kids = [];
  for (const p of pages) {
    const stream = p.ops.join("\n");
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const content = objs.length;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${content} 0 R >>`);
    kids.push(objs.length);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is latin-1, so one char = one byte.
  return Buffer.from(out, "latin1");
}

function invoicePdf({ number, date, period, property, address, owner, jobs }) {
  const pages = [];
  let p = new Page();
  const cols = [M, M + 64, M + 170, M + 290]; // date, unit/issue, service, detail; amount right-aligned
  const right = W - M;

  const header = (pg, first) => {
    pg.text(M, H - M - 6, "INVOICE", 22, true);
    pg.text(right, H - M - 2, "Invoice # " + number, 11, true, true);
    pg.text(right, H - M - 16, "Date: " + date, 10, false, true);
    pg.text(right, H - M - 30, "Service period: " + period, 10, false, true);
    let y = H - M - 60;
    if (first) {
      pg.text(M, y, "From", 9, true);
      pg.text(M + 260, y, "Bill to (property)", 9, true);
      FROM.forEach((s, i) => pg.text(M, y - 14 - 13 * i, s, 10));
      const to = [property, ...(address && address !== property ? [address] : []), ...(owner ? ["Owner: " + owner] : [])];
      to.forEach((s, i) => pg.text(M + 260, y - 14 - 13 * i, s, 10));
      y -= 14 + 13 * Math.max(FROM.length, to.length) + 18;
    }
    pg.fill(M, y - 6, right - M, 20);
    ["Date", "Unit / Issue", "Service", "Detail"].forEach((h, i) => pg.text(cols[i] + 4, y, h, 9, true));
    pg.text(right - 10, y, "Amount", 9, true, true);
    return y - 22;
  };

  let y = header(p, true);
  for (const j of jobs) {
    const issue = j.issue ? "Issue " + j.issue : "";
    const detail = wrap(j.detail || "", 9, right - cols[3] - 80);
    const svc = wrap(j.service || "", 9, cols[3] - cols[2] - 8);
    const ui = wrap([j.unit || "", issue].filter(Boolean).join(" / "), 9, cols[2] - cols[1] - 8);
    const rows = Math.max(detail.length, svc.length, ui.length, 1);
    if (y - rows * 12 < M + 80) { pages.push(p); p = new Page(); y = header(p, false); }
    p.text(cols[0] + 4, y, j.workDate || "", 9);
    ui.forEach((s, i) => p.text(cols[1] + 4, y - 12 * i, s, 9));
    svc.forEach((s, i) => p.text(cols[2] + 4, y - 12 * i, s, 9));
    detail.forEach((s, i) => p.text(cols[3] + 4, y - 12 * i, s, 9));
    p.text(right - 6, y, money(j.amount), 9, false, true);
    y -= 12 * (rows - 1) + 7;
    p.line(M, y, right, y, 0.3);
    y -= 15;
  }
  const total = jobs.reduce((s, j) => s + j.amount, 0);
  y -= 4;
  p.text(right - 130, y, "Total due", 11, true);
  p.text(right - 6, y, money(total), 11, true, true);
  y -= 34;
  p.text(M, y, "Rates: lock change $50 per deadbolt, $10 per passage knob; ozone placement $200; dehumidifier placement $200.", 8);
  p.text(M, y - 12, "Questions: (865) 296-0358.", 8);
  pages.push(p);
  return { bytes: pdfBytes(pages), total };
}

module.exports = { invoicePdf, money };
