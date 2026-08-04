# ESPHome Display Editor

The app combines a visual LVGL layout designer with controlled editing of
ESPHome YAML files. It is available only through Home Assistant Ingress and
does not publish a LAN port.

## Requirements

- Home Assistant 2026.7.0 or newer.
- ESPHome 2026.7.0 or newer. The generated YAML, the `lvgl:` import, and the
  optional Device Builder handshake rely on LVGL widget and action syntax
  that isn't guaranteed to exist on older ESPHome releases.

## Storage

- Active ESPHome files: `/homeassistant/esphome`
- Drafts and app state: `/data`
- Persistent designer projects: `/data/projects`
- Viewer runtime bindings: `/data/viewer_bindings`
- Native API device registry: `/data/runtime/devices.json`
- Native API keys: `/data/runtime/native_api_keys.json` (mode `0600`)

The `/data` directory is persistent and included in Home Assistant app
backups. Active files are changed only by the explicit publish operation.

## Access levels

`access_level` is the single setting controlling what the editor may do with
your ESPHome config folder and the optional Device Builder:

- `none` - no filesystem access at all; only the in-browser designer and
  (if `runtime_provider: native`) the Native API remain available.
- `read` - configuration reading, YAML syntax checks and diffs, but no
  drafts, publish, or asset writes.
- `write` - the above plus drafts, publishing and asset uploads. The normal
  day-to-day setting.
- `write_with_builder` - adds the optional Device Builder functions when its
  handshake and ESPHome version are compatible (also needs `builder_url` to
  point at a reachable Device Builder).

(Older `profile`/`read_only`/`builder_provider` options are still read and
mapped onto `access_level` automatically if `access_level` itself isn't set,
so an instance configured before this consolidation keeps working unchanged.)

`runtime_provider: native` enables read-only, encrypted ESPHome Native API
connections. Set it to `disabled` to switch off all device connections and
device API capabilities.

The repeatable Phase 3 hardware acceptance check reads its encryption key
only from the environment and never prints state values, log lines or the key:

```sh
export ESPHOME_ACCEPTANCE_HOST=display.local
export ESPHOME_ACCEPTANCE_KEY='base64-noise-psk'
python3 tools/native_api_acceptance.py
```

For the disconnect/reconnect criterion, leave the app's Devices view open,
power-cycle the same device, and verify the sequence `disconnected` ->
`connecting` -> `ready`. A wrong key must produce `auth_failed` without the key
appearing in the app log.

## Optional Device Builder backend

Builder operations are available only with `access_level: write_with_builder`.
`builder_url` must point to a local ESPHome Device Builder. The app accepts
only ESPHome 2026.6 through 2026.8 and fails closed for every unknown version
or protocol response. Filesystem and Native API functions remain available
when the builder is unavailable.

The builder exposes only validation, compile, OTA install, job inspection,
live job events and cancellation. Arbitrary builder commands and arbitrary
upload targets are not exposed. Some Home Assistant ESPHome installations do
not make port 6052 reachable to sibling apps by default; in that case the
builder status remains `unavailable` until an internal-only reachable endpoint
is configured.

## ESPHome devices

Open the **Geräte** tab as an administrator to add a device. Required values
are a local host name or IP address, the Native API port (normally `6053`) and
the ESPHome API encryption key. The corresponding device configuration needs:

```yaml
api:
  encryption:
    key: !secret api_encryption_key
```

The application requires encrypted connections and never falls back to
plaintext or legacy password authentication. It keeps one connection per
configured device, reconnects with exponential backoff, and exposes device
information, entity metadata, latest states and a bounded live-log buffer.
Phase 3 deliberately does not expose entity commands.

### Live-Daten im Viewer

For a stored project, select a `label`, `slider`, `bar`, `arc` or `switch` in the Designer.
The **Live-Daten im Viewer** section maps its text, value or checked state to
an entity of a configured ESPHome device. Labels additionally support
`{state}`, numeric formats such as `{state:.1f}`, a fallback text and a stale
timeout. Save the project before saving its binding.

