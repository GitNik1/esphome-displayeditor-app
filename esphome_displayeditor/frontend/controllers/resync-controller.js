// @ts-check

/** @typedef {import("../api/client.js").ApiClient} ApiClient */

/** @param {string} name */
function base(name) {
  return `designer/projects/${encodeURIComponent(name)}/source`;
}

/** @param {ApiClient} api */
export function createResyncController(api) {
  return {
    /** What the source config says that the stored project does not.
     * @param {string} name */
    preview(name) {
      return api(base(name));
    },
    /** @param {string} name @param {readonly string[]} groups
     * @param {string | null} [expectedRevision] @param {boolean} [lockPrevious] */
    apply(name, groups, expectedRevision = null, lockPrevious = false) {
      return api(`${base(name)}/apply`, {
        method: "POST",
        body: JSON.stringify({
          groups,
          expected_revision: expectedRevision,
          lock_previous: lockPrevious,
        }),
      });
    },
  };
}
