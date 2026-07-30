# Changelog

## 0.2.4

- Debugging: `run.sh` still hits `ModuleNotFoundError: No module named
  'backend'` on the real Supervisor host even with `--app-dir /app` and an
  explicit `cd /app`, despite an identical local rebuild working fine. Added
  temporary `ls -la /app` / `/app/backend` diagnostics to `run.sh` to see what
  the real container's filesystem actually looks like before import.

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
