# ESPHome Display Editor

The app combines a visual LVGL layout designer with controlled editing of
ESPHome YAML files. Its web interface is available only through Home Assistant
Ingress and does not publish a LAN port by default. The optional MCP service
has its own opt-in port, remains read-only by default and does not weaken the
Ingress boundary.

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

### ESPHome-Gerätebindungen

The **ESPHome-Gerätebindungen** section is separate from the read-only Viewer
preview above. When a configuration is imported, the add-on catalogs its
id-bearing sensors and actors and offers only widget properties/events that
match the entity capabilities. Device bindings are saved in the
`.lvgldesign` project and compiled when **Als Entwurf speichern** merges the
project into that configuration.

Entity-to-widget bindings extend the entity's existing `on_value` or
`on_state` automation with an LVGL update. Widget-to-entity bindings become
widget events inside `lvgl:`. Bidirectional bindings generate both. Numeric
bindings support factor/offset, range mapping, clamping and rounding; all
bindings can carry comparisons. Repeated merges replace the matching
generated target action instead of duplicating it. Existing user actions are
kept. Because a bound entity domain must be semantically re-serialized,
comments and hand formatting inside that one top-level domain may be
normalized; the change is always written only to a draft for diff/validation
before publication.

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

## Optional MCP service

MCP is disabled by default and supports Streamable HTTP on `/mcp`. With the
default `mcp_access: read_only`, it can list projects, read project summaries,
trees, widgets and bindings, validate stored projects and expose the widget
and binding catalogs without registering write tools. Project/configuration
listings and compatible entity/widget target suggestions use signed opaque
`next_cursor` values that are bound to their query and source revision. It can
also list and read confined active or existing draft ESPHome YAML configurations;
hidden paths, traversal and symlinks remain blocked by the existing filesystem
boundary. Configuration and generated YAML content is returned in at most
65,536-character segments with `next_offset`, so the 512-KiB response ceiling
also holds for large configurations.

`secrets.yaml`/`secrets.yml` are never readable through MCP, at any access
level and for any tool that names a configuration (read, YAML export/merge
preview, configuration-draft proposals, YAML import, firmware validate/
compile/install) - `assistant_tools/secrets_guard.py` rejects the name before
any filesystem access. This is deliberately independent of and stricter than
`protect_sensitive_paths`: that setting only governs the REST/browser path
and an administrator can turn it off there, but MCP's secrets.yaml block
cannot be disabled by any app setting.

`display_binding_targets` lists project entities, exportable widget targets or
Viewer-sidecar widget targets. When an entity or widget counterpart is given,
the result is filtered through the same direction, data-type and capability
rules used during binding validation. `display_yaml_transform` exports one
exact project revision or produces a read-only merge preview against one exact
configuration revision. Merge preview preserves unrelated and unknown YAML
content and never writes a draft or active configuration.

MCP clients with prompt support can use `display_analyze_project` and
`display_review_yaml` in every access mode. In `project_write`, the server also
offers the reviewed workflows `display_create_project_from_yaml`,
`display_edit_layout` and `display_bind_entities`. Prompt and resource-template
arguments have context-aware completions for projects, configurations, widgets,
entities, direction and binding kind. Completion results are deterministic and
limited to 50 values; clients can narrow them with a partial value.

`display_preview` returns a `structured_layout_v1` projection for one exact
project revision and one surface (`root`, `page:<id>`, `top`, `bottom` or a
message-box collection). The paginated result contains hierarchy, geometry,
alignment, Grid cells, parent layout modes and a `resolved` box calculated by
the same deterministic approximation as the browser canvas. Shared regression
fixtures cover absolute/outside alignment, Grid, Flex, nesting, pages and
layers in both Python and JavaScript. It remains a structured approximation,
not a pixel-perfect LVGL rendering. A stale revision is rejected before any
projection is returned.

`display_preview` also carries the [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)
extension's `_meta.ui.resourceUri`, pointing at a bundled, sandboxed
`ui://display-editor/preview` view. On a host that negotiated MCP Apps, the
same tool call additionally renders the surface as absolutely positioned
boxes sized from `resolved`, instead of (or alongside) the plain JSON. A
client that never negotiated MCP Apps sees exactly the same structured
result as before; the `_meta` entry is additive and safely ignored. The
bundled HTML is self-contained (no external script, style, or `csp` domain is
granted), stays under the 512 KiB MCP-App-Bundle limit, and only reads data
the host already fetched via the tool call - it never gains its own network
or filesystem access.

