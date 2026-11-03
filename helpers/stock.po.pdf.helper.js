import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";

import { getLogger } from "./logger.helper.js";
import { datedSubdir, deleteStoredUpload } from "./stock.upload.path.helper.js";
import { PO_TAX_TYPE } from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);

/*
  Where PO PDFs are written. Same convention as product images: files live under
  the top-level "uploads" root (process.cwd()/uploads), which app.js serves
  statically at /uploads — not under public/.

  Each PDF goes under po/<YYYY>/<MM>/ of the PO's CREATION date, not today's:
  an edited PO regenerates its PDF, and keying on createdAt keeps that rewrite
  in the same folder instead of scattering copies across months.
*/
const UPLOADS_ROOT = process.cwd();
const PO_DIR_REL = "/uploads/stock/po";
const PO_DIR_ABS = path.join(UPLOADS_ROOT, "uploads", "stock", "po");

const PAYMENT_TERMS = [
  { label: "Immediate Payment", value: "IMMEDIATE" },
  { label: "Payment Within 30 Days", value: "NET_30" },
  { label: "Payment Within 60 Days", value: "NET_60" },
  { label: "Payment Within 90 Days", value: "NET_90" },
];

// Lookup map
const PAYMENT_TERMS_MAP = PAYMENT_TERMS.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {});

