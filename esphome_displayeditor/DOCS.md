# ESPHome Display Editor

The app combines a visual LVGL layout designer with controlled editing of
ESPHome YAML files. It is available only through Home Assistant Ingress and
does not publish a LAN port.

## Storage

- Active ESPHome files: `/homeassistant/esphome`
- Drafts and app state: `/data`
- Persistent designer projects: `/data/projects`
- Native API device registry: `/data/runtime/devices.json`
- Native API keys: `/data/runtime/native_api_keys.json` (mode `0600`)

The `/data` directory is persistent and included in Home Assistant app
backups. Active files are changed only by the explicit publish operation.

## Profiles

`native_filesystem` enables configuration reading, drafts, YAML syntax checks,
diffs, publishing and the Native API. `native_only` disables every YAML
filesystem endpoint while retaining the Native API. `read_only` keeps YAML and
Native API reads but disables all write operations. `full` adds the optional
Device Builder functions when its handshake and ESPHome version are compatible.

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

Builder operations are available only with `profile: full` and
`builder_provider: device_builder`. `builder_url` must point to a local ESPHome
Device Builder. The app accepts only ESPHome 2026.6 through 2026.8 and fails
closed for every unknown version or protocol response. Filesystem and Native
API functions remain available when the builder is unavailable.

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

Roles are hierarchical. A profile such as `read_only` still disables writes
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
