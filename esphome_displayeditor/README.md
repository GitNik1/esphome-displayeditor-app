# ESPHome Display Editor

Visual LVGL designer with an isolated read-only browser Viewer, controlled
ESPHome YAML editor, encrypted read-only Native API monitor and optional
fail-closed Device Builder integration for Home Assistant. An optional,
separately exposed MCP endpoint lets compatible AI clients inspect stored
projects, widget schemas and bindings. It is read-only by default; semantic
project changesets can be enabled independently, each behind its own scope
(a token can be limited to, say, drafting layout changes without ever being
able to publish, compile or install). Signed pagination, compatible
binding-target discovery and revision-bound YAML export/merge preview keep
large AI workflows bounded. Access-aware prompts and contextual completions
guide compatible clients through analysis, placement, imports and bindings.
Revision-bound structured layout previews and secret-free registered-device
summaries complete the bounded read-only discovery surface.
`secrets.yaml`/`secrets.yml` are never reachable through MCP, independent of
and stricter than the browser-facing `protect_sensitive_paths` setting.

In `project_write` mode, a project can also be created from inline YAML text
a client supplies directly, not only from a stored configuration. A merge
into an ESPHome configuration still only ever writes a reviewed draft; making
that draft the active YAML is a further, separately scoped and explicitly
revision-checked publish step - proposing and publishing are never the same
call. With the Device Builder enabled, three more tools let a client validate
a configuration against the real ESPHome validator and start/track a compile
or install job; installing always requires explicit confirmation and only
ever targets the configuration's own known device over OTA - no arbitrary
host, port or serial target is ever exposed. Hosts that support the MCP Apps
extension additionally get two sandboxed, dependency-free views: a rendered
canvas preview of a project surface, and a change-set review with an Apply
button that calls back through the same scoped, revision-checked tool a text
client would use - never a new capability, only a visual confirmation step.

Managed clients can use individually scoped, expiring and immediately
revocable tokens from the administrator-only System page while the original
LAN token remains a bootstrap fallback. The same page generates Claude Code
and `.mcp.json` setup snippets and can verify that the local MCP listener is
running without transmitting a credential. The source also includes an MCPB
v0.4 package for Claude Desktop that keeps the client token in a sensitive
runtime setting and bridges the local stdio transport to the LAN endpoint.
The same System page also offers an optional, administrator-only, opt-in AI
help panel built into the editor itself: it reuses the identical project- and
binding-proposal tools as external MCP clients, but every call is hard-bound
server-side to the one project (and, if given, the one configuration) open
in that session - the model is never given a parameter to choose a different
one - and it can only ever propose a change, never apply it.

Requires Home Assistant 2026.7.0+ and ESPHome 2026.7.0+.

Firmware jobs are bound to the SHA-256 revision of a recent successful
ESPHome validation. Per-configuration locks prevent parallel compile/install
jobs, while an `Idempotency-Key` makes a browser retry safe across application
restarts. The validation proof expires after 900 seconds by default and can be
configured with `validation_max_age_seconds`.

The YAML workspace provides line numbers, cursor position, search and a clear
unsaved-change marker. A three-column merge dialog compares the active file
with its saved draft and stores the manually reconciled result as a draft;
publishing remains a separate revision-protected action.

The Viewer simulates button, switch, slider and adjustable-arc interaction on a cloned
runtime project. Only a fixed set of literal LVGL show/hide/update actions is
accepted; every unsupported automation is skipped and shown in its event log.
ESPHome `pages`, `page_wrap`, `skip`, `top_layer` and `bottom_layer` are
preserved structurally and can be navigated without leaving the Viewer.

The Designer palette also provides an ESPHome-compatible **Image button**
preset. It creates the official LVGL composition of a `button` with child
`image` and `label` widgets; it never exports a non-existent `imagebutton`
YAML type. Its property section selects the normal, pressed and checked image
and generates literal `lvgl.image.update` actions for `on_press`, `on_release`
and `on_value`. A checked image automatically enables `checkable`. Existing
button shorthand text is migrated to a label child as soon as the button gets
children, because ESPHome does not allow `text:` together with `widgets:`.

```yaml
- button:
    id: image_button_1
    checkable: true
    widgets:
      - image:
          id: image_button_1_image
          src: button_off
      - label:
          text: Licht
    on_value:
      - if:
          condition:
            lambda: return x;
          then:
            - lvgl.image.update:
                id: image_button_1_image
                src: button_on
```

## Support and license

Bugs and feature requests: [GitHub Issues](https://github.com/GitNik1/esphome-displayeditor-app/issues).

Licensed under MIT with a [Commons Clause](https://commonsclause.com/)
restriction - free to use and modify, including commercially, but not to
sell or offer as a paid hosted/consulting service. See
[`LICENSE`](../LICENSE) for the full text.