In `project_write` mode, the same MCP Apps binding covers every tool that
creates a changeset - `display_project_propose`, `display_project_import_propose`,
`display_project_import_yaml_propose`, `display_configuration_draft_propose`,
`display_binding_propose` and `display_viewer_binding_propose` - pointing at a
second bundled view, `ui://display-editor/changeset-review`. It renders the
changeset's `preview` generically by shape (widget/issue counts and added or
removed IDs for project and binding proposals, a unified diff for
configuration-draft merges, separate tables for project vs. Viewer binding
changes) and offers an Apply button. That button calls `display_changeset_apply`
through the same MCP Apps bridge a client would use for any other tool call -
the same scope check, revision check and idempotent-apply guarantee as
calling it directly; the view adds no new capability, only a visual
confirmation step before an already-authorized action runs. A "Dismiss"
button only hides the panel locally; there is no separate server-side
discard, so an un-applied changeset still expires on its own after its TTL.

`display_device_read` lists registered ESPHome endpoints or reads one endpoint
by ID. The projection contains ID, name, host, port and only a boolean indicating
whether encryption is configured; encryption-key references and secret values
are never returned. The standalone MCP listener does not own the Native API
runtime, so it explicitly reports `live_data_available: false` and does not
expose states, logs or device controls. Device IDs are available as MCP
completions and summaries as read-only resources.

To save a merge, first read the project revision and active configuration
revision. If `display_configurations` reports `has_draft`, also call
`display_configuration_read` with `source: draft` and retain that revision.
Pass all revisions to `display_configuration_draft_propose`, review its bounded
diff and then call `display_changeset_apply`. Apply locks the project and
configuration, rechecks the project, active YAML and prior draft revisions,
and writes only the draft. A concurrent browser edit produces a conflict; the
active configuration is never published by this tool.

The explicit `mcp_access: project_write` mode additionally registers
`display_project_propose`, `display_binding_propose`,
`display_viewer_binding_propose`, `display_changeset_read` and
`display_changeset_apply`, plus `display_project_import_propose` and
`display_configuration_draft_propose`. A project proposal can add, update or
place widgets on the
root canvas, pages, top/bottom layers, message-box button collections and in
compatible parent widgets. Absolute, alignment, Flex and Grid placement is
validated semantically. Proposing never changes a project. Applying requires
the expiring change-set ID and the exact SHA-256 base revision; a concurrent UI
save produces a conflict instead of being overwritten.

`display_binding_propose` adds, updates or removes exportable project bindings
using explicit entity domain/ID, widget property/event and entity-command
fields. Existing entity and widget capabilities decide whether the operation
is compatible. Imported opaque/custom-YAML bindings are read-only over MCP.
`display_viewer_binding_propose` independently manages the add-on-only Viewer
sidecar. Applying one of these change sets requires both the unchanged project
revision and the unchanged Viewer-sidecar revision. Use the
`viewer_bindings` view of `display_project_read` to obtain the latter; it is
`null` before the first sidecar save.

To create a project from an existing configuration, call
`display_configurations`, then `display_configuration_read`, and pass its exact
revision with a new `.lvgldesign` name to `display_project_import_propose`.
The source YAML is parsed by the existing Designer importer and must have no
blocking issues. Applying rechecks the source revision and atomically refuses
an existing project name. The original YAML is never modified.

`display_project_import_yaml_propose` imports YAML a client supplies inline
(`yaml_content`) instead of a stored configuration - the same importer, issue
reporting and atomic apply as above, without a configuration name/revision.
Its argument is exempt from the usual 256 KiB tool-argument cap (up to
roughly 750 KiB, bounded by the outer 1 MiB whole-request transport limit)
but is still checked against `max_file_size` inside the handler.

`display_configuration_apply` publishes an already-reviewed draft (one
created via `display_configuration_draft_propose` and applied) as the active
YAML, given the exact active revision it was based on; a concurrent change
produces a conflict instead of being overwritten. It requires the separate
`configuration:publish` scope - a token with only `project:write` and
`configuration:draft` can propose and save drafts but not make them active,
mirroring the app's own Editor/Publisher role split. There is no separate
propose step for publishing itself: the draft's content was already reviewed
when it was created.

When `access_level: write_with_builder` is also set, three further tools are
registered: `display_configuration_validate`, `display_build` and
`display_install`. These are the only MCP tools that talk to the Device
Builder over its WebSocket API and, for `display_install`, to a real device.

