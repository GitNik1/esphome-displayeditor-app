// @ts-check

/** @typedef {{status: number, ok: boolean, json?: () => Promise<unknown>}} ResponseLike */
/** @typedef {(input: string, init?: RequestInit) => Promise<ResponseLike>} FetchLike */
/** @typedef {(path: string, options?: RequestInit) => Promise<any>} ApiClient */

/** @param {string} name */
export function encodedName(name) {
  return name.split("/").map(encodeURIComponent).join("/");
}

/** A refused read is retried once if the limit frees up within this many seconds. */
const MAX_RATE_LIMIT_WAIT_SECONDS = 3;

/** @param {number} milliseconds */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * @param {{fetchImpl?: FetchLike, pathname?: string, wait?: (milliseconds: number) => Promise<unknown>}} [dependencies]
 * @returns {ApiClient}
 */
export function createApiClient({ fetchImpl = fetch, pathname = window.location.pathname, wait = delay } = {}) {
  const appBase = pathname.endsWith("/") ? pathname : `${pathname}/`;
  /** @param {string} path @param {RequestInit} options */
  async function send(path, options) {
    const response = await fetchImpl(`${appBase}api/v1/${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const body = /** @type {{message?: string, error?: string, details?: any}} */ (
      response.status !== 204 && response.json ? await response.json().catch(() => ({})) : {}
    );
    return { response, body };
  }
  return async function api(path, options = {}) {
    let { response, body } = await send(path, options);
    // Reads only: a write refused by the limit was not applied, but repeating
    // it silently is still the caller's decision, not the client's.
    const retryAfter = Number(body.details?.retry_after);
    if (response.status === 429 && (options.method || "GET") === "GET"
        && retryAfter > 0 && retryAfter <= MAX_RATE_LIMIT_WAIT_SECONDS) {
      await wait(retryAfter * 1000);
      ({ response, body } = await send(path, options));
    }
    if (response.status === 204) return null;
    if (!response.ok) {
      const error = /** @type {Error & {code?: string, details?: unknown}} */ (
        new Error(body.message || `HTTP ${response.status}`)
      );
      error.code = body.error;
      error.details = body.details;
      throw error;
    }
    return body;
  };
}
