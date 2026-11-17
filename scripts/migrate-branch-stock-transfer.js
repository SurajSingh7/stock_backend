/**
 * One-shot migration to the Stock Transfer design of 2026-11-16: every
 * transfer starts as a request (SR-…), and the request carries the one status
 * both branches see —
 *
 *   PENDING → ON_THE_WAY → (MISMATCH → ON_THE_WAY …) → RECEIVED,  or DECLINED
 *
 * It brings either earlier shape there:
 *
 *   production (before 2026-11-13) — requests TRF-YYYY-NNNN, PENDING /
 *     COMPLETED / REJECTED, product lines with transferredQty; stock moved the
 *     moment a request was processed
 *   test data of 2026-11-13…14 — SR- requests SENT / PARTLY_SENT / CANCELLED,
 *     transfers with a status (ON_THE_WAY / REJECTED / DELIVERED /
 *     PARTLY_DELIVERED), receive-time fields, not-delivered stock
 *
 * Requests (inventory_transfer_requests)
 *   number   TRF- → SR- (TRF- names transfers); a taken number gets a free one;
 *            item movements that quote the old number follow it
 *   lines    a product line becomes a CATEGORY line (its product's leaf);
 *            transferredQty → sentQty; rejectedQty / transferredInventoryItemIds go
 *   status   COMPLETED → RECEIVED (a transfer is written for the stock that
 *            already moved, so the history shows it)
 *            REJECTED, CANCELLED → DECLINED
 *            SENT / PARTLY_SENT → by its transfer: received → RECEIVED,
 *            rejected → MISMATCH, else ON_THE_WAY
 *            NEEDS_CORRECTION (its name for a day) → MISMATCH
 *   closedAt / closedBy set on RECEIVED / DECLINED (closedBy from the last
 *            person who touched it — updatedBy — the one who finished it)
 *
 * Transfers (inventory_transfers)
 *   status dropped (the request owns it); rejectNote → problemNote; history
 *   REJECTED → PROBLEM_REPORTED, MODIFIED → CORRECTED; a PARTLY_DELIVERED one
 *   is cut down to what arrived, the rest written as a CORRECTED step;
 *   receivedQty / faultyQty / notDeliveredQty / faultNote / unit outcome /
 *   notDelivered / receiveNote / resentFrom… removed
 *
 * Stock
 *   items NOT_DELIVERED / LOST → AVAILABLE at the sending branch (where they
 *   always sat), transit cleared; movements TRANSFER_NOT_DELIVERED /
 *   BACK_TO_STOCK / MARKED_LOST → TRANSFER_REMOVED
 *
 * Stock is never moved otherwise. Run with the backend stopped and BEFORE the
 * new code starts. Dry run by default; --apply writes, after saving the old
 * documents to scripts/backups/. Idempotent.
 *
 * Run: node scripts/migrate-branch-stock-transfer.js            (dry run)
 *      node scripts/migrate-branch-stock-transfer.js --apply
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import StockCategoryService from "../services/stock.category.service.js";

const APPLY = process.argv.includes("--apply");
const NEW_STATUSES = ["PENDING", "ON_THE_WAY", "MISMATCH", "RECEIVED", "DECLINED"];
const CLOSED = ["RECEIVED", "DECLINED"];

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;
// Raw collections: the models no longer accept the old values.
const requests = db.collection("inventory_transfer_requests");
const transfers = db.collection("inventory_transfers");
const items = db.collection("inventory_items");
const movements = db.collection("inventory_item_movements");
const counters = db.collection("counters");
const defs = db.collection("product_definitions");
const cats = db.collection("categories");
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${mongoose.connection.name}\n`);

const labelOf = (it) => {
  const ids = (it.identifiers || []).map((k) => k.slice(k.indexOf(":") + 1));
  if (ids.length) return ids.join(" / ");
  const vals = Object.values(it.fieldValues || {}).filter((v) => v !== null && v !== undefined && v !== "");
  return vals.length ? vals.join(" / ") : String(it._id).slice(-6).toUpperCase();
};

// A product line → its product's category, path snapshotted.
const categoryOf = async (productDefinitionId) => {
  const def = await defs.findOne({ _id: productDefinitionId }, { projection: { categoryId: 1 } });
  const cat = def?.categoryId ? await cats.findOne({ _id: def.categoryId }, { projection: { path: 1, name: 1 } }) : null;
  return { categoryId: cat?._id || null, categoryPath: cat ? (await StockCategoryService.buildDisplayPath(cat.path || "")) || cat.name : "" };
};

/* ── Read everything first: the request plan needs the transfers as they were ── */

