import StockInventoryItemMovementModel from "../models/stock.inventory.item.movement.model.js";
import { ITEM_MOVEMENT_TYPE } from "../constants/stock.enums.js";

/*
  Writes rows to a unit's timeline. Every caller is already inside its own
  transaction, so a movement is committed together with the change it
  describes — the timeline can never say a unit moved when it did not.
*/
export default class StockItemMovementService {
  static async record(rows, session) {
    if (!rows.length) return;
    await StockInventoryItemMovementModel.insertMany(rows, { session });
  }

  // Stock entering the company: an approved invoice, a posted opening entry.
  static async recordReceived(items, ref, session, { at = new Date() } = {}) {
    await StockItemMovementService.record(
      items.map((it) => ({
        inventoryItemId: it._id,
        productDefinitionId: it.productDefinitionId,
        type: ITEM_MOVEMENT_TYPE.RECEIVED,
        at,
        quantity: it.quantity ?? null,
        toBranchId: it.branchId ?? null,
        status: it.status,
        ref,
        note: it.heldByNote ? `Currently with: ${it.heldByNote}` : "",
      })),
      session
    );
  }

  static async timelineOf(inventoryItemId) {
    return StockInventoryItemMovementModel.find({ inventoryItemId })
      .populate({ path: "fromBranchId", select: "name" })
      .populate({ path: "toBranchId", select: "name" })
      .sort({ at: 1, _id: 1 })
      .lean();
  }
}
