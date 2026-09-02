export const successResponseHandler = (res, data, message = "Success", statusCode = 200) => {
  const response = { success: true, message };
  if (data !== null && data !== undefined) {
    // if paginateReturn was used, it returns { data, pagination }
    if (data && data.pagination) {
      response.data = data.data;
      response.pagination = data.pagination;
    } else {
      response.data = data;
    }
  }
  return res.status(statusCode).json(response);
};

/**
 * Throw this when you want to name the status yourself. Preferred for new
 * code — it says the intent outright instead of hoping the message happens to
 * contain the right word.
 *
 *   throw new AppError("Only pending quotations can be edited", 400);
 */
export class AppError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
  }
}

// A deliberate `throw new Error("...")` from a service is a business-rule
// rejection. A genuine fault arrives as a TYPED error instead. That type, not
// the wording of the message, is what actually separates the three cases:
//
//   the caller sent something bad        → 4xx  (CastError, ValidationError)
//   the caller asked for something we
//     will not do                        → 4xx  (our own Error)
//   we broke                             → 500  (TypeError, driver failures)
const CODE_BUGS = new Set(["TypeError", "RangeError", "ReferenceError", "SyntaxError"]);

// Infrastructure. The message can carry connection strings and index names, so
// these are reported as faults and the detail stays in the log.
const INFRA_ERRORS = new Set(["MongoNetworkError", "MongooseError", "MongoServerSelectionError"]);

// A malformed id or a failed schema rule is the CALLER's problem, not ours —
// mongoose just happens to be the one that notices. Their raw messages name
// models and paths, so they are answered with something a user can act on.
const BAD_INPUT_ERRORS = {
  CastError: "One of the values sent is not in a valid format",
  BSONError: "One of the values sent is not in a valid format",
  BSONTypeError: "One of the values sent is not in a valid format",
  ValidationError: null,   // mongoose's own message is already readable
  ValidatorError: null,
};

export const errorResponseHandler = (res, error) => {
  let message = error?.message || "Internal server error";
  const name = error?.name || "Error";

  let statusCode;

  if (Number.isInteger(error?.statusCode)) {
    // An AppError (or anything else) that named its own status wins outright.
    statusCode = error.statusCode;
  } else if (CODE_BUGS.has(name) || INFRA_ERRORS.has(name)) {
    // Nobody meant to throw this. Reported as a fault, and the real message is
    // withheld — it can name internals.
    statusCode = 500;
    message = "Internal server error";
  } else if (name === "MongoServerError" || name === "MongoBulkWriteError") {
    // 11000 is a unique-index violation: a conflict the caller can resolve,
    // not a server fault. Anything else from the driver is ours.
    if (error?.code === 11000) {
      statusCode = 409;
      message = "A record with these details already exists";
    } else {
      statusCode = 500;
      message = "Internal server error";
    }
  } else if (name === "VersionError") {
    statusCode = 409;
    message = "This record changed while you were editing it — reload and try again";
  } else if (name in BAD_INPUT_ERRORS) {
    statusCode = 400;
    message = BAD_INPUT_ERRORS[name] ?? message;
  } else if (message.includes("not found") || message.includes("Not found")) {
    statusCode = 404;
  } else if (
    message.includes("not allowed") ||
    message.includes("not authorized") ||
    message.includes("do not have permission")
  ) {
    // Checked before the 400 group: a permission denial is neither a bad
    // request nor a server fault.
    statusCode = 403;
  } else if (message.includes("already exists")) {
    // Before the 400 group, or it never runs — which is exactly what used to
    // happen, leaving the 409 branch dead and duplicates answering 400.
    statusCode = 409;
  } else {
    // Default for a deliberate throw. Previously this was 500, so every
    // business rule whose wording missed the keyword list ("Only pending
    // quotations can be edited", "Not enough available stock…") was reported
    // as a server fault — 47 distinct messages across the services.
    statusCode = 400;
  }

  return res.status(statusCode).json({
    success: false,
    message,
    error: process.env.NODE_ENV === "development" ? error?.stack : undefined,
  });
};
