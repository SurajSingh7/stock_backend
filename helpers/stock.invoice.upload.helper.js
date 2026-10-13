import multer from "multer";
import path from "path";
import fs from "fs";
import { STOCK_UPLOADS_ROOT, datedUploadFilename, deleteStoredUpload } from "./stock.upload.path.helper.js";

const INVOICE_FILE_DIR = path.join(STOCK_UPLOADS_ROOT, "invoices");

if (!fs.existsSync(INVOICE_FILE_DIR)) {
  fs.mkdirSync(INVOICE_FILE_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, INVOICE_FILE_DIR),
  // Lands in invoices/<YYYY>/<MM>/ — see stock.upload.path.helper.js.
  filename: (req, file, cb) => cb(null, datedUploadFilename(INVOICE_FILE_DIR, "invoice", file.originalname)),
});

// Same allowlist/size cap as product attachments — reused verbatim, see
// stock.upload.helper.js.
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"];
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error("Only JPG, PNG, WEBP images or PDF files are allowed"));
  }
  cb(null, true);
};

// Mounted as `.single("invoiceFile")` on the invoice create/update routes.
export const uploadInvoiceFile = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

export function toPublicInvoicePath(filename) {
  return `/uploads/stock/invoices/${filename}`;
}

export function deleteInvoiceFile(publicPath) {
  deleteStoredUpload(INVOICE_FILE_DIR, publicPath);
}
