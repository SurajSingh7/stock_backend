import express from "express";
import { verifyExternalApiKey } from "../middlewares/stock.external.auth.middleware.js";
import { StockExternalItemRequestController as C } from "../controllers/stock.item.request.controller.js";

/*
  External API — for the NOC / broadband website (server-to-server, x-api-key).

    GET  /branches                    where stock can be requested from
    GET  /categories                  leaf categories: full path, and whether a
                                      quantity counts units or metres
    POST /item-requests               raise a request
    GET  /item-requests?orderId=      a subscriber's requests (and ?status=)
    GET  /item-requests/:id           one request, with what has been issued
    PUT  /item-requests/:id           edit and resend a REJECTED request

  POST / PUT body:
    {
      branchId, categoryId, quantity,         // a CATEGORY and how many — the store
                                              // decides which product(s) go out
      subscriber: { orderId, username, serviceType, extraFields: { … } },
      requestedBy: { id, name },
      remarks
    }

  The test simulator (Request Simulator) drives the very same service with its
  own channel, so switching to the real website changes nothing here.
*/
const router = express.Router();
router.use(verifyExternalApiKey);

router.get("/branches", C.branches);
router.get("/categories", C.categories);
router.get("/item-requests", C.list);
router.post("/item-requests", C.create);
router.get("/item-requests/:id", C.getById);
router.put("/item-requests/:id", C.resend);

export default router;
