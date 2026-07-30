# ESPHome Display Editor

The app combines a visual LVGL layout designer with controlled editing of
ESPHome YAML files. It is available only through Home Assistant Ingress and
does not publish a LAN port.

## Storage

- Active ESPHome files: `/homeassistant/esphome`
- Drafts and app state: `/data`

The `/data` directory is persistent and included in Home Assistant app
backups. Active files are changed only by the explicit publish operation.

## Profiles

`native_filesystem` enables configuration reading, drafts, YAML syntax checks,
diffs and publishing. `read_only` disables all write operations.

Native ESPHome device connections and Device Builder jobs are planned for a
later milestone and are reported as unavailable by the capability endpoint.

## Security

Only relative `.yaml` and `.yml` paths below the ESPHome directory are
accepted. Absolute paths, parent traversal, hidden paths and symbolic links
are rejected. `secrets.yaml`, `packages/` and `external_components/` are
protected from writes by default.

