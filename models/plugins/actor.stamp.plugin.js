import mongoose from "mongoose";
import { getActor } from "../../helpers/request.context.js";

const { Schema } = mongoose;

/**
 * Who created / last touched / deleted a row.
 *
 * Stored as an embedded snapshot rather than a bare id for two reasons.
 *
 * Identity: two people are called "Manoj Kumar". A name alone is ambiguous the
 * moment the company has a second one, and "created by Manoj Kumar" then means
 * nothing on a screen. Email is unique, phone is unique, role reads best — so
 * the record carries enough to name exactly one person without a lookup.
 *
 * Locality: users live in HRMS, not in this database. There is no `users`
 * collection here, so `ref: "users"` cannot populate — a bare ObjectId renders
 * as 67fcaeef… on every row and there is nothing to join to. This shape also
 * matches the audit log's own `actor` block, which has always been an embedded
 * snapshot for the same reasons.
 *
 * It is a SNAPSHOT: if someone's email changes tomorrow, older rows keep the
 * old one. That is the correct answer for a history — it records who the
 * person was at the time. For the current details, look `userId` up in HRMS.
 */
const actorSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, default: null },
    name: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    roleName: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

/** Build the snapshot from a req.user (or the older { id, name } shape). */
export const actorSnapshot = (user) => {
  if (!user) return null;
  return {
    userId: user._id ?? user.id ?? null,
    name: user.name ?? "",
    email: user.email ?? "",
    phone: user.phone ?? "",
    roleName: user.roleName ?? "",
  };
};

/**
 * Why a plugin and not a few lines per service: there are ~95 write call sites
 * across seven Mongoose methods (.save, .create, .insertMany, .findOneAndUpdate,
 * .updateOne, .updateMany, .replaceOne). Stamping by hand is 95 chances to
 * forget — and a forgotten updatedBy does not surface as an empty field, it
 * shows the PREVIOUS person, confidently wrong. Hooks make that impossible.
 *
 * deletedBy stays explicit: a soft delete is just an update setting isActive
 * false, and no hook can tell it apart from any other update.
 */
export function actorStampPlugin(schema) {
  schema.add({
    createdBy: { type: actorSchema, default: null },
    updatedBy: { type: actorSchema, default: null },
    deletedBy: { type: actorSchema, default: null },
  });

  // Ownership data scope filters on createdBy.userId — see
  // config/data.scope.registry.js. Without this index every scoped list
  // becomes a collection scan.
  schema.index({ "createdBy.userId": 1 });

  const identity = () => actorSnapshot(getActor());

  schema.pre("save", function () {
    const who = identity();
    if (!who) return; // seeder, migration, cron — nobody to record
    if (this.isNew) this.createdBy = who;
    this.updatedBy = who;
  });

  // .create() routes through save(); insertMany does not.
  schema.pre("insertMany", function (next, docs) {
    const who = identity();
    if (who && Array.isArray(docs)) {
      for (const doc of docs) {
        doc.createdBy = who;
        doc.updatedBy = who;
      }
    }
    next();
  });

  schema.pre(
    ["findOneAndUpdate", "updateOne", "updateMany", "replaceOne"],
    function () {
      const who = identity();
      if (!who) return;
      this.set({ updatedBy: who });
      // A create-by-upsert gets the creation stamp too, via $setOnInsert so it
      // is not overwritten when the document already existed.
      this.setUpdate({
        ...this.getUpdate(),
        $setOnInsert: { ...(this.getUpdate()?.$setOnInsert || {}), createdBy: who },
      });
    }
  );
}
