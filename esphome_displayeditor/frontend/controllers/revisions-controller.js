// @ts-check

/** @typedef {import("../api/client.js").ApiClient} ApiClient */

/** @param {string} name @param {number} [id] */
function base(name, id) {
  const project = `designer/projects/${encodeURIComponent(name)}/revisions`;
  return id === undefined ? project : `${project}/${encodeURIComponent(String(id))}`;
}

/** @param {ApiClient} api */
export function createRevisionsController(api) {
  return {
    /** @param {string} name */
    list(name) {
      return api(base(name));
    },
    /** @param {string} name @param {number} id */
    read(name, id) {
      return api(base(name, id));
    },
    /** @param {string} name @param {number} id @param {string | number} [against] */
    diff(name, id, against = "current") {
      return api(`${base(name, id)}/diff?against=${encodeURIComponent(String(against))}`);
    },
    /** @param {string} name @param {number} id @param {string | null} label */
    setLabel(name, id, label) {
      return api(base(name, id), {
        method: "PATCH",
        body: JSON.stringify({ label }),
      });
    },
    /** @param {string} name @param {number} id @param {boolean} locked */
    setLocked(name, id, locked) {
      return api(`${base(name, id)}/lock`, { method: locked ? "POST" : "DELETE" });
    },
    /** @param {string} name @param {number} id @param {string | null} [expectedRevision] */
    restore(name, id, expectedRevision = null) {
      return api(`${base(name, id)}/restore`, {
        method: "POST",
        body: JSON.stringify({ expected_revision: expectedRevision }),
      });
    },
    /** @param {number} [limit] */
    async feed(limit = 50) {
      const result = await api(`designer/revisions?limit=${limit}`);
      return result.events || [];
    },
  };
}
