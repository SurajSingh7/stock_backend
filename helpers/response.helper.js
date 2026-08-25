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

export const errorResponseHandler = (res, error) => {
  const message = error?.message || "Internal server error";

  // Determine status code from message
  let statusCode = 500;
  if (
    message.includes("not found") ||
    message.includes("Not found")
  ) statusCode = 404;
  // Checked before the 400 group: a permission denial is neither a bad request
  // nor a server fault, and without this it fell through to 500.
  else if (
    message.includes("not allowed") ||
    message.includes("not authorized") ||
    message.includes("do not have permission")
  ) statusCode = 403;
  else if (
    message.includes("required") ||
    message.includes("immutable") ||
    message.includes("Cannot") ||
    message.includes("cannot") ||
    message.includes("Invalid") ||
    message.includes("must be") ||
    message.includes("already exists") ||
    message.includes("already active")
  ) statusCode = 400;
  else if (message.includes("already exists")) statusCode = 409;

  return res.status(statusCode).json({
    success: false,
    message,
    error: process.env.NODE_ENV === "development" ? error?.stack : undefined,
  });
};
