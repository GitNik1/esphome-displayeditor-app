export function createProjectsController(api) {
  return {
    async list() {
      const result = await api("designer/projects");
      return result.projects || [];
    },
    load(name) {
      return api(`designer/projects/${encodeURIComponent(name)}`);
    },
    save(name, project, expectedRevision = null) {
      return api(`designer/projects/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ project, expected_revision: expectedRevision }),
      });
    },
    remove(name, expectedRevision) {
      return api(`designer/projects/${encodeURIComponent(name)}?expected_revision=${encodeURIComponent(expectedRevision)}`, {
        method: "DELETE",
      });
    },
  };
}
