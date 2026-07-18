import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";

import { getLogger } from "./logger.helper.js";
import { PO_TAX_TYPE } from "../constants/stock.enums.js";

const log = getLogger(import.meta.url);

/*
  Where PO PDFs are written. Mirror the product-image convention: files live under
  a public "uploads" root and are served as a relative path. Adjust PUBLIC_ROOT to
  match whatever static root your app already serves (same one product images use).
*/
const PUBLIC_ROOT = path.join(process.cwd(), "public");
const PO_DIR_REL = "/uploads/stock/po";
const PO_DIR_ABS = path.join(PUBLIC_ROOT, "uploads", "stock", "po");

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
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

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

      const doc = new PDFDocument({ size: "A4", margin: MARGIN });
      const stream = fs.createWriteStream(absPath);
      doc.pipe(stream);

      const isSplit = po.taxType === PO_TAX_TYPE.CGST_SGST;
      const buyer = po.buyerEntity || {};
      const leafOf = (c) => String(c || "").split("/").pop().trim();
      const itemCount = (po.items || []).length;
      // keep everything on one page: compact rows for longer item lists
      const rowH = itemCount > 22 ? 14 : itemCount > 14 ? 16 : 18;

      // ── Header: buyer + PO meta ─────────────────────────────────────────
      doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(14).text(buyer.name || "", MARGIN, 40);
      doc
        .fillColor(C.muted)
        .font("Helvetica")
        .fontSize(8.5)
        .text(buyer.alias ? `(${buyer.alias})` : "", MARGIN, 57)
        .text(buyer.address || "", MARGIN, 68, { width: 320 })
        .text(`GSTIN: ${buyer.gstNumber || "-"}   State: ${buyer.state || "-"} (${buyer.stateCode || "-"})`, MARGIN, 79);

      doc.fillColor(C.accent).font("Helvetica-Bold").fontSize(16).text("PURCHASE ORDER", 340, 40, { width: 215, align: "right" });
      doc
        .fillColor(C.muted)
        .font("Helvetica")
        .fontSize(8.5)
        .text(`No: ${po.poNumber}`, 340, 60, { width: 215, align: "right" })
        .text(`Date: ${fmtDate(po.poDate)}`, 340, 71, { width: 215, align: "right" });

      doc.moveTo(MARGIN, 100).lineTo(MARGIN + CONTENT_W, 100).strokeColor(C.rule).lineWidth(1).stroke();

      // ── Supplier + ship-to ────────────────────────────────────────────────
      let y = 112;
      doc.fillColor(C.accent).font("Helvetica-Bold").fontSize(7.5).text("SUPPLIER", MARGIN, y);
      doc.text("DELIVER TO / DETAILS", 310, y);
      y += 12;
      doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(10).text(po.vendorName || "", MARGIN, y);
      doc
        .fillColor(C.muted)
        .font("Helvetica")
        .fontSize(8.5)
        .text(po.vendorAddress || "", MARGIN, y + 13, { width: 250 })
        .text(`GSTIN: ${po.vendorGstin || "-"}  ${po.vendorState || ""} (${po.vendorStateCode || "-"})`, MARGIN, y + 25)
        .text(po.vendorPhone || "", MARGIN, y + 37);
      doc
        .fillColor(C.muted)
        .fontSize(8.5)
        .text(`${buyer.name || ""}, ${buyer.state || ""}`, 310, y + 13, { width: 245 })
        .text(`Shipment: ${po.shipmentPreference || "-"}`, 310, y + 25, { width: 245 })
        .text(`Payment: ${PAYMENT_TERMS_MAP[po.paymentTerms] || "-"}   Requester: ${po.requester || "-"}`, 310, y + 37, { width: 245 });

      // ── Items table ───────────────────────────────────────────────────────
      let ty = 200;
      const cols = isSplit
        ? [
            { label: "Category", x: 40, w: 90, align: "left" },
            { label: "Product", x: 132, w: 86, align: "left" },
            { label: "Qty", x: 220, w: 30, align: "right" },
            { label: "Taxable", x: 250, w: 60, align: "right" },
            { label: "CGST", x: 312, w: 56, align: "right" },
            { label: "SGST", x: 370, w: 56, align: "right" },
            { label: "Amount", x: 428, w: 127, align: "right" },
          ]
        : [
            { label: "Category", x: 40, w: 108, align: "left" },
            { label: "Product", x: 150, w: 108, align: "left" },
            { label: "Qty", x: 260, w: 35, align: "right" },
            { label: "Taxable", x: 295, w: 75, align: "right" },
            { label: "IGST", x: 370, w: 75, align: "right" },
            { label: "Amount", x: 445, w: 110, align: "right" },
          ];

      doc.fillColor(C.muted).font("Helvetica-Bold").fontSize(7.5);
      cols.forEach((c) => doc.text(c.label, c.x, ty, { width: c.w, align: c.align }));
      ty += 12;
      doc.moveTo(MARGIN, ty).lineTo(MARGIN + CONTENT_W, ty).strokeColor(C.rule).lineWidth(1).stroke();
      ty += 6;

      doc.font("Helvetica").fontSize(8.5);
      (po.items || []).forEach((it, idx) => {
        if (idx % 2 === 1) doc.rect(MARGIN, ty - 3, CONTENT_W, rowH).fill(C.rowAlt);

        const cells = isSplit
          ? [
              leafOf(it.categoryName),
              it.productName,
              String(it.quantity),
              Number(it.taxable).toLocaleString("en-IN"),
              Number(it.cgst).toLocaleString("en-IN"),
              Number(it.sgst).toLocaleString("en-IN"),
              Number(it.lineTotal).toLocaleString("en-IN"),
            ]
          : [
              leafOf(it.categoryName),
              it.productName,
              String(it.quantity),
              Number(it.taxable).toLocaleString("en-IN"),
              Number(it.igst).toLocaleString("en-IN"),
              Number(it.lineTotal).toLocaleString("en-IN"),
            ];

        doc.fillColor(C.ink).font("Helvetica").fontSize(8.5);
        cols.forEach((c, i) => doc.text(cells[i], c.x, ty, { width: c.w, align: c.align }));
        ty += rowH;
        doc.moveTo(MARGIN, ty - 4).lineTo(MARGIN + CONTENT_W, ty - 4).strokeColor(C.rule).lineWidth(0.5).stroke();
      });

      // ── Totals ────────────────────────────────────────────────────────────
      ty += 6;
      const rightLabel = (label, val, bold = false) => {
        doc
          .fillColor(bold ? C.ink : C.muted)
          .font(bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(bold ? 10.5 : 9)
          .text(label, 350, ty, { width: 120, align: "right" });
        doc
          .fillColor(C.ink)
          .font(bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(bold ? 10.5 : 9)
          .text(money(val), 470, ty, { width: 85, align: "right" });
        ty += bold ? 16 : 13;
      };
      rightLabel("Taxable", po.subTotal);
      if (isSplit) {
        rightLabel("CGST", po.cgstTotal);
        rightLabel("SGST", po.sgstTotal);
      } else {
        rightLabel("IGST", po.igstTotal);
      }
      doc.moveTo(350, ty).lineTo(MARGIN + CONTENT_W, ty).strokeColor(C.ink).lineWidth(1).stroke();
      ty += 5;
      rightLabel("Grand total", po.grandTotal, true);

      // ── Terms + signatory ────────────────────────────────────────────────
      ty += 20;
      doc.fillColor(C.accent).font("Helvetica-Bold").fontSize(7.5).text("TERMS AND CONDITIONS", MARGIN, ty);
      doc.fillColor(C.ink).font("Helvetica").fontSize(8.5).text(stripHtmlForPdf(po.terms) || "-", MARGIN, ty + 12, { width: 330 });
      doc
        .fillColor(C.muted)
        .font("Helvetica")
        .fontSize(9)
        .text(`For ${buyer.alias || buyer.name || ""}`, 400, ty + 12, { align: "right", width: 155 });
      doc.moveTo(400, ty + 55).lineTo(MARGIN + CONTENT_W, ty + 55).strokeColor(C.rule).lineWidth(1).stroke();
      doc.fillColor(C.muted).fontSize(8).text("Authorized signatory", 400, ty + 60, { align: "right", width: 155 });

      // ── footer note ──────────────────────────────────────────────────────
      doc
        .fillColor(C.muted)
        .font("Helvetica")
        .fontSize(7)
        .text("This is a system-generated purchase order.", MARGIN, 800, { width: CONTENT_W, align: "center" });

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
  path.join(PUBLIC_ROOT, relPath.replace(/^\//, ""));



















// import fs from "fs";
// import path from "path";
// import PDFDocument from "pdfkit";

// import { getLogger } from "./logger.helper.js";
// import { PO_TAX_TYPE } from "../constants/stock.enums.js";

// const log = getLogger(import.meta.url);

// /*
//   Where PO PDFs are written. Mirror the product-image convention: files live under
//   a public "uploads" root and are served as a relative path. Adjust PUBLIC_ROOT to
//   match whatever static root your app already serves (same one product images use).
// */
// const PUBLIC_ROOT = path.join(process.cwd(), "public");
// const PO_DIR_REL = "/uploads/stock/po";
// const PO_DIR_ABS = path.join(PUBLIC_ROOT, "uploads", "stock", "po");
//  const PAYMENT_TERMS = [
//   { label: "Immediate Payment", value: "IMMEDIATE" },
//   { label: "Payment Within 30 Days", value: "NET_30" },
//   { label: "Payment Within 60 Days", value: "NET_60" },
//   { label: "Payment Within 90 Days", value: "NET_90" },
// ];

// // Lookup map
// const PAYMENT_TERMS_MAP = PAYMENT_TERMS.reduce((acc, item) => {
//   acc[item.value] = item.label;
//   return acc;
// }, {});

// const money = (n) => "INR " + Number(n || 0).toLocaleString("en-IN");
// const fmtDate = (d) => {
//   const dt = d ? new Date(d) : new Date();
//   const p = (x) => String(x).padStart(2, "0");
//   return `${p(dt.getDate())}-${p(dt.getMonth() + 1)}-${dt.getFullYear()}`;
// };

// /*
//   Generate (or regenerate) a PO PDF. Returns the RELATIVE public path
//   (e.g. "/uploads/stock/po/PO-2026-0001.pdf"). Overwrites if it already exists,
//   so a rejected → edited PO regenerates cleanly under the same name.
// */
// export const generatePOPdf = (po) =>
//   new Promise((resolve, reject) => {
//     try {
//       fs.mkdirSync(PO_DIR_ABS, { recursive: true });
//       const fileName = `${po.poNumber}.pdf`;
//       const absPath = path.join(PO_DIR_ABS, fileName);
//       const relPath = `${PO_DIR_REL}/${fileName}`;

//       const doc = new PDFDocument({ size: "A4", margin: 40 });
//       const stream = fs.createWriteStream(absPath);
//       doc.pipe(stream);

//       const isSplit = po.taxType === PO_TAX_TYPE.CGST_SGST;
//       const buyer = po.buyerEntity || {};

//       // ── Header: buyer + PO meta ─────────────────────────────────────────────
//       doc.fontSize(14).text(`${buyer.name || ""}${buyer.alias ? ` (${buyer.alias})` : ""}`, 40, 40);
//       doc
//         .fontSize(9)
//         .fillColor("#555")
//         .text(buyer.address || "", 40, 60, { width: 320 })
//         .text(`GSTIN: ${buyer.gstNumber || "-"}   State: ${buyer.state || "-"} (${buyer.stateCode || "-"})`, 40);
//       doc
//         .fillColor("#000")
//         .fontSize(15)
//         .text("PURCHASE ORDER", 380, 40, { align: "right" });
//       doc
//         .fontSize(9)
//         .fillColor("#555")
//         .text(`No: ${po.poNumber}`, 380, 62, { align: "right" })
//         .text(`Date: ${fmtDate(po.poDate)}`, 380, 74, { align: "right" });

//       doc.moveTo(40, 100).lineTo(555, 100).strokeColor("#ccc").stroke();

//       // ── Supplier + ship-to ──────────────────────────────────────────────────
//       let y = 112;
//       doc.fillColor("#555").fontSize(8).text("SUPPLIER", 40, y);
//       doc.text("SHIP TO / DETAILS", 310, y);
//       y += 12;
//       doc.fillColor("#000").fontSize(10).text(po.vendorName || "", 40, y);
//       doc
//         .fontSize(9)
//         .fillColor("#555")
//         .text(po.vendorAddress || "", 40, y + 13, { width: 250 })
//         .text(`GSTIN: ${po.vendorGstin || "-"}  ${po.vendorState || ""} (${po.vendorStateCode || "-"})`, 40)
//         .text(po.vendorPhone || "", 40);
//       doc
//         .fillColor("#555")
//         .fontSize(9)
//         .text(`${buyer.name || ""}, ${buyer.state || ""}`, 310, y + 13, { width: 245 })
//         .text(`Shipment: ${po.shipmentPreference || "-"}`, 310)
//         .text(`Payment: ${PAYMENT_TERMS_MAP[po.paymentTerms] || "-"}   Requester: ${po.requester || "-"}`, 310);

//       // ── Items table ─────────────────────────────────────────────────────────
//       const leafOf = (c) => String(c || "").split("/").pop().trim();
//       let ty = 200;
//       const cols = isSplit
//         ? [
//             { label: "Category", x: 40, w: 90, align: "left" },
//             { label: "Product", x: 132, w: 86, align: "left" },
//             { label: "Qty", x: 220, w: 30, align: "right" },
//             { label: "Taxable", x: 250, w: 60, align: "right" },
//             { label: "CGST", x: 312, w: 56, align: "right" },
//             { label: "SGST", x: 370, w: 56, align: "right" },
//             { label: "Amount", x: 428, w: 127, align: "right" },
//           ]
//         : [
//             { label: "Category", x: 40, w: 108, align: "left" },
//             { label: "Product", x: 150, w: 108, align: "left" },
//             { label: "Qty", x: 260, w: 35, align: "right" },
//             { label: "Taxable", x: 295, w: 75, align: "right" },
//             { label: "IGST", x: 370, w: 75, align: "right" },
//             { label: "Amount", x: 445, w: 110, align: "right" },
//           ];

//       doc.rect(40, ty - 4, 515, 18).fill("#f2f2f2").fillColor("#555").fontSize(8);
//       cols.forEach((c) => doc.text(c.label, c.x, ty, { width: c.w, align: c.align }));
//       ty += 18;

//       doc.fillColor("#000").fontSize(9);
//       (po.items || []).forEach((it) => {
//         const cells = isSplit
//           ? [
//               leafOf(it.categoryName),
//               it.productName,
//               String(it.quantity),
//               Number(it.taxable).toLocaleString("en-IN"),
//               Number(it.cgst).toLocaleString("en-IN"),
//               Number(it.sgst).toLocaleString("en-IN"),
//               Number(it.lineTotal).toLocaleString("en-IN"),
//             ]
//           : [
//               leafOf(it.categoryName),
//               it.productName,
//               String(it.quantity),
//               Number(it.taxable).toLocaleString("en-IN"),
//               Number(it.igst).toLocaleString("en-IN"),
//               Number(it.lineTotal).toLocaleString("en-IN"),
//             ];
//         cols.forEach((c, i) => doc.text(cells[i], c.x, ty, { width: c.w, align: c.align }));
//         ty += 16;
//         doc.moveTo(40, ty - 3).lineTo(555, ty - 3).strokeColor("#eee").stroke();
//       });

//       // ── Totals ──────────────────────────────────────────────────────────────
//       ty += 8;
//       const rightLabel = (label, val) => {
//         doc.fillColor("#555").fontSize(9).text(label, 360, ty, { width: 110, align: "right" });
//         doc.fillColor("#000").text(money(val), 470, ty, { width: 85, align: "right" });
//         ty += 14;
//       };
//       rightLabel("Taxable", po.subTotal);
//       if (isSplit) {
//         rightLabel("CGST", po.cgstTotal);
//         rightLabel("SGST", po.sgstTotal);
//       } else {
//         rightLabel("IGST", po.igstTotal);
//       }
//       doc.moveTo(360, ty).lineTo(555, ty).strokeColor("#999").stroke();
//       ty += 4;
//       doc.fillColor("#000").fontSize(11).text("Grand total", 360, ty, { width: 110, align: "right" });
//       doc.text(money(po.grandTotal), 470, ty, { width: 85, align: "right" });

//       // ── Terms + signatory ─────────────────────────────────────────────────
//       ty += 30;
//       doc.fillColor("#555").fontSize(8).text("Terms and conditions", 40, ty);
//       doc.fillColor("#000").fontSize(9).text(po.terms || "-", 40, ty + 12, { width: 330 });
//       doc.fillColor("#555").fontSize(9).text(`For ${buyer.alias || buyer.name || ""}`, 400, ty + 12, { align: "right", width: 155 });
//       doc.text("Authorized signatory", 400, ty + 55, { align: "right", width: 155 });

//       doc.end();

//       stream.on("finish", () => {
//         log.info(`PO PDF written: ${relPath}`);
//         resolve(relPath);
//       });
//       stream.on("error", (err) => reject(err));
//     } catch (err) {
//       log.error("PO PDF generation failed", err);
//       reject(err);
//     }
//   });

// export const poPdfAbsolutePath = (relPath) =>
//   path.join(PUBLIC_ROOT, relPath.replace(/^\//, ""));