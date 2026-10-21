import ExcelJS from "exceljs";
import multer from "multer";
import path from "path";

/*
  The Excel side of Opening Stock: a per-product template to fill in, and the
  reader for what comes back.

  Per product, because every product has its own fields — a router has Serial
  and MAC, a cable has none. One sheet with every field of every product would
  be a hundred columns nobody can fill correctly.

  Why .xlsx and not CSV: Excel opens a CSV and "helpfully" turns a 15-digit
  IMEI into 3.57E+14 and drops the leading zero of 00123. The template formats
  every field column as Text, which is the only way those survive a round trip.

  A hidden _meta sheet records which product the template is for and what each
  column means, so the reader never guesses from header text a user may have
  edited, and a template for product A cannot be uploaded against product B.
*/

const SHEET = "Opening Stock";
const META = "_meta";
const LISTS = "_lists";
const MAX_ROWS = 2000;
const VALIDATED_ROWS = MAX_ROWS + 1;

// Fixed columns after the product's own fields. `key` is what the reader
// returns; the label is what the person sees.
const fixedColumns = (isQuantity) => [
  ...(isQuantity ? [{ key: "quantity", label: "Quantity *", width: 12 }] : []),
  { key: "condition", label: "Condition (NEW / USED)", width: 22 },
  { key: "vendor", label: "Vendor (exact name)", width: 28 },
  { key: "purchaseDate", label: "Purchase Date (DD-MM-YYYY)", width: 24, date: true },
  { key: "purchaseCost", label: "Purchase Cost (per unit)", width: 22 },
  { key: "warrantyMonths", label: "Warranty Months", width: 16 },
  { key: "warrantyEndDate", label: "OR Warranty End Date (DD-MM-YYYY)", width: 30, date: true },
  { key: "heldBy", label: "Currently With (name / emp code)", width: 30 },
  { key: "lastUsedBy", label: "Last Used By (before system)", width: 28 },
  { key: "historyRemarks", label: "Past History / Remarks", width: 36 },
];

/**
 * @param product   { _id, name, trackingMethod }
 * @param fields    [{ code, label, required, isUnique }] in display order
 * @param vendors   [{ name }]
 * @returns Buffer
 */
export async function buildOpeningStockTemplate({ product, fields, vendors }) {
  const isQuantity = product.trackingMethod === "quantity";
  const columns = [
    ...fields.map((f) => ({
      key: `f:${f.code}`,
      label: `${f.label}${f.required ? " *" : ""}${f.isUnique ? " (unique)" : ""}`,
      width: Math.max(16, f.label.length + 10),
      text: true,
    })),
    ...fixedColumns(isQuantity),
  ];

  const wb = new ExcelJS.Workbook();
  wb.creator = "Stock";
  const ws = wb.addWorksheet(SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.label, key: c.key, width: c.width }));

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4F46E5" } };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 32;

  // Lists live on a hidden sheet so the dropdowns survive any vendor count
  // (an inline list is capped at 255 characters).
  const lists = wb.addWorksheet(LISTS, { state: "veryHidden" });
  lists.getCell("A1").value = "NEW";
  lists.getCell("A2").value = "USED";
  vendors.forEach((v, i) => (lists.getCell(`B${i + 1}`).value = v.name));

  columns.forEach((c, idx) => {
    const col = ws.getColumn(idx + 1);
    if (c.text) col.numFmt = "@";
    if (c.date) col.numFmt = "dd-mm-yyyy";
    for (let r = 2; r <= VALIDATED_ROWS; r++) {
      const cell = ws.getCell(r, idx + 1);
      if (c.key === "condition") {
        cell.dataValidation = { type: "list", allowBlank: true, formulae: [`${LISTS}!$A$1:$A$2`] };
      } else if (c.key === "vendor" && vendors.length) {
        cell.dataValidation = {
          type: "list",
          allowBlank: true,
          showErrorMessage: true,
          errorTitle: "Unknown vendor",
          error: "Pick a vendor from the list, or leave it blank.",
          formulae: [`${LISTS}!$B$1:$B$${vendors.length}`],
        };
      }
    }
  });

  const meta = wb.addWorksheet(META, { state: "veryHidden" });
  meta.getCell("A1").value = "productId";
  meta.getCell("B1").value = String(product._id);
  meta.getCell("A2").value = "productName";
  meta.getCell("B2").value = product.name;
  columns.forEach((c, i) => (meta.getCell(3, i + 1).value = c.key));

  const help = wb.addWorksheet("Instructions");
  [
    `Opening stock template for: ${product.name}`,
    "",
    "One row = one unit" + (isQuantity ? " batch (fill Quantity)." : " (one serial / MAC per row)."),
    "Columns marked * must be filled. Columns marked (unique) can never repeat — at least one of them is needed per unit.",
    "Condition: NEW or USED. Blank means USED.",
    "Warranty: give EITHER Warranty Months (counted from Purchase Date) OR a Warranty End Date. Leave both blank if unknown.",
    "Currently With: fill only if the item is with an employee right now — it will be kept RESERVED until assigned.",
    "Last Used By / Past History: anything known from before this system. Optional.",
    `Up to ${MAX_ROWS} rows per upload. Do not rename or reorder the columns.`,
  ].forEach((line, i) => (help.getCell(`A${i + 1}`).value = line));
  help.getColumn(1).width = 120;
  help.getRow(1).font = { bold: true, size: 13 };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// An ExcelJS cell value down to a plain string / number / Date / null.
const plain = (v) => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if ("result" in v) return plain(v.result); // formula
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return v.text; // hyperlink
    if ("error" in v) return null;
    return null;
  }
  return v;
};

/**
 * Reads an uploaded template back. Returns raw rows keyed by column key — the
 * service turns them into lines (types, vendors, dates), since that needs the
 * database. Throws on anything that means "this is not our template".
 *
 * @returns { productId, rows: [{ rowNumber, values: { [key]: string|number|Date|null } }] }
 */
export async function readOpeningStockSheet(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new Error("Invalid file: could not read it as an Excel (.xlsx) workbook");
  }
  const ws = wb.getWorksheet(SHEET);
  const meta = wb.getWorksheet(META);
  if (!ws || !meta) throw new Error("Invalid file: this is not an opening stock template — download the template first");

  const productId = String(plain(meta.getCell("B1").value) || "");
  const keys = [];
  meta.getRow(3).eachCell({ includeEmpty: false }, (cell, col) => (keys[col - 1] = String(plain(cell.value) || "")));
  if (!productId || !keys.length) throw new Error("Invalid file: the template's hidden details are missing");

  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = {};
    let any = false;
    keys.forEach((key, i) => {
      if (!key) return;
      let v = plain(row.getCell(i + 1).value);
      if (typeof v === "string") v = v.trim();
      if (v === "") v = null;
      if (v !== null) any = true;
      values[key] = v;
    });
    if (any) rows.push({ rowNumber, values });
  });
  if (rows.length > MAX_ROWS) throw new Error(`Invalid file: ${rows.length} rows — upload at most ${MAX_ROWS} at a time`);
  return { productId, rows };
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// In memory only — the file is read and thrown away; the entry is what is saved.
export const uploadOpeningStockSheet = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isXlsx = path.extname(file.originalname || "").toLowerCase() === ".xlsx";
    // Some browsers send octet-stream for .xlsx — the extension decides then.
    if (isXlsx && [XLSX_MIME, "application/octet-stream"].includes(file.mimetype)) return cb(null, true);
    cb(new Error("Invalid file: upload the .xlsx template"));
  },
});