The entity list is filtered to the selected target: numeric sources for
sliders, bars and arcs and boolean-capable sources for switches; labels accept every entity.
The panel shows the current value and its online, offline, unavailable or
stale state. A binding can be copied to another compatible widget or applied
to several compatible widgets in one save. Bindings whose widget was deleted,
renamed or changed to an incompatible type are listed above the property form
and can be cleaned after the project has been saved.

**Live-Werte auf Zeichenfläche** applies saved bindings to the Designer canvas
as an optional preview. This changes only DOM text and status decoration; it
does not mutate the project, enter undo history or alter exported YAML. Turning
the option off redraws the original project values.

`bar` and `arc` are add-on-only schema extensions. They use the existing
generic project model and therefore do not modify the synchronized desktop
core or project format. Their ESPHome properties are editable, import/export
round-trips them, and numeric bindings share the same filtering and safety
rules as sliders. Adjustable arcs can be changed locally in the Viewer; this
still never sends a device command.

Bindings are stored separately from `.lvgldesign` files, do not enter the
generated ESPHome YAML and never change the read-only desktop core. The Viewer
loads one filtered snapshot and then follows filtered WebSocket updates. The
Viewer endpoint omits host names, ports, key references, encryption keys and
logs. It is read-only; no Native API command is available from the Viewer.

Device records form a server-side allow-list. Browser requests contain only a
device ID; they cannot supply an arbitrary network target. API keys are stored
separately from device records, are accepted only by a write-only endpoint and
are never returned to the browser or audit log. `/data` is included in Home
Assistant backups, so those backups must be protected accordingly.

## Roles

Every authenticated Ingress user receives either `default_role` or a role
from `user_roles`. The default is deliberately `viewer`.

```yaml
default_role: viewer
user_roles:
  - user_id: "Home Assistant user UUID"
    role: publisher
```

The user UUID and effective role are visible on the System page.

- `viewer`: read configurations, projects and generated output
- `editor`: additionally save drafts and designer projects
- `publisher`: additionally publish drafts and run ESPHome validation
- `installer`: additionally compile firmware, start confirmed OTA installs,
  inspect jobs and cancel jobs
- `administrator`: all available capabilities and audit-log access

Administrators can additionally create, update and remove Native API device
records, replace their encryption keys and request a reconnect. All roles can
read device data when the Native API runtime is enabled; device control stays
disabled for every role.

Roles are hierarchical. An access level of `read` still disables writes
even for administrators.

## Designer projects

Projects can be downloaded as `.lvgldesign` files or stored directly inside
the app. Stored projects are included in Home Assistant app backups. Saving
and deleting use SHA-256 revisions so a stale browser cannot silently
overwrite a project changed by another session.

## Security

Only relative `.yaml` and `.yml` paths below the ESPHome directory are
accepted. Absolute paths, parent traversal, hidden paths and symbolic links
are rejected. `secrets.yaml`, `packages/` and `external_components/` are
protected from writes by default.

The HTTP server accepts production traffic only from the Home Assistant
Ingress proxy (`172.30.32.2`). API requests are rate-limited per authenticated
user. `api_rate_limit_per_minute` controls all API calls and
`write_rate_limit_per_minute` provides a stricter additional limit for
state-changing requests.
`request_max_size_kib` rejects oversized request bodies before parsing and
`api_timeout_seconds` bounds HTTP and Device Builder operations. Native API
and Device Builder targets accept only private addresses and local DNS names.

## Support

Found a bug or have a feature request? Open an issue on the
[GitHub repository](https://github.com/GitNik1/esphome-displayeditor-app/issues).

## License

MIT with a [Commons Clause](https://commonsclause.com/) restriction: free to
use, modify, and redistribute, including in a commercial setting, but selling
the software itself, or offering it as a paid hosted/consulting service whose
value derives substantially from it, is not permitted without a separate
agreement with the licensor. See [`LICENSE`](../LICENSE) for the full text.
