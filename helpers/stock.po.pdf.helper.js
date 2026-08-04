import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";

import { getLogger } from "./logger.helper.js";
import { PO_TAX_TYPE } from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);

/*
  Where PO PDFs are written. Same convention as product images: files live under
  the top-level "uploads" root (process.cwd()/uploads), which app.js serves
  statically at /uploads — not under public/.
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

// po.terms is rich text (HTML) from the Terms & Conditions master — pdfkit's
// doc.text() only renders plain strings, so flatten block/list tags to
// newlines and "• " bullets, then strip whatever markup is left.
const stripHtmlForPdf = (html) =>
  String(html || "")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/* ── palette — kept minimal on purpose ─────────────────────────────────── */
const C = {
  ink: "#1a1a1a",
  muted: "#6b7280",
  rule: "#d8dade",
  accent: "#2b2f77", // used only for the title + section labels
  rowAlt: "#fafafa",
};

const PAGE_W = 595.28; // A4 pt
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_RESERVE = 20; // space always kept clear at the bottom for the footer note
const BOTTOM = PAGE_H - MARGIN - FOOTER_RESERVE;

/*
  Generate (or regenerate) a PO PDF. Returns the RELATIVE public path
  (e.g. "/uploads/stock/po/PO-2026-0001.pdf"). Overwrites if it already exists,
  so a rejected → edited PO regenerates cleanly under the same name.
*/
export const generatePOPdf = (po) =>
  new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(PO_DIR_ABS, { recursive: true });
      const fileName = `${po.poNumber}.pdf`;
      const absPath = path.join(PO_DIR_ABS, fileName);
      const relPath = `${PO_DIR_REL}/${fileName}`;

      const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true });
      const stream = fs.createWriteStream(absPath);
      doc.pipe(stream);

      const isSplit = po.taxType === PO_TAX_TYPE.CGST_SGST;
      const buyer = po.buyerEntity || {};

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
      doc.fillColor(C.muted).font("Helvetica").fontSize(8.5);
      yDel = line(`${buyer.name || ""}, ${buyer.state || ""}`, 310, yDel, 245);
      yDel = line(`Shipment: ${po.shipmentPreference || "-"}`, 310, yDel, 245);
      yDel = line(`Payment: ${PAYMENT_TERMS_MAP[po.paymentTerms] || "-"}`, 310, yDel, 245);
      yDel = line(`Requester: ${po.requester || "-"}`, 310, yDel, 245);

      y = Math.max(ySup, yDel) + 14;

      // ── Items table ───────────────────────────────────────────────────────
      // Explicit gaps between every column (not just narrower widths) so
      // Description/Product never look crammed against their neighbours.
      const cols = isSplit
        ? [
            { label: "Sr.", x: 40, w: 20, align: "left" },
            { label: "Description", x: 66, w: 108, align: "left" },
            { label: "Product", x: 180, w: 95, align: "left" },
            { label: "Qty", x: 281, w: 26, align: "right" },
            { label: "Basic Price", x: 313, w: 58, align: "right" },
            { label: "CGST", x: 377, w: 50, align: "right" },
            { label: "SGST", x: 433, w: 50, align: "right" },
            { label: "Amount", x: 489, w: 66, align: "right" },
          ]
        : [
            { label: "Sr.", x: 40, w: 22, align: "left" },
            { label: "Description", x: 68, w: 124, align: "left" },
            { label: "Product", x: 198, w: 110, align: "left" },
            { label: "Qty", x: 314, w: 30, align: "right" },
            { label: "Basic Price", x: 350, w: 65, align: "right" },
            { label: "IGST", x: 421, w: 58, align: "right" },
            { label: "Amount", x: 485, w: 69, align: "right" },
          ];

      const drawTableHeader = (headerY) => {
        doc.fillColor(C.muted).font("Helvetica-Bold").fontSize(7.5);
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
        const cells = isSplit
          ? [
              String(idx + 1),
              it.categoryName,
              it.productName,
              String(it.quantity),
              Number(it.taxable).toLocaleString("en-IN"),
              Number(it.cgst).toLocaleString("en-IN"),
              Number(it.sgst).toLocaleString("en-IN"),
              Number(it.lineTotal).toLocaleString("en-IN"),
            ]
          : [
              String(idx + 1),
              it.categoryName,
              it.productName,
              String(it.quantity),
              Number(it.taxable).toLocaleString("en-IN"),
              Number(it.igst).toLocaleString("en-IN"),
              Number(it.lineTotal).toLocaleString("en-IN"),
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
          .fillColor(bold ? C.ink : C.muted)
          .font(bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(bold ? 10.5 : 9)
          .text(label, 350, y, { width: 120, align: "right" });
        doc
          .fillColor(C.ink)
          .font(bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(bold ? 10.5 : 9)
          .text(money(val), 470, y, { width: 85, align: "right" });
        y += bold ? 16 : 13;
      };
      rightLabel("Basic Price", po.subTotal);
      if (isSplit) {
        rightLabel("CGST", po.cgstTotal);
        rightLabel("SGST", po.sgstTotal);
      } else {
        rightLabel("IGST", po.igstTotal);
      }
      y = ensureSpace(y, 20);
      doc.moveTo(350, y).lineTo(MARGIN + CONTENT_W, y).strokeColor(C.ink).lineWidth(1).stroke();
      y += 5;
      rightLabel("Grand total", po.grandTotal, true);

      // ── Terms + signatory ────────────────────────────────────────────────
      y += 16;
      const termsText = stripHtmlForPdf(po.terms) || "-";
      const termsW = 330;
      doc.font("Helvetica").fontSize(8.5);
      const termsH = doc.heightOfString(termsText, { width: termsW });
      const signBlockH = 70; // label + rule + "Authorized signatory"
      y = ensureSpace(y, Math.max(termsH, signBlockH) + 14);

      doc.fillColor(C.accent).font("Helvetica-Bold").fontSize(7.5).text("TERMS AND CONDITIONS", MARGIN, y);
      const termsBottom = line(termsText, MARGIN, y + 12, termsW);

      doc
        .fillColor(C.muted)
        .font("Helvetica")
        .fontSize(9)
        .text(`For ${buyer.alias || buyer.name || ""}`, 400, y + 12, { align: "right", width: 155 });
      doc.moveTo(400, y + 55).lineTo(MARGIN + CONTENT_W, y + 55).strokeColor(C.rule).lineWidth(1).stroke();
      doc.fillColor(C.muted).fontSize(8).text("Authorized signatory", 400, y + 60, { align: "right", width: 155 });

      // ── footer note — flows after whatever came before it, never a fixed y
      const footerY = Math.max(termsBottom, y + 72) + 10;
      doc
        .fillColor(C.muted)
        .font("Helvetica")
        .fontSize(7)
        .text("This is a system-generated purchase order.", MARGIN, footerY, { width: CONTENT_W, align: "center" });

      doc.end();

      stream.on("finish", () => {
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
