import multer from "multer";
import path from "path";
import fs from "fs";

const INVOICE_FILE_DIR = path.join(process.cwd(), "uploads", "stock", "invoices");

if (!fs.existsSync(INVOICE_FILE_DIR)) {
  fs.mkdirSync(INVOICE_FILE_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, INVOICE_FILE_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
    cb(null, `invoice_${unique}${ext}`);
  },
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
  if (!publicPath) return;
  try {
    const filename = path.basename(publicPath);
    const fullPath = path.join(INVOICE_FILE_DIR, filename);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  } catch {
    // best-effort — never throw from cleanup
  }
}
