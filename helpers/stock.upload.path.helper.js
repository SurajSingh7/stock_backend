import path from "path";
import fs from "fs";

/*
  Shared on-disk layout for every stock upload:

    uploads/stock/<type>/<YYYY>/<MM>/<file>

  Month is zero-padded so folders sort 01..12 in any file browser. The date is
  the UPLOAD date (server local time) — multer writes the file before the rest
  of the form is parsed, so a document date is not reliably available here.

  Files saved before this layout existed still sit flat in uploads/stock/<type>/
  and their stored DB paths keep working; nothing here assumes every path is
  nested.
*/

export const STOCK_UPLOADS_ROOT = path.join(process.cwd(), "uploads", "stock");

// "2026/10" for the given date (defaults to now).
export function datedSubdir(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/*
  Multer filename that carries the dated subfolder: "2026/10/invoice_xxx.pdf".
  Creates the folder first — multer's diskStorage joins destination + filename
  and writes straight away, it does not create intermediate directories.

  Returning the subfolder inside the filename (rather than through
  `destination`) keeps req.file.filename as the path relative to the type
  folder, so every toPublic*Path(filename) caller stays unchanged.
*/
export function datedUploadFilename(baseDir, prefix, originalname) {
  const sub = datedSubdir();
  fs.mkdirSync(path.join(baseDir, sub), { recursive: true });
  const ext = path.extname(originalname || "").toLowerCase();
  const unique = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  return `${sub}/${prefix}_${unique}${ext}`;
}

/*
  Deletes a stored file given its public path ("/uploads/stock/<type>/...").
  Works for both the old flat paths and the new dated ones. Refuses anything
  that resolves outside baseDir, so a tampered path in the DB can never reach
  another file on disk. Best-effort — never throws.
*/
export function deleteStoredUpload(baseDir, publicPath) {
  if (!publicPath) return;
  try {
    const fullPath = path.resolve(process.cwd(), String(publicPath).replace(/^[/\\]+/, ""));
    const base = path.resolve(baseDir) + path.sep;
    if (!fullPath.startsWith(base)) return;
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  } catch {
    // best-effort — never throw from cleanup
  }
}
