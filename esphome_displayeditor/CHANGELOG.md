# Changelog

## 0.3.0

Brings the web UI up to the desktop ESPHome LVGL Designer's feature set. The
domain core (`model`, `widgetschema`, `yamlexport`, `projectformat`, `idgen`)
was already a byte-identical port, so this release is purely the UI layer.

- Named style library: switch a widget between an inline style and a named
  one, assign a style from the project, and move the current inline style
  into the library ("save as named style"). The canvas resolves named styles
  for its preview, and the export emits `style_definitions:` plus a
  `styles:` reference, matching the desktop app.
- Canvas zoom: in/out, 1:1 and fit-to-view, with `Ctrl` `+`/`-`/`0`/`1`.
  Drag and resize now scale their pointer deltas accordingly.
- Reference image under the canvas as an alignment guide, with adjustable
  editor opacity. The preview is browser-only and deliberately not persisted;
  exporting local image assets stays disabled in the backend, so that
  checkbox is disabled rather than silently producing unexportable projects.
- Lock and visibility are now toggleable - from the hierarchy glyphs and from
  the property panel, kept in sync as in the desktop app.
- Export warnings from the YAML exporter and validator are shown instead of
  being discarded.
- Shortcuts: `Del` deletes, `Ctrl+N/O/S/E` for new/open/download/export.
- Fixed the workspace layout: the row heights were pinned to an exact row
  count, so an added toolbar made the project bar absorb the canvas's space;
  and the toolbar's min-content width stretched the whole column past the
  space available to it.

## 0.2.5

- Fix `ModuleNotFoundError: No module named 'backend'` at startup. The
  AppArmor profile granted `/app/** r,` but never `/app/ r,`, so the `/app`
  directory itself was not listable. Since `/app` is a `sys.path` entry,
  Python could not scan it to discover the `backend` package, even though
  every file inside it was readable. Added the missing `/app/ r,` rule.
- Replaced the temporary 0.2.4 startup diagnostics with a single targeted
  check that names this failure mode if it ever recurs.

## 0.2.4

- Debugging: added temporary `ls -la /app` / `/app/backend` diagnostics to
  `run.sh` to find out why `backend` could not be imported on the real
  Supervisor host while an identical local rebuild worked fine. This is what
  revealed the AppArmor rule fixed in 0.2.5.

## 0.2.3

- Fix `ModuleNotFoundError: No module named 'backend'` on startup under
  Supervisor: Supervisor's container creation does not reliably preserve the
  image's `WORKDIR`/`PYTHONPATH`, so `run.sh` now `cd`s into `/app` and passes
  `--app-dir /app` to uvicorn explicitly instead of relying on those alone.

## 0.2.2

- Fix container failing to start under Supervisor's read-only container
  filesystem: run `run.sh` directly as PID 1 (`ENTRYPOINT []`) instead of
  going through the base image's S6 Overlay `/init`, and drop the Bashio
  shebang, since S6's runtime state under `/run` isn't writable/executable
  in that mode.
- Trim the custom AppArmor profile to drop the now-unused S6/Bashio rules.

## 0.2.1

- Allow the Home Assistant base image's S6 `/init` process and Bashio runtime
  in the custom AppArmor profile.

## 0.2.0

- Persist designer projects in Home Assistant's backup-enabled app data.
- Protect project updates and deletes with SHA-256 revisions.
- Add schema-driven content and style property controls.
- Add nested widget creation and hierarchy display.
- Add drag resizing and persistent selection across undo/redo.
- Add browser-verified project save, load and YAML export workflows.

## 0.1.0

- Initial Home Assistant App scaffold.
- Ingress web interface and system capability API.
- Safe ESPHome YAML listing, drafts, syntax checks, diffs and publishing.
- Web-native LVGL project model, widget schema and YAML export API.