const money = (n) => "INR " + Number(n || 0).toLocaleString("en-IN");
const fmtDate = (d) => {
  const dt = d ? new Date(d) : new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${p(dt.getDate())}-${p(dt.getMonth() + 1)}-${dt.getFullYear()}`;
};

// HTML entities the rich-text editor writes (&rsquo; and friends), as characters.
const ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201D", ldquo: "\u201C",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", bull: "\u2022", rupee: "\u20B9",
};
const decodeEntities = (s) =>
  String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);

/*
  po.terms is rich text (HTML) from the Terms & Conditions master. pdfkit only
  draws plain strings, so it is turned into blocks — one per paragraph, list
  item or heading — each a list of runs that are bold or not (<strong>/<b>).
  That keeps the shape the author gave it: paragraphs apart, bullets, and the
  words they bolded, bold.
*/
const termsBlocks = (html) => {
  const BREAK = "\u0001";
  const marked = String(html || "")
    .replace(/\r?\n/g, " ")
    .replace(/<li[^>]*>/gi, BREAK + "\u2022  ")
    .replace(/<(p|div|h[1-6])[^>]*>/gi, BREAK)
    .replace(/<\/(p|div|li|h[1-6]|ul|ol)>/gi, BREAK)
    .replace(/<br\s*\/?>/gi, BREAK);
  return marked
    .split(BREAK)
    .map((block) => {
      const runs = [];
      const re = /<(strong|b)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
      let last = 0;
      let m;
      while ((m = re.exec(block))) {
        runs.push({ bold: false, text: block.slice(last, m.index) });
        runs.push({ bold: true, text: m[2] });
        last = re.lastIndex;
      }
      runs.push({ bold: false, text: block.slice(last) });
      return runs
        .map((r) => ({ bold: r.bold, text: decodeEntities(r.text.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ") }))
        .filter((r) => r.text.trim());
    })
    .filter((runs) => runs.length);
};

/* ── palette — kept minimal on purpose ─────────────────────────────────── */
const C = {
  ink: "#111827",
  muted: "#374151", // secondary text — dark enough to read comfortably in print
  rule: "#cbd5e1",
  accent: "#2b2f77", // used only for the title + section labels
  rowAlt: "#f8fafc",
  headBg: "#eef2f7", // items table header band
};

const PAGE_W = 595.28; // A4 pt
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_RESERVE = 10; // a little space always kept clear at the bottom of each page
const BOTTOM = PAGE_H - MARGIN - FOOTER_RESERVE;

/*
  Generate (or regenerate) a PO PDF. Returns the RELATIVE public path
  (e.g. "/uploads/stock/po/2026/10/PO-2026-0001.pdf"). Overwrites if it already
  exists, so a rejected → edited PO regenerates cleanly under the same name.
*/
export const generatePOPdf = (po) =>
  new Promise((resolve, reject) => {
    try {
      const sub = datedSubdir(po.createdAt || po.poDate || new Date());
      fs.mkdirSync(path.join(PO_DIR_ABS, sub), { recursive: true });
      const fileName = `${po.poNumber}.pdf`;
      const absPath = path.join(PO_DIR_ABS, sub, fileName);
      const relPath = `${PO_DIR_REL}/${sub}/${fileName}`;

      const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true });
      const stream = fs.createWriteStream(absPath);
      doc.pipe(stream);

      const isSplit = po.taxType === PO_TAX_TYPE.CGST_SGST;
      const buyer = po.buyerEntity || {};

      // Tax labels carry the rate ("CGST@9%") only when every line shares the
      // same GST rate — with mixed rates a single percentage would be a lie,
      // so the label falls back to the bare "CGST"/"SGST"/"IGST".
      const rates = [...new Set((po.items || []).map((it) => Number(it.gstRate || 0)))];
      const uniformRate = rates.length === 1 ? rates[0] : null;
      const pct = (r) => `@${Number(r.toFixed(2))}%`;
      const fullRateSuffix = uniformRate ? pct(uniformRate) : "";
      const halfRateSuffix = uniformRate ? pct(uniformRate / 2) : "";

      // Draw one line at (x, y) bounded to `width`, and return the y just
      // below it — this is the whole trick that keeps everything from
      // overlapping: nobody ever assumes a fixed line height again, every
      // next element is placed using the ACTUAL measured height of the
      // text that came before it (which may have wrapped to N lines).
      const line = (text, x, y, width, opts = {}) => {
        const str = text == null || text === "" ? "" : String(text);
        if (!str) return y;
        doc.text(str, x, y, { width, ...opts });
        return y + doc.heightOfString(str, { width, ...opts }) + (opts.gap ?? 2);
      };

      // Start a fresh page whenever the next block of `height` wouldn't fit
      // above the footer reserve — this is what makes the PDF continue onto
      // additional pages instead of silently overflowing/overlapping.
      const ensureSpace = (currentY, height) => {
        if (currentY + height > BOTTOM) {
          doc.addPage();
          return MARGIN;
        }
        return currentY;
      };

      // ── Header: buyer + PO meta (two independent columns) ────────────────
      let yL = MARGIN;
      doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(14);
      yL = line(buyer.name, MARGIN, yL, 270, { gap: 3 });
      doc.fillColor(C.muted).font("Helvetica").fontSize(8.5);
      yL = line(buyer.alias ? `(${buyer.alias})` : "", MARGIN, yL, 270);
      yL = line(buyer.address, MARGIN, yL, 270);
      yL = line(
        `GSTIN: ${buyer.gstNumber || "-"}   State: ${buyer.state || "-"} (${buyer.stateCode || "-"})`,
        MARGIN,
        yL,
        270
      );

      let yR = MARGIN;
      doc.fillColor(C.accent).font("Helvetica-Bold").fontSize(16);
      yR = line("PURCHASE ORDER", 340, yR, 215, { align: "right", gap: 4 });
      doc.fillColor(C.muted).font("Helvetica").fontSize(8.5);
      yR = line(`No: ${po.poNumber}`, 340, yR, 215, { align: "right" });
      yR = line(`Date: ${fmtDate(po.poDate)}`, 340, yR, 215, { align: "right" });

      let y = Math.max(yL, yR) + 6;
      doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).strokeColor(C.rule).lineWidth(1).stroke();
      y += 12;

      // ── Supplier + deliver-to (two independent columns) ──────────────────
      const supplierTop = y;
      doc.fillColor(C.accent).font("Helvetica-Bold").fontSize(7.5);
      doc.text("SUPPLIER", MARGIN, supplierTop);
      doc.text("DELIVER TO / DETAILS", 310, supplierTop);

      let ySup = supplierTop + 12;
      doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(10);
      ySup = line(po.vendorName, MARGIN, ySup, 250, { gap: 3 });
      doc.fillColor(C.muted).font("Helvetica").fontSize(8.5);
      ySup = line(po.vendorAddress, MARGIN, ySup, 250);
      ySup = line(
        `GSTIN: ${po.vendorGstin || "-"}  ${po.vendorState || ""} (${po.vendorStateCode || "-"})`,
        MARGIN,
        ySup,
        250
      );
      ySup = line(po.vendorPhone, MARGIN, ySup, 250);

      let yDel = supplierTop + 12;
      doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(9);
      yDel = line(`${buyer.name || ""}, ${buyer.state || ""}`, 310, yDel, 245, { gap: 3 });
      // "Label: value" with the label bold, measured as one line.
      const labelled = (label, value) => {
        const text = `${label}: ${value || "-"}`;
        doc.font("Helvetica").fontSize(8.5);
        const h = doc.heightOfString(text, { width: 245 });
        doc.fillColor(C.ink).font("Helvetica-Bold").text(`${label}: `, 310, yDel, { width: 245, continued: true });
        doc.fillColor(C.muted).font("Helvetica").text(value || "-");
        yDel += h + 2;
      };
      labelled("Shipment", po.shipmentPreference);
      labelled("Payment", PAYMENT_TERMS_MAP[po.paymentTerms]);
      labelled("Requester", po.requester);

      y = Math.max(ySup, yDel) + 14;

      // ── Items table ───────────────────────────────────────────────────────
      // Per-line tax is NOT itemised: the line shows what was ordered and what
      // it costs before tax (Unit Price x Qty = Total Price); CGST/SGST/IGST
      // are applied once, on the totals block below.
      // Explicit gaps between every column (not just narrower widths) so
      // Description/Product never look crammed against their neighbours.
      const cols = [
        { label: "Sr.", x: 40, w: 24, align: "left" },
        { label: "Description", x: 70, w: 175, align: "left" },
        { label: "Product", x: 252, w: 125, align: "left" },
        { label: "Qty", x: 383, w: 36, align: "right" },
        { label: "Unit Price", x: 425, w: 60, align: "right" },
        { label: "Total Price", x: 491, w: 64, align: "right" },
      ];

      const drawTableHeader = (headerY) => {
        doc.rect(MARGIN, headerY - 4, CONTENT_W, 16).fill(C.headBg);
        doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(8);
        cols.forEach((c) => doc.text(c.label, c.x, headerY, { width: c.w, align: c.align }));
        const ny = headerY + 12;
        doc.moveTo(MARGIN, ny).lineTo(MARGIN + CONTENT_W, ny).strokeColor(C.rule).lineWidth(1).stroke();
        return ny + 6;
      };

      y = ensureSpace(y, 30);
      y = drawTableHeader(y);

      const ROW_PAD_V = 4; // top/bottom padding inside each row
      const ROW_MIN_H = 16;

      (po.items || []).forEach((it, idx) => {
        const cells = [
          String(idx + 1),
          it.categoryName,
          it.productName,
          String(it.quantity),
          Number(it.unitPrice || 0).toLocaleString("en-IN"),
          Number(it.taxable || 0).toLocaleString("en-IN"),
        ];

        doc.font("Helvetica").fontSize(8.5);
        // Row height = tallest wrapped cell (Description/Product are the only
        // columns likely to wrap onto multiple lines).
        const rowH = Math.max(
          ROW_MIN_H,
          ...cols.map((c, i) => doc.heightOfString(cells[i] || "", { width: c.w }) + ROW_PAD_V)
        );

        // Paginate BEFORE drawing if this row would cross the footer reserve,
        // redrawing the column header on the new page.
        if (y + rowH > BOTTOM) {
          doc.addPage();
          y = drawTableHeader(MARGIN);
        }

        if (idx % 2 === 1) doc.rect(MARGIN, y - ROW_PAD_V / 2, CONTENT_W, rowH).fill(C.rowAlt);

        doc.fillColor(C.ink).font("Helvetica").fontSize(8.5);
        cols.forEach((c, i) => doc.text(cells[i], c.x, y, { width: c.w, align: c.align }));

        y += rowH;
        doc.moveTo(MARGIN, y - 2).lineTo(MARGIN + CONTENT_W, y - 2).strokeColor(C.rule).lineWidth(0.5).stroke();
      });

      // ── Totals ────────────────────────────────────────────────────────────
      y += 8;
      const totalsRowH = 16;
      const rightLabel = (label, val, bold = false) => {
        y = ensureSpace(y, totalsRowH);
        doc
          .fillColor(C.ink)
          .font(bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(bold ? 10.5 : 9)
          .text(label, 350, y, { width: 120, align: "left" });
        doc
          .fillColor(C.ink)
          .font(bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(bold ? 10.5 : 9)
          .text(money(val), 470, y, { width: 85, align: "right" });
        y += bold ? 16 : 13;
      };
      y = ensureSpace(y, 20);
      doc.moveTo(350, y).lineTo(MARGIN + CONTENT_W, y).strokeColor(C.rule).lineWidth(1).stroke();
      y += 8;

      rightLabel("Sub Total", po.subTotal);
      if (isSplit) {
        rightLabel(`CGST${halfRateSuffix}`, po.cgstTotal);
        rightLabel(`SGST${halfRateSuffix}`, po.sgstTotal);
      } else {
        rightLabel(`IGST${fullRateSuffix}`, po.igstTotal);
      }
      y += 8;
      rightLabel("Grand total", po.grandTotal, true);

      // ── Terms and conditions — full width, paragraph by paragraph ────────
      const blocks = termsBlocks(po.terms);
      y += 18;
      y = ensureSpace(y, 40);
      doc.fillColor(C.accent).font("Helvetica-Bold").fontSize(8).text("TERMS AND CONDITIONS", MARGIN, y);
      y += 12;
      doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).strokeColor(C.rule).lineWidth(1).stroke();
      y += 8;

      const TERMS_SIZE = 8.5;
      if (!blocks.length) {
        doc.fillColor(C.muted).font("Helvetica").fontSize(TERMS_SIZE).text("-", MARGIN, y);
      }
      blocks.forEach((runs) => {
        // Measured with the bold face — slightly wider, so the block never
        // ends up taller than the space set aside for it.
        const plain = runs.map((r) => r.text).join("");
        doc.font(runs.some((r) => r.bold) ? "Helvetica-Bold" : "Helvetica").fontSize(TERMS_SIZE);
        const h = doc.heightOfString(plain, { width: CONTENT_W, lineGap: 1.5 });
        y = ensureSpace(y, h);

        doc.fillColor(C.ink);
        runs.forEach((r, i) => {
          doc.font(r.bold ? "Helvetica-Bold" : "Helvetica").fontSize(TERMS_SIZE);
          const opts = { width: CONTENT_W, lineGap: 1.5, continued: i < runs.length - 1 };
          if (i === 0) doc.text(r.text, MARGIN, y, opts);
          else doc.text(r.text, opts);
        });
        y = doc.y + 5;
      });

      doc.end();

      stream.on("finish", () => {
        // A PO created before the dated layout still points at its old flat
        // PDF; once the new copy is on disk, the old one is just an orphan.
        if (po.pdfPath && po.pdfPath !== relPath) deleteStoredUpload(PO_DIR_ABS, po.pdfPath);
        log.info(`PO PDF written: ${relPath}`);
        resolve(relPath);
      });
      stream.on("error", (err) => reject(err));
    } catch (err) {
      log.error("PO PDF generation failed", err);
      reject(err);
    }
  });

export const poPdfAbsolutePath = (relPath) =>
  path.join(UPLOADS_ROOT, relPath.replace(/^\//, ""));
