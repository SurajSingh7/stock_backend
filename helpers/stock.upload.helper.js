import multer from "multer";
import path from "path";
import fs from "fs";
import { STOCK_UPLOADS_ROOT, datedUploadFilename, deleteStoredUpload } from "./stock.upload.path.helper.js";

const PRODUCT_IMAGE_DIR = path.join(STOCK_UPLOADS_ROOT, "products");

if (!fs.existsSync(PRODUCT_IMAGE_DIR)) {
  fs.mkdirSync(PRODUCT_IMAGE_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PRODUCT_IMAGE_DIR),
  filename: (req, file, cb) => {
    // Keep the real extension — the frontend decides how to render the asset by
    // sniffing ".pdf" on the stored path (isPdfPath() in ProductDefinition.jsx).
    // Losing the extension here would make every PDF render as a broken <img>.
    // Lands in products/<YYYY>/<MM>/ — see stock.upload.path.helper.js.
    cb(null, datedUploadFilename(PRODUCT_IMAGE_DIR, "product", file.originalname));
  },
});

// A product attachment can now be an IMAGE or a PDF (spec sheet, datasheet,
// warranty doc). The multipart field is still "image" so no route/controller
// change is needed — only what we accept into it has widened.
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "application/pdf",
];

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB — mirrored in the frontend picker

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error("Only JPG, PNG, WEBP images or PDF files are allowed"));
  }
  cb(null, true);
};

// Exported multer instance — mounted as `.single("image")` on the
// product-definitions create/update routes (see v1.stock.routes.js).
export const uploadProductImage = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// Path stored in the DB is relative (e.g. "/uploads/stock/products/2026/10/product_xxx.jpg"),
// never an absolute filesystem path — this is what the frontend prefixes with the
// backend's origin (see ASSET_BASE_URL in ProductDefinition.jsx).
export function toPublicImagePath(filename) {
  return `/uploads/stock/products/${filename}`;
}

// Deletes a previously-stored file from disk. Safe to call with null/undefined
// or a path that no longer exists — errors are swallowed (best-effort cleanup,
// should never block a request from completing).
export function deleteProductImageFile(publicPath) {
  deleteStoredUpload(PRODUCT_IMAGE_DIR, publicPath);
}

/*
  MULTER ERRORS ARE NOT NORMAL ERRORS.

  A 6MB upload rejects inside multer, BEFORE the controller's try/catch runs, so
  it never reaches errorResponseHandler and Express answers with its default HTML
  error page. The frontend then does `res.json()` on HTML and throws
  "Unexpected token '<'" — which looks nothing like "file too large".

  Mount this AFTER the stock routes in server.js so the size/type message
  actually reaches the user:

    import { multerErrorHandler } from "./helpers/stock.upload.helper.js";
    app.use("/api/v1/stock", stockRoutes);
    app.use(multerErrorHandler);   // ← before the 404 handler
*/
export function multerErrorHandler(err, req, res, next) {
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "File is too large. Maximum size is 5MB."
        : err.message;
    return res.status(400).json({ success: false, message });
  }

  // our fileFilter rejection (plain Error) — also a 400, not a 500
  if (err.message && /allowed/i.test(err.message)) {
    return res.status(400).json({ success: false, message: err.message });
  }

  return next(err);
}