`display_configuration_validate` runs the active YAML through the actual
ESPHome validator and records a proof (bound to its exact revision, expiring
after `validation_max_age_seconds`) that `display_build`/`display_install`
require before they will start a job - the same gate the app's own browser
`/validate` action uses. A stale or missing proof fails with
`validation_required` or `validation_revision_mismatch` rather than starting
a build against unvalidated YAML.

`display_build` starts a compile job (`action: "start"`) or checks its
status, cancels it, or lists recent jobs (`action: "status"|"cancel"|"list"`)
for any of this configuration's compile or install jobs - job tracking is
shared between the two operations. Starting a build is rejected while a job
for the same configuration is still active (`job_already_running`).

`display_install` flashes a validated, compiled configuration to its
already-known device over OTA. It always requires `confirmed: true` - the
same explicit-confirmation requirement the REST `/install` route enforces -
and never infers confirmation from other arguments or from a prior
`display_build` call. `port` only ever accepts `"OTA"`; arbitrary hosts,
serial ports or install destinations are not exposed by this or any other
MCP tool.

These three tools require their own scopes - `configuration:validate`,
`firmware:compile` and `firmware:install` - independent of `project:write`
and `configuration:publish`, so a token can be scoped to draft/publish
project and configuration changes without ever being able to build or flash
firmware, or the reverse.

The MCP listener runs as a separate OS process from the main app (see
`run.sh`), so it maintains its own Device Builder connection rather than
sharing the main app's; the first firmware call in a while pays a probe
round-trip before the two agree the builder is reachable.

Widget deletion/renaming are not enabled in this milestone.

To enable it safely:

1. Generate a random token with at least 32 characters.
2. Set `mcp_mode: lan`, keep `mcp_access: read_only` initially and store the
   token in `mcp_access_token`.
3. Add the hostname or IP used by the client to `mcp_allowed_hosts`.
4. In the app's **Network** settings, publish container port `8100/tcp` only
   to the required local network.
5. Restart the app and use `http://HOME_ASSISTANT_HOST:8100/mcp`.

`lan` mode is plain HTTP: the bearer token and every project/configuration
value cross the local network unencrypted. Only publish port 8100 to a
network you trust; anyone who can observe that traffic can read the token
and reuse it until it is revoked. TLS is required for the separate `remote`
mode described below, not for `lan`.

An `mcp_allowed_hosts` or `mcp_allowed_origins` entry without an explicit
port (for example `homeassistant.local` instead of `homeassistant.local:8100`)
is accepted for any port on that host, not just 8100. Add an explicit port to
pin the allowlist to exactly one port.

The configured `mcp_access_token` remains a backwards-compatible bootstrap and
recovery credential. It receives a stable audit identity derived from a
96-bit token fingerprint; neither the token nor its complete hash is exposed.
For normal clients, administrators can create separate expiring credentials
on the app's **System** page under **AI client access**. The form selects the
allowed scopes and a validity of 1 to 365 days, shows the bearer token exactly
once, generates a copyable Claude Code command plus an environment-backed
`.mcp.json`, and can revoke an active client immediately. The System page can
also probe the fixed local `127.0.0.1:8100/health` endpoint. A successful probe
confirms the listener process, but cannot prove that Home Assistant publishes
port 8100 to the client LAN. The same operations are available through the
Ingress API:

- `GET /api/v1/admin/mcp/tokens` lists non-secret client records.
- `POST /api/v1/admin/mcp/tokens` creates a credential.
- `DELETE /api/v1/admin/mcp/tokens/{token_id}` revokes it immediately.
- `GET /api/v1/admin/mcp/status` returns non-secret listener configuration.
- `POST /api/v1/admin/mcp/test` runs the bounded loopback health probe.

The create body contains `name`, `scopes` and `expires_in_seconds`. The bearer
token is returned exactly once with `Cache-Control: no-store`; the persistent
store contains only its SHA-256 hash. Supported scopes are `server:read`,
`project:read`, `configuration:read`, `device:read`, `project:write`,
`configuration:draft`, `configuration:publish`, `configuration:validate`,
`changeset:read`, `changeset:apply`, `firmware:compile` and
`firmware:install`. A token can only
receive scopes allowed by the global `mcp_access` setting, and every tool and
resource checks its request scopes server-side. Revocation and expiry are
checked on every request without restarting the MCP listener. Token creation
and revocation require the app's `administrator` role and are audit-recorded.

Example app options:

```yaml
mcp_mode: lan
mcp_access: read_only
mcp_access_token: "replace-with-at-least-32-random-characters"
mcp_allowed_hosts: "homeassistant.local,192.168.1.10"
mcp_allowed_origins: ""
```

