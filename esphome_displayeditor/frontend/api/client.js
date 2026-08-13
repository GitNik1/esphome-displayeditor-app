// @ts-check

/** @typedef {{status: number, ok: boolean, json?: () => Promise<unknown>}} ResponseLike */
/** @typedef {(input: string, init?: RequestInit) => Promise<ResponseLike>} FetchLike */
/** @typedef {(path: string, options?: RequestInit) => Promise<any>} ApiClient */

/** @param {string} name */
export function encodedName(name) {
  return name.split("/").map(encodeURIComponent).join("/");
}

/**
 * @param {{fetchImpl?: FetchLike, pathname?: string}} [dependencies]
 * @returns {ApiClient}
 */
export function createApiClient({ fetchImpl = fetch, pathname = window.location.pathname } = {}) {
  const appBase = pathname.endsWith("/") ? pathname : `${pathname}/`;
  return async function api(path, options = {}) {
    const response = await fetchImpl(`${appBase}api/v1/${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    if (response.status === 204) return null;
    const body = /** @type {{message?: string, error?: string, details?: unknown}} */ (
      response.json ? await response.json().catch(() => ({})) : {}
    );
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
