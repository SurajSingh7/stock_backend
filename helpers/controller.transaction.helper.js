import mongoose from "mongoose";
import { successResponseHandler, errorResponseHandler } from "./response.helper.js";

/*
  A controller handler whose work runs in one MongoDB transaction: commit and
  answer on success, abort and map the error on failure. For writes that touch
  more than one document — a posted entry and the items it made, an issued
  request and the units it moved — which must land together or not at all.

    static create = inTransaction(log, "Entry created", (req, session) => …, { status: 201 });
*/
export const inTransaction = (log, label, work, { status = 200 } = {}) =>
  async function transactional(req, res) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const data = await work(req, session);
      await session.commitTransaction();
      log.info(label);
      successResponseHandler(res, data, label, status);
    } catch (error) {
      await session.abortTransaction();
      log.error(`Failed (${label})`, error);
      errorResponseHandler(res, error);
    } finally {
      await session.endSession();
    }
  };

// A read-only handler with the standard envelope.
export const handled = (log, label, work) =>
  async function read(req, res) {
    try {
      successResponseHandler(res, await work(req), label);
    } catch (error) {
      log.error(`Failed (${label})`, error);
      errorResponseHandler(res, error);
    }
  };

// req.user carries everything the audit trail wants; `id` is kept beside `_id`
// for older readers.
export const actingUser = (req) => (req.user ? { ...req.user, id: req.user._id } : null);