const allTransfers = await transfers.find({}).toArray();
const transferById = new Map(allTransfers.map((t) => [String(t._id), t]));
const orphans = allTransfers.filter((t) => !t.requestId);
if (orphans.length) {
  console.log(`WARNING: ${orphans.length} transfer(s) have no request (sent with the removed Send Stock): ${orphans.map((t) => t.transferNumber).join(", ")}`);
  console.log("         They are left as they are — no page shows them any more.\n");
}

const oldRequests = await requests
  .find({
    $or: [
      { status: { $nin: NEW_STATUSES } },
      { requestNumber: /^TRF-/ },
      { "lines.transferredQty": { $exists: true } },
      { "lines.productDefinitionId": { $exists: true } },
      { status: { $in: CLOSED }, closedAt: { $in: [null, undefined] } },
      { status: { $in: CLOSED }, closedBy: { $in: [null, undefined] } },
    ],
  })
  .toArray();

const statusFor = (r) => {
  if (NEW_STATUSES.includes(r.status)) return r.status;
  // Test data of 2026-11-16: the status was named NEEDS_CORRECTION before MISMATCH.
  if (r.status === "NEEDS_CORRECTION") return "MISMATCH";
  if (r.status === "COMPLETED") return "RECEIVED";
  if (r.status === "REJECTED" || r.status === "CANCELLED") return "DECLINED";
  if (r.status === "SENT" || r.status === "PARTLY_SENT") {
    const t = transferById.get(String(r.transferId));
    if (!t) return "RECEIVED";
    if (t.receivedAt || ["DELIVERED", "PARTLY_DELIVERED"].includes(t.status)) return "RECEIVED";
    if (t.status === "REJECTED") return "MISMATCH";
    return "ON_THE_WAY";
  }
  return r.status;
};

const plan = [];
for (const r of oldRequests) {
  const lines = await Promise.all(
    (r.lines || []).map(async (l) => {
      const out = { ...l, sentQty: l.sentQty ?? l.transferredQty ?? 0 };
      if (!out.categoryId && out.productDefinitionId) Object.assign(out, await categoryOf(out.productDefinitionId));
      return out;
    })
  );
  const status = statusFor(r);
  const t = transferById.get(String(r.transferId));
  const closedAt = CLOSED.includes(status)
    ? r.closedAt || (status === "RECEIVED" ? t?.receivedAt : null) || r.processedAt || r.updatedAt || new Date()
    : null;
  const reason = r.status === "CANCELLED" && !r.reason ? "Cancelled by the branch that asked" : r.reason || "";
  // The last person to touch a finished request is the one who finished it.
  const closedBy = CLOSED.includes(status) ? r.closedBy || r.updatedBy || null : null;
  plan.push({
    r, lines, status, closedAt, closedBy, reason,
    requestNumber: String(r.requestNumber || "").replace(/^TRF-/, "SR-"),
    needsTransfer: r.status === "COMPLETED" && !r.transferId && lines.some((l) => l.sentQty > 0),
  });
}

console.log("— Requests —");
for (const p of plan) {
  console.log(`${p.r.requestNumber.padEnd(15)} → ${p.requestNumber.padEnd(15)} ${String(p.r.status).padEnd(12)} → ${p.status.padEnd(17)}${p.needsTransfer ? " + received transfer" : ""}`);
}
console.log(`${plan.length} request(s)`);

/* ── Transfers: the shape the new code reads ─────────────────────────────── */

