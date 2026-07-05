import multer from "multer";
import path from "path";
import fs from "fs";

const PRODUCT_IMAGE_DIR = path.join(process.cwd(), "uploads", "stock", "products");

if (!fs.existsSync(PRODUCT_IMAGE_DIR)) {
  fs.mkdirSync(PRODUCT_IMAGE_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PRODUCT_IMAGE_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
    cb(null, `product_${unique}${ext}`);
  },
});

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error("Only JPG, PNG, or WEBP images are allowed for product images"));
  }
  cb(null, true);
};

// Exported multer instance — mounted as `.single("image")` on the
// product-definitions create/update routes (see v1.stock.routes.js).
export const uploadProductImage = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// Path stored in the DB is relative (e.g. "/uploads/stock/products/product_xxx.jpg"),
// never an absolute filesystem path — this is what the frontend prefixes with the
// backend's origin (see getAssetBaseUrl() in ProductDefinition.jsx).
export function toPublicImagePath(filename) {
  return `/uploads/stock/products/${filename}`;
}

// Deletes a previously-stored image from disk. Safe to call with null/undefined
// or a path that no longer exists — errors are swallowed (best-effort cleanup,
// should never block a request from completing).
export function deleteProductImageFile(publicPath) {
  if (!publicPath) return;
  try {
    const filename = path.basename(publicPath);
    const fullPath = path.join(PRODUCT_IMAGE_DIR, filename);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  } catch {
    // best-effort — never throw from cleanup
  }
}