For Claude Code on the same LAN:

```sh
claude mcp add --transport http --scope user \
  --header "Authorization: Bearer YOUR_TOKEN" \
  esphome-display-editor http://homeassistant.local:8100/mcp
```

Alternatively, a project-level `.mcp.json` can keep the secret in an
environment variable:

```json
{
  "mcpServers": {
    "esphome-display-editor": {
      "type": "http",
      "url": "http://homeassistant.local:8100/mcp",
      "headers": {
        "Authorization": "Bearer ${ESPHOME_EDITOR_MCP_TOKEN}"
      }
    }
  }
}
```

### Claude Desktop MCPB package

DXT extensions are now distributed as MCPB packages. The included MCPB v0.4
package runs a small local Node bridge so Claude Desktop can use the private
LAN endpoint even though it speaks stdio to installed local extensions. Build
the deterministic archive from the app source directory:

```sh
python scripts/build_mcpb.py
```

The results are written to
`dist/esphome-display-editor-<version>.mcpb` and the accompanying
`.mcpb.sha256` checksum. Verify the package against that checksum, then open it with Claude
Desktop or drag it onto Claude Desktop's Settings window. Its setup dialog asks
for two values. Successful CI runs also publish the same package under the
`claude-desktop-mcpb` artifact name after validating it with the pinned
official MCPB CLI.

- **MCP server URL**: for example
  `http://homeassistant.local:8100/mcp`;
- **MCP client token**: a scoped, expiring credential created under
  **System → AI client access**.

The token field is declared `sensitive` in the manifest and is passed only as
an environment value to the bridge. It is not included in the archive,
command-line arguments, stdout or diagnostics. The dependency-free bridge
accepts at most 1 MiB from stdio, accepts at most 512 KiB per remote response,
uses the server's five-minute request ceiling, forwards negotiated session,
protocol, method and tool-name headers, supports JSON and SSE responses, and terminates
the remote session when Claude closes it. Modern `2026-07-28` sessions do not
open a standing GET stream; negotiated older sessions retain the legacy SSE
notification stream.

The package does not weaken MCP scopes or the change-set workflow: widget
placement, bindings and YAML operations remain whatever the server-side token
allows. Plain HTTP is suitable only on a trusted LAN. Do not expose port 8100
to the public internet.

Claude's web and Desktop **custom connectors** connect from Anthropic's cloud,
not from the local computer. This LAN/token mode is therefore intended for
Claude Code and other clients that can reach the LAN endpoint and supply an
HTTP header. Direct Claude custom-connector support requires the later
`remote` mode with public HTTPS and OAuth; do not forward the raw port 8100 to
the internet.

Enforced MCP limits are 1 MiB per request, 512 KiB per response, at most 100
items per page, at most 1,000 compatible binding targets per scan, at most
1,000 widgets in a tree or structured preview, at most 1,000 registered devices
per scan, 50 completion values, 2,048 characters per opaque cursor, the
configured project file-size limit and
`api_rate_limit_per_minute` requests per authenticated MCP client identity;
mutating tools also consume the smaller `write_rate_limit_per_minute` bucket.
A change set accepts at most 50 operations and 8 MiB of persisted payload,
expires after 15 minutes and is limited to 100 active proposals per identity.
At most 200 unexpired records are retained per client and 1,000 globally, with
at most 64 MiB of live payload globally. Applied IDs are retained for 24 hours
so apply retries are idempotent, but their project, operation and preview
payloads are discarded immediately; operation text is limited to 4,096
characters. Host and
optional Origin allowlists provide DNS-rebinding protection. `/health` is
available without the token but returns only bounded service health and the
configured MCP access mode.

The administrator listener probe has a fixed two-second timeout and accepts at
most 4 KiB from the hard-coded loopback health endpoint. It never accepts a
caller-controlled URL, host or port and does not send an MCP credential.

At most 100 managed client tokens can be active at once. Up to 500 token
records are retained; old revoked or expired records are pruned during later
creation because their security audit events remain in the audit database.
Authenticated rate limiting is keyed by client identity. A separate global and
source-address bucket limits invalid credentials and `/health` before token
file access, so anonymous floods cannot force repeated JSON validation.

Only enable `project_write` when the app's `access_level` is `write` or
`write_with_builder`. The MCP process refuses to start for an incompatible
combination. All proposals and applies are audit-recorded; project and Viewer
sidecar writes use
the same validation, canonical project format, file-size limit, atomic save,
cross-process lock and optimistic revision check as the web application.

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
