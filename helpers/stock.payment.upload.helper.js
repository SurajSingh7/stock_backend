import multer from "multer";
import path from "path";
import fs from "fs";

const PAYMENT_PROOF_DIR = path.join(process.cwd(), "uploads", "stock", "payments");

if (!fs.existsSync(PAYMENT_PROOF_DIR)) {
  fs.mkdirSync(PAYMENT_PROOF_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PAYMENT_PROOF_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const unique = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
    cb(null, `payment_${unique}${ext}`);
  },
});

// A payment proof is a photo of a cheque or a bank slip, or the PDF the bank
// produced — same set the invoice attachment accepts.
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "application/pdf",
];

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB per file — mirrored in the picker

/*
  How many proofs one payment may carry. A cap rather than "unlimited": the
  files are kept forever and a runaway upload loop should fail loudly on the
  sixth file rather than quietly fill the disk.
*/
const MAX_PROOFS_PER_PAYMENT = 5;

/*
  How many routes one settlement may be split across. A cap rather than
  "unlimited": five bank entries for one invoice is already unusual, and a
  runaway form should fail loudly rather than quietly accept fifty.
*/
const MAX_SPLITS_PER_PAYMENT = 5;

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error("Only JPG, PNG, WEBP or PDF files are allowed for a payment proof"));
  }
  cb(null, true);
};

/*
  .any(), not .array(): one settlement can arrive down several routes, and each
  split carries its OWN proof — a bank slip for the NEFT, a screenshot for the
  UPI. The client names each field `split_<index>_proofs`, and the controller
  groups req.files by that name to put each file back with its own split.

  A fixed field name could not express which file belongs to which leg.
*/
export const uploadPaymentProofs = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_PROOFS_PER_PAYMENT * MAX_SPLITS_PER_PAYMENT },
}).any();

/*
  Groups whatever multer accepted back onto the split it was uploaded for.

  Named `split_<i>_proofs` on the wire. A file whose name does not parse is
  dropped rather than guessed at — attaching a bank slip to the wrong payment
  leg is worse than attaching it to none.
*/
export function groupProofsBySplit(files) {
  const bySplit = new Map();
  (files || []).forEach((f) => {
    const m = /^split_(\d+)_proofs$/.exec(f.fieldname || "");
    if (!m) return;
    const i = Number(m[1]);
    if (!bySplit.has(i)) bySplit.set(i, []);
    bySplit.get(i).push(toPublicPaymentProofPath(f.filename));
  });
  return bySplit;
}

// Path stored in the DB is relative, so moving the host or the mount point
// never invalidates what is already saved.
export function toPublicPaymentProofPath(filename) {
  return `/uploads/stock/payments/${filename}`;
}

export function deletePaymentProofFile(publicPath) {
  if (!publicPath) return;
  try {
    const filename = path.basename(publicPath);
    const fullPath = path.join(PAYMENT_PROOF_DIR, filename);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  } catch {
    // best-effort — never throw from cleanup
  }
}

export { MAX_PROOFS_PER_PAYMENT, MAX_SPLITS_PER_PAYMENT };