const EVENT_RENAME = { REJECTED: "PROBLEM_REPORTED", MODIFIED: "CORRECTED" };
const OLD_TRANSFER_FIELDS = ["status", "rejectNote", "receiveNote", "notDelivered", "resentFromTransferId", "resentFromTransferNumber"];
const reshape = (t) => {
  const off = new Set((t.notDelivered || []).flatMap((n) => (n.inventoryItemIds || []).map(String)));
  const removed = [];
  const lines = (t.lines || [])
    .map((l) => {
      const units = (l.units || []).filter((u) => !off.has(String(u.inventoryItemId)));
      const batches = (l.batches || []).filter((b) => !off.has(String(b.inventoryItemId)));
      const sentQty = l.trackingMethod === "individual" ? units.length : batches.reduce((x, b) => x + b.quantity, 0);
      const gone = (l.sentQty || 0) - sentQty;
      if (gone > 0) {
        removed.push({
          productName: l.productName, unit: l.unit ?? null, quantity: gone,
          labels: (l.units || []).filter((u) => off.has(String(u.inventoryItemId))).map((u) => u.label),
        });
      }
      return {
        _id: l._id, productDefinitionId: l.productDefinitionId, productName: l.productName, trackingMethod: l.trackingMethod,
        unit: l.unit ?? null, requestLineId: l.requestLineId ?? null, sentQty,
        units: units.map((u) => ({ inventoryItemId: u.inventoryItemId, label: u.label || "", note: u.note || "" })),
        batches,
      };
    })
    .filter((l) => l.sentQty > 0);
  const history = (t.history || []).map((h) => ({ ...h, type: EVENT_RENAME[h.type] || h.type }));
  if (removed.length) {
    history.push({ type: "CORRECTED", note: t.receiveNote || "Did not arrive", removed, by: null, byName: "", at: t.receivedAt || t.updatedAt || new Date() });
  }
  return { lines, history, problemNote: t.problemNote ?? (t.status === "REJECTED" ? t.rejectNote || "" : "") };
};
const oldTransfers = allTransfers.filter(
  (t) => t.requestId && (OLD_TRANSFER_FIELDS.some((k) => k in t) || !t.history || (t.lines || []).some((l) => "receivedQty" in l || (l.units || []).some((u) => "outcome" in u)) || (t.history || []).some((h) => EVENT_RENAME[h.type]))
);

console.log("\n— Transfers —");
oldTransfers.forEach((t) => console.log(`${t.transferNumber.padEnd(15)} ${String(t.status || "").padEnd(17)} reshaped`));
console.log(`${oldTransfers.length} transfer(s)`);

/* ── Stock ───────────────────────────────────────────────────────────────── */

const OLD_MOVES = ["TRANSFER_NOT_DELIVERED", "BACK_TO_STOCK", "MARKED_LOST"];
const strayItems = await items.find({ status: { $in: ["NOT_DELIVERED", "LOST"] } }).project({ _id: 1, status: 1 }).toArray();
const oldMoves = await movements.countDocuments({ type: { $in: OLD_MOVES } });
console.log(`\n— Stock —\n${strayItems.length} not-delivered / lost item(s) back to Available, ${oldMoves} old movement(s) renamed`);

