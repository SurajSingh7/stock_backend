// Minimal fetch-based JSON client for service-to-service calls.
//
// Node ships fetch globally, so outbound HTTP needs no dependency. The one
// behaviour worth keeping from a full HTTP client is the error split: a call
// that got an answer (whatever the status) has to stay distinguishable from
// one that never reached the other service, because callers map those to very
// different responses — "your request was bad" vs "upstream is down". Raw
// fetch blurs that line: it resolves happily on 4xx/5xx and rejects only on
// transport failure. So non-2xx is raised here as an HttpError carrying the
// status, and anything that never got an answer is raised without one.

export class HttpError extends Error {
  constructor(message, { status = null, data = null, url = null, cause = null } = {}) {
    super(message);
    this.name = "HttpError";
    // Set only when the other service actually answered. `if (err.status)` is
    // the check for "they replied, and replied badly".
    this.status = status;
    this.data = data;
    this.url = url;
    if (cause) this.cause = cause;
  }
}

// Exactly one slash between base and path, and a path prefix on the base
// (http://host/api/) is preserved rather than replaced — which is what
// `new URL(path, base)` would do the moment path starts with "/".
function joinUrl(baseURL, path) {
  if (!baseURL) return String(path);
  return `${baseURL.replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

// JSON is a convention, not a guarantee — a proxy or an error page can answer
// 200 with HTML. Parse when the body claims JSON, hand back raw text when it
// doesn't, so a malformed body surfaces as unusable data rather than as a
// thrown parse error the caller would misread as a network failure.
async function parseBody(response) {
  const text = await response.text();
  if (!text) return null;
  if (!(response.headers.get("content-type") || "").includes("json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createHttpClient({ baseURL, headers: defaultHeaders = {}, timeout = 5000 } = {}) {
  async function request(path, { method = "GET", headers = {}, body } = {}) {
    const url = joinUrl(baseURL, path);
    const isJsonBody = body !== undefined && !(body instanceof FormData);

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...defaultHeaders,
          ...(isJsonBody ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: isJsonBody ? JSON.stringify(body) : body,
        // AbortSignal.timeout aborts with a TimeoutError; a caller-side abort
        // and a dead upstream both mean "no answer", which is what matters.
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      const reason = err?.name === "TimeoutError" ? `timed out after ${timeout}ms` : "request failed";
      throw new HttpError(`${method} ${url} ${reason}`, { url, cause: err });
    }

    const data = await parseBody(response);
    if (!response.ok) {
      throw new HttpError(`${method} ${url} responded ${response.status}`, {
        status: response.status,
        data,
        url,
      });
    }
    return data;
  }

  return {
    request,
    get: (path, options) => request(path, { ...options, method: "GET" }),
    post: (path, body, options) => request(path, { ...options, method: "POST", body }),
  };
}
