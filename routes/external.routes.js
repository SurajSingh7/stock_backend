import express from "express";
import { verifyExternalApiKey } from "../middlewares/stock.external.auth.middleware.js";
import { StockExternalItemRequestController as C } from "../controllers/stock.item.request.controller.js";

/*
  External API — for the NOC / broadband website (server-to-server, x-api-key).

    GET  /branches                    where stock can be requested from
    GET  /categories                  leaf categories: full path, and whether a
                                      quantity counts units or metres
    GET  /reasons                     why a RETURN / REPLACE is sent: { RETURN: [{ code, label }], REPLACE: [...] }
    GET  /subscribers/:orderId/items  what a subscriber holds (to return / replace)
    POST /item-requests               raise a request
    GET  /item-requests?orderId=      a subscriber's requests (and ?status=)
    GET  /item-requests/:id           one request, with what has moved on it
    PUT  /item-requests/:id           edit and resend a REJECTED request
    POST /item-requests/:id/withdraw  give up a REJECTED request ({ requestedBy, reason? })
                                      → WITHDRAWN, its categories free again

  POST / PUT body — common:
    {
      type: "ISSUE" | "RETURN" | "REPLACE",   // ISSUE when left out
      branchId,                               // stock goes out from / comes back to here
      subscriber: { orderId, username, serviceType, extraFields: { … } },
      requestedBy: { id, name },
      remarks
    }
  plus, by type:
    ISSUE    items: [{ categoryId, quantity }]  up to 20 CATEGORIES, each with how
                                              many — the store decides which
                                              product(s) go out; the same category
                                              twice is added up. (The older single
                                              categoryId + quantity still works.)
    RETURN   items: [{ inventoryItemId, quantity? }]   from /subscribers/:orderId/items;
                                              quantity only for a batch, all of it if left out
             reason: { code, note? }          required — a RETURN code from /reasons;
                                              note required for OTHER
    REPLACE  items: [...] as RETURN           up to 20; each item is one row: the
                                              store takes the old one back, then
                                              gives a new one of the same category
                                              and quantity in its place
             reason: { code, note? }          required — a REPLACE code from /reasons

  ISSUE is refused (409) while any of its categories is still owed to the same
  subscriber from the same branch on another open ISSUE request — the
  message names the request; resend of a rejected one is checked the same way.
  A REJECTED request blocks its categories the same way until it is resent
  or withdrawn.
  From ANOTHER branch it is allowed, and the POST / PUT answer carries
  `warnings: ["ONT … is also pending for this subscriber at <branch> on REQ-…"]`
  for the website to show.

  A request's `lines` are its outgoing items, each with requestedQty,
  issuedQty and status PENDING | PARTIAL | DONE | CLOSED (closed short by the
  store, with closure.reason). The request's own status follows from them.
  On a REPLACE each line also has returnLineId (its old item in returnLines)
  and swapStatus PENDING | RECEIVED (old back, new not yet) | PARTIAL (batch,
  part swapped) | SWAPPED | CLOSED. A replace is PARTIAL only once something
  is swapped; old items merely received leave it PENDING.

  The test simulator (Request Simulator) drives the very same service with its
  own channel, so switching to the real website changes nothing here.
*/
const router = express.Router();
router.use(verifyExternalApiKey);

router.get("/branches", C.branches);
router.get("/categories", C.categories);
router.get("/reasons", C.reasons);
router.get("/subscribers/:orderId/items", C.holdings);
router.get("/item-requests", C.list);
router.post("/item-requests", C.create);
router.get("/item-requests/:id", C.getById);
router.put("/item-requests/:id", C.resend);
router.post("/item-requests/:id/withdraw", C.withdraw);

export default router;