if (!plan.length && !oldTransfers.length && !strayItems.length && !oldMoves) {
  console.log("\nNothing to do — already migrated.");
} else if (!APPLY) {
  console.log("\nNothing written — run again with --apply.");
} else {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `stock-transfer-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ requests: oldRequests, transfers: oldTransfers, items: strayItems }, null, 2));
  console.log(`\nOld documents saved: ${file}`);

  // Transfers first — a request below may write a new one in the final shape.
  for (const t of oldTransfers) {
    await transfers.updateOne(
      { _id: t._id },
      { $set: reshape(t), $unset: Object.fromEntries(OLD_TRANSFER_FIELDS.map((k) => [k, ""])) }
    );
  }

  // TRF numbers for the transfers written for old COMPLETED requests.
  const nextTrf = async (at) => {
    const y = new Date(at || Date.now()).getFullYear();
    const key = `TRF-${y}`;
    let row = await counters.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { returnDocument: "after" });
    row = row?.value ?? row;
    if (!row) {
      const top = await transfers.find({ transferNumber: new RegExp(`^TRF-${y}-\\d+$`) }).project({ transferNumber: 1 }).toArray();
      const max = top.reduce((m, t) => Math.max(m, Number(t.transferNumber.split("-")[2]) || 0), 0);
      await counters.insertOne({ _id: key, seq: max + 1 });
      return `TRF-${y}-${String(max + 1).padStart(4, "0")}`;
    }
    return `TRF-${y}-${String(row.seq).padStart(4, "0")}`;
  };

  // Seed SR-… past every number already in use, then hand a renamed request a
  // fresh number if its SR- twin is already taken.
  const srMax = {};
  for (const n of await requests.distinct("requestNumber", { requestNumber: /^SR-\d{4}-\d+$/ })) {
    const [, y, seq] = n.split("-");
    srMax[y] = Math.max(srMax[y] || 0, Number(seq) || 0);
  }
  for (const p of plan) {
    const [, y, seq] = p.requestNumber.split("-");
    if (p.requestNumber !== p.r.requestNumber && y && seq) srMax[y] = Math.max(srMax[y] || 0, Number(seq) || 0);
  }
  for (const [y, max] of Object.entries(srMax)) {
    await counters.updateOne({ _id: `SR-${y}` }, { $max: { seq: max } }, { upsert: true });
  }
  const freeNumber = async (p) => {
    if (p.requestNumber === p.r.requestNumber) return p.requestNumber;
    if (!(await requests.findOne({ requestNumber: p.requestNumber, _id: { $ne: p.r._id } }))) return p.requestNumber;
    const y = p.requestNumber.split("-")[1];
    const row = await counters.findOneAndUpdate({ _id: `SR-${y}` }, { $inc: { seq: 1 } }, { returnDocument: "after" });
    const next = `SR-${y}-${String((row?.value ?? row).seq).padStart(4, "0")}`;
    console.log(`${p.requestNumber} is taken — ${p.r.requestNumber} becomes ${next}`);
    return next;
  };

  for (const p of plan) {
    const { r } = p;
    p.requestNumber = await freeNumber(p);
    let transferId = r.transferId || null;
    let transferNumber = r.transferNumber || "";

    if (p.needsTransfer) {
      const at = r.processedAt || r.updatedAt || new Date();
      transferNumber = await nextTrf(at);
      transferId = new mongoose.Types.ObjectId();
      const tLines = [];
      for (const l of p.lines.filter((x) => x.sentQty > 0)) {
        const unitDocs = (l.transferredInventoryItemIds || []).length ? await items.find({ _id: { $in: l.transferredInventoryItemIds } }).toArray() : [];
        tLines.push({
          _id: new mongoose.Types.ObjectId(),
          productDefinitionId: l.productDefinitionId,
          productName: l.productName,
          trackingMethod: l.trackingMethod,
          unit: l.unit ?? null,
          requestLineId: l._id ?? null,
          sentQty: l.sentQty,
          units: unitDocs.map((u) => ({ inventoryItemId: u._id, label: labelOf(u), note: "" })),
          batches: [],
        });
      }
      await transfers.insertOne({
        _id: transferId,
        transferNumber,
        fromBranchId: r.sourceBranchId,
        toBranchId: r.requestingBranchId,
        requestId: r._id,
        requestNumber: p.requestNumber,
        lines: tLines,
        // The old flow moved the stock the moment it was processed.
        note: "Moved at once (before transfers needed receiving)",
        sentBy: r.processedBy || null,
        sentByName: r.processedByName || "",
        sentAt: at,
        problemNote: "",
        history: [],
        receivedBy: null,
        receivedByName: "",
        receivedAt: at,
        isActive: true,
        createdAt: at,
        updatedAt: new Date(),
      });
      console.log(`Created ${transferNumber} for ${p.requestNumber}`);
    }

    await requests.updateOne(
      { _id: r._id },
      {
        $set: {
          status: p.status,
          reason: p.reason,
          closedAt: p.closedAt,
          closedBy: p.closedBy,
          requestNumber: p.requestNumber,
          transferId,
          transferNumber,
          lines: p.lines.map(({ transferredQty, rejectedQty, transferredInventoryItemIds, productDefinitionId, productName, ...l }) => l), // eslint-disable-line no-unused-vars
        },
      }
    );
    if (p.requestNumber !== r.requestNumber) {
      await movements.updateMany({ "ref.refId": r._id }, { $set: { "ref.refNumber": p.requestNumber } });
      if (transferId) await transfers.updateOne({ _id: transferId }, { $set: { requestNumber: p.requestNumber } });
    }
  }

  if (strayItems.length) {
    await items.updateMany({ _id: { $in: strayItems.map((i) => i._id) } }, { $set: { status: "AVAILABLE", transit: null } });
  }
  await movements.updateMany({ type: { $in: OLD_MOVES } }, { $set: { type: "TRANSFER_REMOVED", status: "AVAILABLE" } });

  const leftover = await requests.countDocuments({ status: { $nin: NEW_STATUSES } });
  console.log(leftover === 0 ? "Done — every request is on a new status." : `WARNING: ${leftover} request(s) still on an old status.`);
}

await mongoose.disconnect();
