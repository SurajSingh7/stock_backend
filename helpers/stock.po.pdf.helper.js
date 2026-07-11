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

const money = (n) => "INR " + Number(n || 0).toLocaleString("en-IN");
const fmtDate = (d) => {
  const dt = d ? new Date(d) : new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${p(dt.getDate())}-${p(dt.getMonth() + 1)}-${dt.getFullYear()}`;
};

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

      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const stream = fs.createWriteStream(absPath);
      doc.pipe(stream);

      const isSplit = po.taxType === PO_TAX_TYPE.CGST_SGST;
      const buyer = po.buyerEntity || {};

      // ── Header: buyer + PO meta ─────────────────────────────────────────────
      doc.fontSize(14).text(`${buyer.name || ""}${buyer.alias ? ` (${buyer.alias})` : ""}`, 40, 40);
      doc
        .fontSize(9)
        .fillColor("#555")
        .text(buyer.address || "", 40, 60, { width: 320 })
        .text(`GSTIN: ${buyer.gstNumber || "-"}   State: ${buyer.state || "-"} (${buyer.stateCode || "-"})`, 40);
      doc
        .fillColor("#000")
        .fontSize(15)
        .text("PURCHASE ORDER", 380, 40, { align: "right" });
      doc
        .fontSize(9)
        .fillColor("#555")
        .text(`No: ${po.poNumber}`, 380, 62, { align: "right" })
        .text(`Date: ${fmtDate(po.poDate)}`, 380, 74, { align: "right" });

      doc.moveTo(40, 100).lineTo(555, 100).strokeColor("#ccc").stroke();

      // ── Supplier + ship-to ──────────────────────────────────────────────────
      let y = 112;
      doc.fillColor("#555").fontSize(8).text("SUPPLIER", 40, y);
      doc.text("SHIP TO / DETAILS", 310, y);
      y += 12;
      doc.fillColor("#000").fontSize(10).text(po.vendorName || "", 40, y);
      doc
        .fontSize(9)
        .fillColor("#555")
        .text(po.vendorAddress || "", 40, y + 13, { width: 250 })
        .text(`GSTIN: ${po.vendorGstin || "-"}  ${po.vendorState || ""} (${po.vendorStateCode || "-"})`, 40)
        .text(po.vendorPhone || "", 40);
      doc
        .fillColor("#555")
        .fontSize(9)
        .text(`${buyer.name || ""}, ${buyer.state || ""}`, 310, y + 13, { width: 245 })
        .text(`Shipment: ${po.shipmentPreference || "-"}`, 310)
        .text(`Payment: ${po.paymentTerms || "-"}   Requester: ${po.requester || "-"}`, 310);

      // ── Items table ─────────────────────────────────────────────────────────
      const leafOf = (c) => String(c || "").split("/").pop().trim();
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

      doc.rect(40, ty - 4, 515, 18).fill("#f2f2f2").fillColor("#555").fontSize(8);
      cols.forEach((c) => doc.text(c.label, c.x, ty, { width: c.w, align: c.align }));
      ty += 18;

      doc.fillColor("#000").fontSize(9);
      (po.items || []).forEach((it) => {
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
        cols.forEach((c, i) => doc.text(cells[i], c.x, ty, { width: c.w, align: c.align }));
        ty += 16;
        doc.moveTo(40, ty - 3).lineTo(555, ty - 3).strokeColor("#eee").stroke();
      });

      // ── Totals ──────────────────────────────────────────────────────────────
      ty += 8;
      const rightLabel = (label, val) => {
        doc.fillColor("#555").fontSize(9).text(label, 360, ty, { width: 110, align: "right" });
        doc.fillColor("#000").text(money(val), 470, ty, { width: 85, align: "right" });
        ty += 14;
      };
      rightLabel("Taxable", po.subTotal);
      if (isSplit) {
        rightLabel("CGST", po.cgstTotal);
        rightLabel("SGST", po.sgstTotal);
      } else {
        rightLabel("IGST", po.igstTotal);
      }
      doc.moveTo(360, ty).lineTo(555, ty).strokeColor("#999").stroke();
      ty += 4;
      doc.fillColor("#000").fontSize(11).text("Grand total", 360, ty, { width: 110, align: "right" });
      doc.text(money(po.grandTotal), 470, ty, { width: 85, align: "right" });

      // ── Terms + signatory ─────────────────────────────────────────────────
      ty += 30;
      doc.fillColor("#555").fontSize(8).text("Terms and conditions", 40, ty);
      doc.fillColor("#000").fontSize(9).text(po.terms || "-", 40, ty + 12, { width: 330 });
      doc.fillColor("#555").fontSize(9).text(`For ${buyer.alias || buyer.name || ""}`, 400, ty + 12, { align: "right", width: 155 });
      doc.text("Authorized signatory", 400, ty + 55, { align: "right", width: 155 });

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