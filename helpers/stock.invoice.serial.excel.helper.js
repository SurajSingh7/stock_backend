import ExcelJS from "exceljs";
import multer from "multer";
import path from "path";
import { plain } from "./stock.opening.stock.excel.helper.js";

/*
  Add Serial / Qty → Excel: a per-product template for the units an invoice
  brought in, and the reader for what comes back.

  Only for individual-tracked products — one row per unit, one column per
  tracked field (Serial No, MAC Address, IMEI…), taken from the product's own
  field list, never hardcoded. FOC units are not in the file; they still come
  from the FOC button on the screen.

  Same rules as the Opening Stock template: .xlsx with every field column
  formatted as Text (so a 15-digit IMEI or a leading zero survives Excel), and
  a hidden _meta sheet naming the invoice + product, so a file for one product
  or invoice can't be uploaded against another.
*/

const SHEET = "Serials";
const META = "_meta";
const MAX_ROWS = 2000;

/**
 * @param invoice  { _id, invoiceNumber }
 * @param product  { _id, name }
 * @param fields   [{ code, label, required, isUnique }] in display order
 * @param left     units still to be entered for this product on the invoice
 * @returns Buffer
 */
export async function buildInvoiceSerialTemplate({ invoice, product, fields, left }) {
  const columns = fields.map((f) => ({
    key: `f:${f.code}`,
    label: `${f.label}${f.required ? " *" : ""}${f.isUnique ? " (unique)" : ""}`,
    width: Math.max(20, f.label.length + 12),
  }));

  const wb = new ExcelJS.Workbook();
  wb.creator = "Stock";
  const ws = wb.addWorksheet(SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.label, key: c.key, width: c.width }));
  columns.forEach((_, i) => (ws.getColumn(i + 1).numFmt = "@"));

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4F46E5" } };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 28;

  const meta = wb.addWorksheet(META, { state: "veryHidden" });
  meta.getCell("A1").value = "invoiceId";
  meta.getCell("B1").value = String(invoice._id);
  meta.getCell("A2").value = "productId";
  meta.getCell("B2").value = String(product._id);
  columns.forEach((c, i) => (meta.getCell(3, i + 1).value = c.key));

  // The example lives here, not on the Serials sheet — an example row there
  // gets uploaded as a real unit sooner or later.
  const help = wb.addWorksheet("Instructions");
  const example = fields.map((f) => `${f.label}: ${/mac/i.test(f.code + f.label) ? "AA:BB:CC:DD:EE:01" : "SN123456"}`).join("   ");
  [
    `Serial template — ${product.name} · Invoice ${invoice.invoiceNumber}`,
    "",
    `Units still to enter on this invoice: ${left}. Extra rows are left out on upload.`,
    "One row = one unit. Fill the Serials sheet from row 2; leave row 1 (the headings) as it is.",
    "Columns marked * must be filled. Columns marked (unique) can never repeat — each unit needs at least one of them.",
    "Only paid units go here. FOC (free) units are added from the FOC button on the screen.",
    `Example row → ${example}`,
    `Up to ${MAX_ROWS} rows per upload. Do not rename or reorder the columns.`,
  ].forEach((line, i) => (help.getCell(`A${i + 1}`).value = line));
  help.getColumn(1).width = 110;
  help.getRow(1).font = { bold: true, size: 13 };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

const cellText = (v) => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  return s === "" ? null : s;
};

/**
 * Reads an uploaded serial template back. Throws on anything that means
 * "this is not our template".
 *
 * @returns { invoiceId, productId, rows: [{ rowNumber, values: { [fieldCode]: string|null } }] }
 */
export async function readInvoiceSerialSheet(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new Error("Invalid file: could not read it as an Excel (.xlsx) workbook");
  }
  const ws = wb.getWorksheet(SHEET);
  const meta = wb.getWorksheet(META);
  if (!ws || !meta) throw new Error("Invalid file: this is not a serial template — download the template first");

  const invoiceId = String(plain(meta.getCell("B1").value) || "");
  const productId = String(plain(meta.getCell("B2").value) || "");
  const keys = [];
  meta.getRow(3).eachCell({ includeEmpty: false }, (cell, col) => (keys[col - 1] = String(plain(cell.value) || "")));
  if (!invoiceId || !productId || !keys.length) throw new Error("Invalid file: the template's hidden details are missing");

  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = {};
    let any = false;
    keys.forEach((key, i) => {
      if (!key?.startsWith("f:")) return;
      const v = cellText(plain(row.getCell(i + 1).value));
      if (v !== null) any = true;
      values[key.slice(2)] = v;
    });
    if (any) rows.push({ rowNumber, values });
  });
  if (rows.length > MAX_ROWS) throw new Error(`Invalid file: ${rows.length} rows — upload at most ${MAX_ROWS} at a time`);
  return { invoiceId, productId, rows };
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// In memory only — the file is read and thrown away; the rows go to the screen.
export const uploadInvoiceSerialSheet = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isXlsx = path.extname(file.originalname || "").toLowerCase() === ".xlsx";
    if (isXlsx && [XLSX_MIME, "application/octet-stream"].includes(file.mimetype)) return cb(null, true);
    cb(new Error("Invalid file: upload the .xlsx serial template"));
  },
});
