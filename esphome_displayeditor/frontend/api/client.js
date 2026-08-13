export function encodedName(name) {
  return name.split("/").map(encodeURIComponent).join("/");
}

export function createApiClient({ fetchImpl = fetch, pathname = window.location.pathname } = {}) {
  const appBase = pathname.endsWith("/") ? pathname : `${pathname}/`;
  return async function api(path, options = {}) {
    const response = await fetchImpl(`${appBase}api/v1/${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.message || `HTTP ${response.status}`);
      error.code = body.error;
      error.details = body.details;
      throw error;
    }
    return body;
  };
}

