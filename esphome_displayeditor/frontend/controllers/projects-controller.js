// @ts-check

/** @typedef {import("../api/client.js").ApiClient} ApiClient */

/** @param {ApiClient} api */
export function createProjectsController(api) {
  return {
    async list() {
      const result = await api("designer/projects");
      return result.projects || [];
    },
    /** @param {string} name */
    load(name) {
      return api(`designer/projects/${encodeURIComponent(name)}`);
    },
    /** @param {string} name @param {unknown} project
     * @param {string | null} [expectedRevision] */
    save(name, project, expectedRevision = null) {
      return api(`designer/projects/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ project, expected_revision: expectedRevision }),
      });
    },
    /** @param {string} name @param {string} expectedRevision */
    remove(name, expectedRevision) {
      return api(`designer/projects/${encodeURIComponent(name)}?expected_revision=${encodeURIComponent(expectedRevision)}`, {
        method: "DELETE",
      });
    },
  };
}
