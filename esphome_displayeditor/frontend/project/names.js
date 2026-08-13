export function normalizeProjectName(value) {
  let name = String(value || "display").trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  name = name.replace(/^\.+/, "") || "display";
  name = name.replace(/\.(lvgldesign|ya?ml)$/i, "");
  return `${name.slice(0, 116) || "display"}.lvgldesign`;
}

