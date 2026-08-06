# Changelog

## Unreleased

## 0.16.0

- Added editable style properties, available on (almost) every widget:
  individual padding sides (`pad_top`/`pad_bottom`/`pad_left`/`pad_right`,
  alongside the existing all-sides `pad_all`), margins (`margin_top`/
  `margin_bottom`/`margin_left`/`margin_right`), `border_opa`, `border_side`
  (which edges to draw a border on) and `text_opa`. All of these were
  already recognized on import (`LVGL_STYLE_KEYS`) and round-tripped
  correctly if hand-written, but had no property-panel field to set them.
  `border_side` reuses the existing comma-separated `text_list` editor
  (the same UI already used for dropdown/roller options) rather than a new
  dedicated multi-select control - the export side already had
  `resolve_border_side()` to expand `FULL` into all four edges.

- Reworked message box editing from canvas surfaces to a dedicated dialog.
  The previous UI treated a msgbox's `buttons`/`header_buttons` as two
  extra switchable "surfaces" in the same Workspace dropdown as pages/
  layers ("Message box · Buttons" / "Message box · Header buttons") -
  user feedback was that this reads as confusing, since a message box
  isn't a screen you navigate to like a page is. Message boxes are no
  longer surfaces at all: "+ Message box" (now its own "Message boxes"
  section, separate from the Workspace toolbar) opens a dedicated dialog
  with the title/close-button/body-text fields plus two compact row lists
  for buttons and header buttons. Buttons are simplified compared to the
  previous canvas-editable version - a text field and a "closes this
  message box" checkbox (the overwhelmingly common case, `lvgl.widget.hide`
  on click) instead of full widget styling/triggers; header buttons get an
  image picker instead of text. This also fixed a side effect of the old
  design: canvas-placed buttons carried the editor's placeholder `x`/`y`/
  `width`/`height` into the exported YAML, which are meaningless (LVGL
  auto-lays out a msgbox's buttons in a row) and could make the real
  device's layout look wrong - new buttons now export with no size/position
  at all, letting LVGL auto-size them. The backend (`msgbox_support.py`)
  is unchanged - it already only cared about the WidgetNode-shaped
  dictionaries, not how the frontend produced them.
- Added editor support for `msgboxes` (message box pop-ups). Unlike every
  other widget type so far, a message box is not a widget-tree entry at
  all - it is a top-level `lvgl:` key, structurally identical to
  `pages`/`top_layer`/`bottom_layer`, for which an add-on-only adapter
  (`backend/page_support.py`) already existed. This add feature follows the
  same pattern in a new `backend/msgbox_support.py`: the shared,
  desktop-compatible designer core is untouched (`msgboxes:` stays raw
  passthrough in `Project.extra_lvgl`, exactly like pages already do), so
  this is an add-on-only feature with no `test_core_sync.py` risk. A new
  "+ Message box" button in the Workspace toolbar creates one; each message
  box gets its own settings (title, close-button toggle, body text) plus
  two switchable widget-editing surfaces - "Buttons" and "Header buttons" -
  reusing the exact same canvas/hierarchy-tree/properties-panel machinery
  already built for pages (the palette is restricted to `button` widgets
  while one of these surfaces is active, since that is the only type real
  ESPHome accepts there). In the browser Viewer, a message box renders as a
  centered modal overlay, hidden by default (matching real ESPHome
  behaviour - there is no "visible at boot" option) and toggled by the
  already-generic `lvgl.widget.show`/`lvgl.widget.hide` actions; its own
  close button (when enabled) hides it the same way. No new action type
  was needed. See LVGL-VOLLSTAENDIGKEIT-UMSETZUNGSPLAN.md, sub-plan 3b, for
  the full architecture writeup.
- Added editor support for four Phase 3 LVGL widget types: `led`, `spinner`,
  `qrcode` and `spinbox`. Unlike `buttonmatrix`/`line`/`canvas`
  (left unregistered - each needs a fundamentally different, non-flat
  editor), all four turned out to be plain flat-property widgets and needed
  no new architecture, just schema registrations plus Viewer rendering:
  `led` as a colour dot scaled by `brightness`, `spinner` as a CSS-animated
  ring (colour/spin duration from `arc_color`/`spin_time`, no SVG sweep math
  needed since it never takes drag input), `qrcode` as a labelled
  placeholder showing the encoded text (no QR-generation library is bundled,
  matching the self-contained-artifact policy), `spinbox` as a formatted
  numeric readout (`value` formatted to `decimal_places`). `spinbox` also
  gets `lvgl.spinbox.increment`/`.decrement` actions (its own action shape,
  a single id rather than an update payload) alongside the regular
  `lvgl.led.update`/`.spinner.update`/`.qrcode.update`/`.spinbox.update` in
  the allowlist.
- Added editor support for `tabview`, completing Phase 2's `tabview`/
  `tileview` sub-plan. Same synthetic-pseudo-widget architecture as
  `tileview`'s `tile` (see below): a `tab` pseudo-widget (`is_stub=True`,
  not a real ESPHome LVGL type) holds one `tabs:` list entry, using the
  pre-existing `WidgetNode.tab_title` field. `tabview` also gets two own
  top-level properties, `position` (TOP/BOTTOM/LEFT/RIGHT) and `size`
  (percentage string, e.g. `10%`). A "+ Add tab" button on the selected
  `tabview` creates tabs, and a new properties-panel section edits a
  selected tab's title. Unlike `tileview` (which has no chrome of its own
  in the Viewer - only `lvgl.tileview.select` switches it), `tabview`
  renders an actual clickable tab bar in the browser Viewer (always along
  the top regardless of `position`, no swipe gestures - the same
  deliberately-simplified MVP approach as `keyboard`/`tileview`); clicking
  a tab switches the active one and fires `on_value`/`on_change` with the
  tab id in variable `tab`, matching ESPHome's own trigger contract.
  `lvgl.tabview.select` (by zero-based `index`) is in the action
  allowlist for automation-driven switching. `meter` remains out of scope.
- Added editor support for `tileview`, the first Phase 2 LVGL widget type.
  Unlike every Phase 1 widget, a `tileview`'s tiles are a nested list of
  sub-containers (each with its own `widgets:`), not flat properties, so this
  needed a new architecture: a synthetic `tile` pseudo-widget (not a real
  ESPHome LVGL type - it never appears in the palette or in `LVGL_WIDGET_TYPES`)
  that holds one `tiles:` list entry, using the `WidgetNode.tile_row`/
  `tile_col`/`tile_dir` fields and the `WidgetSchema.is_stub`/`child_role`
  fields that turned out to already exist in the data model, unused, from an
  earlier milestone. A "+ Add tile" button on the selected `tileview` creates
  tiles (auto-picking a free column), and a new properties-panel section edits
  a selected tile's row/column/swipe direction. In the browser Viewer, only
  the active tile's children are shown (everything else stays hidden - no
  swipe simulation in this MVP); `lvgl.tileview.select` (by `tile_id` or by
  `row`+`column`) switches the active tile and is in the action allowlist.
  `tabview` (the same nested-list shape, but tabs instead of tiles) is the
  planned next step; `meter` remains out of scope for now.
- Added editor support for `textarea` and `keyboard`, completing Phase 1 of
  the LVGL widget coverage plan (7 widget types added this phase: `checkbox`,
  `arc`, `bar`, `dropdown`, `roller`, `textarea`, `keyboard`). Both are
  creatable from the palette and fully editable, including a new
  `widget_ref` property kind - a picker filled with the project's matching
  widget ids (filtered to `textarea` widgets for `keyboard`'s `textarea`
  link), the "clear assignment UI" the plan called for. In the browser
  Viewer, `textarea` renders as a native `<textarea>`/`<input>` (single-line
  vs. multi-line depending on `one_line`, with `password_mode` mapped to
  `type="password"`) that you type into directly with the host's real
  keyboard; `keyboard` itself is deliberately a non-interactive visual
  placeholder rather than a simulated on-screen key layout, since real
  typing already works on the textarea without it - building a full
  QWERTY/number/symbol layout with shift-state would be substantial effort
  for something the Viewer doesn't need. `lvgl.textarea.update`/
  `lvgl.keyboard.update` are in the action allowlist, and `text` is a
  Live-Binding target for `textarea` (reusing the same target name `label`
  already uses).
- Added editor support for two more LVGL widget types: `dropdown` and
  `roller`. Both are creatable from the palette, fully editable (including
  a new comma-separated `options` list editor, the same UI pattern already
  used for `image_ref_list`/`grid_track_list`), round-trip through YAML
  import/export, render as a native `<select>` in the browser Viewer with
  working click/keyboard selection, and support `lvgl.dropdown.update`/
  `lvgl.roller.update` actions plus `selected_index` as a Live-Binding
  target. Required a new style part (`list`, the dropdown's opened menu)
  added to `STYLE_PARTS` in `model.py` and its two independently-kept
  copies in `yamlexport.py` and `viewer.js`.
- Added editor support for three more LVGL widget types: `checkbox`, `arc`,
  and `bar` (previously import-only passthrough). All three are now
  creatable from the palette, fully editable in the properties panel,
  round-trip through YAML import/export, render and respond to clicks in
  the browser Viewer, and can be a Live-Binding target (`state_checked` for
  `checkbox`, `value` for `arc`/`bar`). `arc`/`bar` needed no
  import/export/viewer changes at all - that plumbing already existed in
  anticipation of this; only the `WidgetSchema` registration was missing.
  `checkbox` is new end-to-end, modelled on the existing `switch` widget
  (click-to-toggle, `state_checked` content property, `indicator` part for
  the tickbox colour).
- The widget palette is now grouped into "Input" and "Display" sections
  (translated) instead of one flat list, using a new `category` field on
  each `WidgetSchema` (`input`: button, switch, slider, checkbox, arc;
  `display`: obj, container, label, image, animimg, bar) - a UI-only
  grouping with no effect on import/export/validation.
- Fixed several more untranslated German strings found while touching this
  code: the properties panel's "Content"/"Style · {part}" section headings,
  the Live-Binding target dropdown's labels, and two Viewer event-log
  state messages ("active"/"inactive", "on"/"off") that had no German
  special characters and were missed by earlier sweeps.
- Changed the license from plain MIT to MIT with a Commons Clause
  restriction: free to use and modify, including commercially, but selling
  the software or offering it as a paid hosted/consulting service isn't
  permitted. Added a "Support and license" section to `README.md` and
  `DOCS.md` linking the GitHub issue tracker and the full `LICENSE` text.

## 0.15.0

- Documented the minimum required versions: `config.yaml` now declares
  `homeassistant: "2026.7.0"`, and `README.md`/`DOCS.md` note the same
  minimum for ESPHome itself, since the generated `lvgl:` YAML and the
  Device Builder handshake rely on syntax that isn't guaranteed on older
  ESPHome releases. Also fixed a leftover German preset name ("Bild-Button"
  → "Image button") in `README.md`.
- Translated the remaining example placeholder text across `index.html`
  (color/font library IDs, widget-action color/opacity fields, live-binding
  format/fallback examples, glow-line name, device dialog id/display-name,
  and the icon-picker's input/search fields) - not just the "z. B." ("e.g.")
  prefix but the example content itself where it was a German word (e.g.
  `status_gruen` → `status_green`, `Wohnzimmer Display` → `Living Room
  Display`, `Kühlerfluss` → `Coolant flow`). Left untouched: placeholders
  that were already language-neutral (hex codes, IP addresses, ID patterns,
  URLs) and the language switcher's own "Deutsch"/"English" option labels.
- Wired `frontend/viewer/viewer.js` (the read-only browser preview engine)
  up to the English UI option - the last German-only surface in the
  frontend. It now imports `t()` from `i18n.js` and uses it for the
  viewer's own event-log messages (`applyViewerAction()`'s action/condition
  results, e.g. "skipped an invalid/ambiguous action", "page/widget not
  found", "expected a boolean/numeric value"), the status line's live
  binding/warning counts, the empty event-log message, the unsupported
  widget-type warning, and the page-select "skipped" suffix. Verified the
  existing `tests/frontend/viewer_runtime.test.mjs` still passes (no test
  asserted on the literal German message text) and exercised
  `applyViewerAction()` live in the browser in English mode. With this,
  every German string in the frontend that isn't a literal example value
  (placeholder text like "z. B. status_gruen") or a language name in the
  language switcher itself now goes through `t()`.
- Translated the remaining static HTML in `index.html` that had never been
  wired to the English UI option: form labels across the theme editor,
  color/font library, background bar, surface settings, device dialog,
  merge dialog, and viewer dialog; tooltips and `aria-label`s on the
  viewer's zoom/page controls, the YAML search buttons, and several
  color/action pickers; the import-YAML dialog's mixed-markup hint (split
  into prefix/`<code>`/`<strong>`/suffix pieces so the inline formatting
  survives translation); and a handful of palette/canvas strings in
  `app.js` (the image-button and glow-line palette entries, the
  image-load-failure tooltip, the live-binding tooltip, and the
  page/widget count in the designer status line). Verified live in the
  browser that no label lost its paired `<input>`/checkbox in the process
  (a real risk when adding `data-i18n` to an element with a nested control
  instead of wrapping the text in its own `<span>`). The only remaining
  German-only surface in the entire frontend is `frontend/viewer/viewer.js`
  (the read-only browser preview's own event-log messages) - a separate,
  not-yet-started module that doesn't import `i18n.js` at all yet.
- Closed out the remaining gaps in the frontend's English UI option: the
  inline validation messages inside the widget-action, color/font-library,
  page/surface-settings, and glyph-input forms; every dynamically-rebuilt
  tooltip and button label found across the properties panel, font/color
  library, hierarchy tree, and live-binding editor (e.g. the font library's
  per-entry "Update"/"Local" action, "Web (pinned locally)" source label,
  show/hide/lock/duplicate tree icons, binding health status text); the
  import-summary and export/validation issues panels (widget/canvas/asset
  counts, unsupported-type and preserved-property notes); and the
  YAML-check/diff/ESPHome-validation output panel's result text. `app.js`
  no longer has any hardcoded German UI strings left - everything now goes
  through `t()`. Still German-only by design and out of scope for this
  round: the ~63 `toast()` calls' interpolated German sentences were
  already translated in an earlier pass, but the audit log and a handful of
  developer-facing debug/tooling strings were not investigated.
- Translated every toast notification, browser `confirm()`/`prompt()` dialog
  text with a literal German string (as opposed to a passed-through server
  error message), and the remaining designer/export status labels. `t()` now
  accepts an optional params object (e.g. `t("toast.color.saved", { id })`)
  so these messages can carry interpolated values like widget/color/font ids,
  counts, and error text.
- Extended the English UI option (language switcher in the header, persisted
  per browser) considerably beyond the initial pass: the Devices tab, the
  Configurations tab (including the YAML editor toolbar/status line and
  firmware job list), the System tab, and every dialog (YAML import, add/
  edit device, generated-YAML output, merge, icon insert, viewer) are now
  covered, on top of the always-visible shell - header, nav, palette/
  properties headings, main toolbar, project bar, font/color library
  sections, workspace surface/reference-image bars, and the properties
  panel's core fields - plus every widget-type and property label
  throughout the properties panel, which already had complete English
  translations on the backend (`widgetschema.py`) that the frontend simply
  wasn't requesting yet. Also fixed several dropdown placeholder options
  and dialog titles that are rebuilt by JavaScript on every open (e.g. the
  import file picker's first option, the device dialog's add/edit title)
  and were bypassing the static translation markup entirely. A second pass
  covered the remaining property-panel sections (image button, action/
  event builder incl. its own dynamic trigger-label lookup, live-binding
  editor, unknown-keys section) and the full glow-line editor (drawing
  toolbar, color wheel, line/glow/flow/image-sequence fields), including a
  few more dynamically-rebuilt placeholders (widget tree empty state,
  actions empty state, binding device/entity pickers) that had the same
  bypass issue. A third pass covered the firmware Builder's job list (job
  type/status fallback labels, cancel button), the Native API device status
  labels, and the Font Library's source-kind and status labels, including
  the transient states shown while a source is being checked or updated
  (checking, update available, missing locally, unchanged, check/update
  failed, downloading, updated locally). The audit log and the app's toast
  notifications are still German-only and can be extended the same way:
  `frontend/i18n.js` has the lookup/fallback mechanism and
  `data-i18n`/`data-i18n-attr` markup pattern already in place.
- Replaced the `profile`/`read_only`/`builder_provider` add-on options (8
  nominal combinations, only 4 actually distinct outcomes - "read-only" was
  reachable three different ways) with a single `access_level` setting
  (`none`/`read`/`write`/`write_with_builder`). Instances configured before
  this change keep working unchanged: the old options are still read and
  mapped onto `access_level` automatically when it isn't set.
- Added `translations/en.yaml` and `translations/de.yaml` so every add-on
  option shows an explanatory description directly in the Home Assistant
  configuration UI, automatically switching with HA's own interface
  language.
- The configuration picker (import dialog, "Konfigurationen" tab) now only
  lists YAML files directly in the ESPHome config root, not files in
  subfolders such as `archive/` (ESPHome's own dashboard archives deleted or
  renamed devices there) - those aren't active configs worth showing.
  Reading a subfolder file by its explicit path still works unchanged.
- Fixed new/renamed widget ids silently colliding with ids used by hardware
  entities elsewhere in an imported source config (`binary_sensor:`,
  `button:`, `switch:`, ...). The importer never reads those sections, so it
  had no way to know their ids were taken - auto-generating "button_1" for a
  new button could reuse the exact id an existing `binary_sensor: - id:
  button_1` already claimed, producing a config ESPHome can't compile.
  Import now scans the whole source file (not just `lvgl:`/`font:`/`image:`/
  `color:`) for every `id:` and records the rest as `reserved_ids`; new
  widget ids, manual id edits, duplication and new pages all avoid them, and
  export validation flags a collision as an error if one still occurs.
- Fixed YAML import rejecting a config with a bare, empty `lvgl:` key (e.g.
  right after enabling the component but before adding any widgets) with the
  same "no lvgl: block" error as a file missing the key entirely. YAML parses
  an empty `lvgl:` as `None`, not `{}` - it now imports correctly as an empty
  starting project.
- Added a tooltip explaining why "In App speichern"/"Löschen" are disabled
  (requires at least the "editor" role - see the add-on's `default_role`/
  `user_roles` configuration) instead of leaving the buttons silently inert.

## 0.14.0

- Added an ESPHome-compatible Bild-Button palette preset built from the
  officially supported `button` with child `image` and `label` widgets. Its
  focused property editor configures normal, pressed and checked images and
  emits literal `lvgl.image.update` actions; checked images enable the
  button's `checkable` state.
- Added graphical `src` updates for image targets to the generic button action
  editor and browser Viewer, including live press/release/toggle simulation.
  Image and label children pass Viewer pointer hit-testing through to their
  parent button so its interaction is not hidden by its own content.
- Prevented invalid ESPHome output containing both button `text:` and
  `widgets:`. Adding or reparenting a child migrates shorthand text to an
  explicit label child, while the exporter also repairs older saved projects
  defensively without losing their text.

## 0.12.0

- Bound compile and OTA install jobs to a persistent proof of a recent,
  successful ESPHome validation of the exact active SHA-256 revision. A
  changed, expired or never-validated configuration now fails closed before
  the Device Builder receives a firmware command; the proof lifetime is
  configurable with `validation_max_age_seconds`.
- Added persistent `Idempotency-Key` handling and a per-configuration server
  lock. Browser retries return the original job after a response loss or app
  restart, while different parallel compile/install requests receive a stable
  `job_already_running` conflict instead of starting a duplicate job.
- Expanded the YAML workspace with synchronized line numbers, cursor position,
  search navigation, tab indentation and an explicit unsaved-change marker.
  Switching files warns before discarding local edits.
- Added a manual three-column merge dialog for the active configuration,
  stored draft and reconciled result. The result is saved as a draft and still
  requires the existing revision-protected publish step.
- Added recovery coverage for persistent validation/idempotency state,
  application restarts, corrupted workflow SQLite files and interrupted atomic
  draft/publish writes. A damaged workflow database is archived and recreated
  empty, deliberately requiring a fresh validation.

- Pages and LVGL top/bottom layers are now fully editable designer surfaces,
  not Viewer-only structures. The workspace selector supports creating,
  renaming, reordering and deleting pages, editing `skip`/`page_wrap`, page
  layout/style/passthrough mappings, and using the normal canvas, hierarchy,
  property, duplicate, delete and drag/drop tools for every surface. Edited
  surfaces are folded back into `extra_lvgl` before validation, storage,
  project download and YAML export while the synchronized desktop core stays
  unchanged.

## 0.11.1

- Reworked icon handling end to end:
  - Added a one-click "MDI-Icons hinzufügen" preset to the Font Library that
    registers the Pictogrammers MDI webfont (Apache 2.0) as a fixed library
    entry and immediately pins a local, hash-verified revision - no manual
    URL entry needed.
  - Every Label/Button `text` field now has an "Icon einfügen" button that
    opens the MDI catalog directly at the text you're editing, auto-registers
    the MDI font on first use, assigns it as that widget's `text_font`, and
    inserts the chosen glyph at the cursor. The old glyph editor lived only
    in the Font Library and applied its MDI name matching (`mdi:home`, catalog
    browsing) to whatever font was being edited there, including Google Fonts
    or plain text TTFs that don't contain those glyphs at all - it could
    silently swap literal text like "home" for an unrelated icon character.
  - The Font Library's manual "Glyphen (optional)" picker is gone. Glyph
    restriction is now scoped to the MDI icon font only: its export is
    derived automatically from every widget's actual static text using it
    (unioned with whatever an imported YAML already had, never narrowed) -
    no more remembering to keep a glyph list in sync by hand. Every other
    library font (Google Fonts, uploaded/linked TTFs, ...) always exports
    complete/unrestricted, even if it previously carried an explicit
    `glyphs:` from an import - restricting an ordinary text font risks
    cutting off characters some other part of the config still needs, a
    risk that doesn't apply to the MDI font's fully-known icon usage.
  - Fixed export validation rejecting local font/image paths inside the
    add-on's own confined `images/`/`fonts/` asset folders (the destination
    of the TTF/OTF upload button and the new MDI quick-add) as if they were
    arbitrary, unverified host paths.
- Replaced the curated 36-icon MDI catalog bundled with the glyph editor
  with the complete Pictogrammers Material Design Icons set (7447 icons,
  version 7.4.47), generated directly from the official
  MaterialDesign-Webfont build's own `scss/_variables.scss` so codepoints
  are guaranteed to match the webfont this app already loads.
- Webfonts use `refresh: never` by default and can now be checked manually for
  upstream changes. The editor downloads an approved update into a
  hash-versioned local `fonts/` file, records ETag/hash metadata, and exports
  that fixed revision for reproducible and offline ESPHome builds.
- The Font Library now includes a visual glyph editor. It accepts literal
  characters, `U+...`, `0x...`, ESPHome `\\U...` escapes and names from a
  bundled, searchable MDI catalog; selected glyphs can be checked against the
  actual cmap of a local TTF/OTF before export.
- Fixed the glyph catalog preview so it loads the local file or webfont URL
  currently entered in the form, including unsaved entries. Remote font
  previews are allowed by the frontend security policy, and loading or source
  errors are shown explicitly instead of rendering ambiguous missing-glyph
  boxes.

- Added a Font Library (Schriftbibliothek), mirroring the existing Color
  Library: add/edit/delete a project font (builtin LVGL bitmap font, Google
  Fonts, local file path, or web URL), with size/bpp/glyphs. Google Fonts
  gets a real dropdown of ~100 curated families plus a manual fallback for
  anything not listed (fetching the full live catalog would need a new
  outbound API call this add-on doesn't otherwise make). The "Datei" source
  can upload a `.ttf`/`.otf` directly instead of only typing a path - a new
  `POST /api/v1/designer/assets/fonts` endpoint (`designer.asset_write`,
  same capability as the existing baked-image upload) writes it into a
  dedicated `fonts/` folder, content verified by the font's own sfnt magic
  bytes rather than trusting the filename, mirroring `write_image_asset`'s
  containment exactly. `text_font`
  fields across the properties panel (and a new project-wide "Standardschrift"
  picker) get a datalist of library font ids for autocomplete - still a free
  text field, since a builtin LVGL font name (`montserrat_16`) is valid
  without ever being declared in the library, the same trade-off the color
  datalist already makes. Deleting a font that's still referenced clears
  those references (there's no literal-value fallback for a font id the way
  there is for a color's hex value) after a confirmation showing the
  reference count.

- Fixed: a `color:` entry defined via `red`/`green`/`blue` percentages
  instead of `hex:` (both are valid ESPHome syntax) used to import as plain
  white - `_import_colors` only ever read `hex:` and silently defaulted to
  `FFFFFF` otherwise, losing the colour entirely. RGB components are now
  converted to an equivalent hex value. A `white` channel has no RGB-hex
  equivalent in this model and is still dropped, but now with an import
  notice instead of silently.

- Image entries' `type:` (ESPHome's colour format - `RGB565`, `RGBA`, ...)
  is now a modeled, editable field instead of an opaque preserved key. A
  "Bildformat" dropdown appears next to any image picker in the properties
  panel; picking an image and setting its format edits the shared library
  entry directly, so it applies everywhere that image is referenced. Fixes
  the last remaining "preserved but not editable" gap for images from
  `p4_86_panel.yaml`-style imports - all 13 of that fixture's images used
  to be flagged as having an unmodeled key.

- Horizontale und vertikale LVGL-Farbverläufe werden jetzt auch auf der
  Designer-Zeichenfläche dargestellt, einschließlich Farb-IDs und Deckkraft.

- Die Textausrichtung LEFT, CENTER, RIGHT und AUTO wird für Labels und
  andere Textwidgets jetzt auch auf der Designer-Zeichenfläche korrekt über
  die gesamte Widgetbreite dargestellt.

- Der Designer besitzt jetzt eine Farbbibliothek mit ESPHome-ID, Hexfeld,
  Farbwähler, Bearbeiten und Löschen. Alle dynamischen Farbfelder sowie die
  Button-Aktionen bieten diese IDs zur Auswahl an; Umbenennen aktualisiert
  Verwendungen und Löschen kann sie sicher durch den bisherigen Hexwert
  ersetzen.

- Buttons besitzen jetzt einen grafischen Aktionseditor für Klick, Drücken,
  Loslassen und Schalterzustände. Zielwidgets lassen sich damit im Editor
  anzeigen, ausblenden oder zur Laufzeit in Text, Farbe, Rahmen und Deckkraft
  verändern; der Browser-Viewer simuliert dieselben Aktionen und sicheren
  Ein/Aus-Bedingungen.

- Button-Zustandsfarben sind jetzt im Designer unmittelbar sichtbar: Die
  Zustände `pressed` und `checked` haben verständliche deutsche Bezeichnungen
  und Hilfetexte, die ausgewählte Zustandsfarbe wird direkt auf der
  Zeichenfläche dargestellt und der Viewer kennzeichnet einrastende Buttons
  barrierefrei mit `aria-pressed`.

- Gap-closing pass against the real `p4_86_panel.yaml` fixture (a hand-written
  device config with a `theme:` block, an icon webfont, grid backgrounds and
  a time-literal animation duration - everything the importer/canvas had no
  coverage for yet):
  - Fixed: a `font:` entry with `file: {type: web, url: ...}` stores its URL
    in `web_url`, not `file_path` (which stays empty for that source kind).
    `ensureFontLoaded()` only ever checked `file_path`, so a webfont icon
    button's custom glyphs silently never loaded - now `web_url` is accepted
    too.
  - Fixed: `bg_image_src` had a schema entry and a properties-panel field but
    was never actually drawn - `renderWidget()` only ever applied
    `bg_color`. Containers with a background image now show it (`cover`,
    centered - an approximation, not pixel-exact LVGL scaling).
  - Fixed: `lvgl.theme:` (a per-widget-type default style, optionally with
    per-state overrides) imported/exported correctly already but had no
    editor and, more importantly, was never applied to the canvas - a
    themed widget with no style of its own rendered as if it had none at
    all. New collapsible "Theme" panel (palette sidebar) edits a theme entry
    per widget type/state; `effectiveStyleTree()` now merges the type's
    theme under the widget's own style (own style wins key-by-key).
  - Fixed: `duration: 500ms` (ESPHome's time-literal shorthand, also `1s`/
    `2min`/`1h`) was stored as the literal string `"500ms"` instead of a
    number of milliseconds. A small parser now converts known
    duration-like keys (`duration`, `anim_time`, `anim_duration`) at import.
  - Fixed: re-exporting an imported web font dropped its preserved
    `refresh:` (and any other `file:`-level extra key) - `build_font_block`'s
    dict-merge skipped it because `"file"` was already a top-level key of
    the built entry, so the generic extra-merge never looked inside it.

## 0.11.0

- Fixed the configuration sidebar so long file lists remain inside the
  available desktop/mobile viewport and scroll independently below the fixed
  heading. The narrow layout no longer keeps the inactive Designer in the
  document flow or pushes the configuration view below the viewport.
- Fixed the Designer grid row so wrapped toolbars no longer enlarge the
  workspace beyond a short browser or Home Assistant Ingress viewport and
  cut off its lower controls.
- Frontend assets are revalidated and carry the app version in their entry
  URLs so an update cannot leave an obsolete layout in the browser cache.
- Added the first read-only browser Viewer: projects open in a full-screen,
  isolated preview using the same layout engine as the designer, with fit,
  zoom, rotation and reset controls. The viewer renders the eight currently
  supported widget types plus GlowLine layers and cannot mutate the editor
  project or invoke a write API.
- Added safe Viewer interactions: buttons render pressed/checked/focused
  states, switches and sliders keep isolated runtime values, and a strict
  allowlist simulates show/hide and literal widget updates. Unsupported
  automations are skipped and recorded in the Viewer event log.
- Viewer styling now applies named plus inline overrides in ESPHome priority,
  including switch/slider parts, state styles, font sizing, padding, gaps,
  background/shadow opacity and gradients.
- Added an add-on-only structured view of ESPHome LVGL pages and top/bottom
  layers while keeping the shared desktop core unchanged. Import/export
  preserves page layout, styles, skip/page-wrap settings and layer widgets;
  the Viewer adds page selection and previous/next controls plus safe
  `lvgl.page.show/next/previous` action handling.
- Added read-only Native API data bindings for Viewer labels, sliders and
  switches. Bindings are revision-protected add-on sidecars, runtime snapshots
  and WebSocket events expose only filtered entity/state data, and disconnects
  or stale values use the configured label fallback without enabling device
  commands.
- Improved the binding editor with target-compatible entity filters, current
  value plus online/offline/stale health, copy/paste and multi-widget apply,
  orphan detection/cleanup, and an optional DOM-only live preview on the
  Designer canvas.
- The canvas can now show an imported config's own local images and fonts,
  not just http(s) URLs. A new read-only `GET
  /api/v1/designer/assets/read/{path}` endpoint (`designer.asset_read`
  capability, available to any viewer, works in the read-only profile)
  serves a file from anywhere under the config root - confined by the same
  traversal/symlink checks as every other filesystem read, just not confined
  to a single flat folder the way the baked-image write endpoint is, since
  an imported config can put assets anywhere. Images load through this
  endpoint the same way an http(s) URL already did; fonts are loaded via the
  `FontFace` API and registered under a deterministic per-font-id family
  name, so both the visible canvas label and its layout-engine text
  measurement (previously always a generic sans-serif guess) pick up the
  real typeface once it loads.
- Added add-on-only `bar` and `arc` schemas without changing the synchronized
  desktop core. Both widgets render in Designer and Viewer, round-trip through
  ESPHome YAML, support numeric Native API bindings and safe local update
  actions; adjustable arcs also simulate value changes in the Viewer.
- Added deterministic bar/arc geometry checks and a browser acceptance harness
  covering visual output and literal-text injection. Frontend responses now
  include a restrictive Content Security Policy and Permissions Policy.

## 0.10.0

- Added the optional, fail-closed ESPHome Device Builder backend for ESPHome
  validation, compile/install jobs, cancellation and live job events.
- Added Device Builder version/handshake compatibility checks and the `full`
  profile. Unknown versions keep filesystem and Native API features available
  while all builder operations remain disabled.
- Added request-size and operation-timeout limits, stricter local-device host
  validation, consistent backend reporting and extended builder audit fields.
- Added a repeatable encrypted Native API hardware acceptance tool.

## 0.9.11

- The hierarchy tree gained three things:
  - Drag-and-drop reordering and reparenting. Dropping on the middle of a
    container nests the dragged widget/line inside it; dropping on the top
    or bottom half of an item moves the dragged item to be that item's
    sibling (reordering also changes stacking order on the canvas/export,
    since tree order is widget array order); dropping in empty tree space
    moves the item to the top level. Dropping a widget on a glow line (or
    vice versa) adopts that line's parent container. A container can't be
    dropped into its own descendant.
  - A duplicate button next to hide/lock. Duplicating a container deep-clones
    its whole subtree with freshly generated, collision-free ids; duplicating
    a glow line clones its geometry and style under a new id.
  - The hidden-state icon is now a proper crossed-out eye (Feather Icons'
    "eye"/"eye-off" glyphs as inline SVG) instead of the "see-no-evil monkey"
    emoji, for both widgets and glow lines.

## 0.9.10

- Fixed: a glow line created from the "Bausteine" palette wasn't actually
  movable. It used to start as an empty placeholder in an open-ended "draw"
  session (add points by clicking, Enter/double-click to finish) - until
  finished, clicking its body just added another point instead of dragging
  it, unlike every other widget which is instantly draggable the moment
  it's placed. A new line now comes with a ready-made default segment and
  starts in the selection tool, so it's draggable (body or point handles)
  immediately, the same as any other widget. The old click-to-place-points
  workflow is still available: selecting a line and picking the "Linie
  zeichnen" tool now appends further points to that line instead of only
  ever starting a brand new one.
- Fixed: typing new x/y coordinates into a container's property fields moved
  the container but left any glow line nested inside it behind - only
  dragging the container translated its nested lines' points (0.9.7), the
  property-panel input fields didn't. Both now apply the same translation.

## 0.9.9

- Glow lines can now be locked, the same as widgets: a second tree glyph
  (lock icon) next to the hide toggle from 0.9.8. Locking a line disables
  dragging its body and its point handles (the handles aren't even drawn,
  matching how a locked widget doesn't get a resize handle) - the line stays
  selectable and deletable, only the drag gesture is blocked, the same
  asymmetry widgets already have. A locked line nested in a container still
  moves along when the container itself is dragged, same as a locked child
  widget would. New project format field `GlowStroke.locked` (defaults to
  `false`, older saved projects load fine).

## 0.9.8

- Glow lines can now be hidden, the same as widgets: the hierarchy tree entry
  for a line gets an eye-glyph toggle. Hiding a line skips it entirely when
  drawing the canvas (not just dimmed, matching the 0.9.2 widget behavior)
  but it stays selectable via the tree and still bakes normally if
  explicitly selected and baked - `hidden` is an editor-preview toggle, not
  an "exclude from export" flag. New project format field
  `GlowStroke.hidden` (defaults to `false`, older saved projects load fine).

## 0.9.7

- Fixed: a glow line nested inside a container (0.9.6) rendered behind it and
  was invisible whenever the container had its own background color. All
  glow lines used to share one canvas layer painted below every widget -
  fine for a top-level decorative line, but a widget's "children" here are
  really just flat siblings painted in order, so a line meant to sit inside
  a container needs to paint after that container's own background, not
  before. There are now two glow-line layers: one below all widgets (for
  lines with no parent, unchanged), one above all widgets (for lines nested
  under a container). Not a perfect per-container stacking order, but it
  guarantees a nested line is never hidden by its own parent.

## 0.9.6

- Glow lines can now be nested inside a container: creating a line while a
  container widget is selected (same rule as adding any other widget) nests
  it under that container in the hierarchy tree. Dragging the container
  moves the nested line's points along with it. Baking the line (G5) appends
  the resulting image/animimg widget to the container's `children` instead
  of the screen's top level, with coordinates converted to be relative to
  the container - so the exported YAML nests the widget correctly. A
  line's points always stay in absolute canvas coordinates internally
  (`parent_id` is purely an association, not a coordinate space change);
  deleting a container that had nested lines un-nests them back to
  top-level instead of leaving them pointing at a widget that no longer
  exists. New project format field `GlowStroke.parent_id` (empty string =
  not nested), read with a default so older saved projects still load.

## 0.9.5

- Fixed: dragging or resizing a container left its children behind on the
  canvas. Position/size fields on the container itself updated, but child
  widgets are absolutely positioned as separate DOM nodes and only had their
  box recomputed on the next full render, so they visually stayed put during
  the gesture (and looked "detached" even after releasing the mouse). The
  drag/resize handlers now re-run the layout on every move and update every
  affected node's box directly - children, and any sibling anchored to the
  moved widget via `align_to`, now track live.
- Also fixed a related gap: resizing a container whose children stretch to
  fill it (grid `STRETCH`, flex `flex_grow`) now updates those children's
  size live during the drag instead of only after the next re-render.

## 0.9.4

- Glow lines are now created straight from the "Bausteine" palette, the same
  way any other widget is added, instead of via a separate "Widgets" /
  "Glow-Linien" mode-toggle plus a "+ Linie" button. Clicking a widget
  button while a line is being edited switches back to widgets mode
  automatically. The line-editing toolbar (Auswahl / Linie zeichnen /
  Vorschau / Löschen) still appears while a line is active, now with a
  "✓ Fertig" button to return to widget editing explicitly.

## 0.9.3

- Designer view is now usable on phone-width screens (≤700px): a new
  three-way pane switcher ("Bausteine" / "Canvas" / "Eigenschaften") stacks
  the palette, canvas, and properties panels instead of shrinking them into
  unusable columns. Configurations and Devices views get the same
  list/detail stacking pattern, with a "back to list" button that only
  shows once a detail is open. Resize handles, glow-line handles, and tree
  glyphs also got larger touch targets (~24x24px hit area). The existing
  900px column-shrink breakpoint is unchanged for tablet-width windows.

## 0.9.2

- Widgets marked "hidden" now render fully invisible on the canvas (opacity
  0) instead of translucent (opacity 0.35). The dimmed preview made a hidden
  widget's on-device appearance hard to judge; a hidden widget is still
  selectable via the hierarchy tree and its eye-glyph.

## 0.9.1

- Glow lines now appear in the hierarchy tree, in their own "Glow-Linien"
  section below the widgets - clicking one switches to line-editing mode and
  selects it, the same way clicking a widget entry switches back. Previously
  a line could only be selected by clicking it on the canvas after manually
  switching modes first.

## 0.9.0

Glow lines: draw animated flow lines directly in the designer instead of
producing them in the separate GlowLine Editor desktop tool and hand-copying
the resulting YAML snippet into a config.

- Ported GlowLine Editor's geometry (filleted polylines, Catmull-Rom splines),
  multi-pass stroke glow, and flow markers (arrows/dashes) from Qt to Canvas
  2D (`frontend/glowline/`). Measured against the original Qt renderer running
  headless (`tools/glowline_reference/`): path length within 0.03%, sampled
  points within 0.033px, tangent angles within 0.6°, and rendered pixels
  within a mean channel error of 1.43/255.
- New "Glow-Linien" canvas mode with its own tool (`P` draw / `V` select):
  place points with Ctrl/Shift angle snapping, close a line into a ring,
  drag the whole line or a single point, insert a point on double-click,
  delete one via right-click. Undo/redo now restores line selection, not
  only widget selection.
- Line/glow/flow property panel and an RGB565 colour wheel - every pixel of
  the wheel is quantised, so the picker shows what an RGB565 display actually
  reproduces, not a continuous desktop colour.
- "Als Bilder + Widgets anlegen" renders the flow animation into a cropped,
  seamlessly-looping PNG sequence (quantised to RGB565), uploads it, and adds
  a matching `image` + `animimg` widget pair - the same shape as the
  hand-written snippet this replaces (`src:` list, `duration`, `repeat_count:
  forever`, `auto_start`).
- New write path, used only for this: `POST /api/v1/designer/assets/images`
  writes a baked frame straight into the ESPHome config's `images/` folder.
  Unlike every other write in this add-on, it is not a draft - the safety
  margin comes from confinement instead: one flat subfolder, `.png` only,
  content verified by its actual magic bytes rather than trusted by name, and
  refusing to overwrite a file that is not itself already a PNG. Requires the
  editor role and is unavailable in the read-only/native-only profiles.
- Project format version 3 (`Project.glow_strokes`); older builds refuse such
  a file instead of silently dropping the lines.

Verified end to end in a running container with a real mounted ESPHome
folder: a drawn three-point line with flow enabled baked into 5 PNGs (1
static + 4 frames) written to `images/` on the host, an `image` + `animimg`
widget pair at the cropped position, and an export whose `image:`/`animimg:`
block matches the shape of the original hand-written GlowLine output.

Known gaps: line-body hit-testing uses the control polygon rather than the
rendered curve (slightly generous near a large corner radius or a spline
bulge); the flow preview (`▶`) runs at a fixed speed independent of the
export timing; and the desktop `esphome-lvgl-designer` gained the same
`glow_strokes` field on its shared project model but no drawing tool for it -
it can load, hold and re-save a project containing lines, just not create or
edit them.

## 0.8.0

Phase 3 ESPHome Native API runtime:

- Add encrypted, read-only Native API connections through `aioesphomeapi`.
- Add a persistent server-side device allow-list and separate write-only
  storage for 32-byte Noise encryption keys.
- Add connection monitoring with bounded exponential reconnect, stable error
  codes and unavailable marking for cached states after disconnects.
- Add device information, entity, latest-state and bounded live-log APIs plus
  an Ingress-compatible WebSocket event stream with backpressure.
- Include the Uvicorn WebSocket runtime required to serve that event stream
  from the production container.
- Add administrator-only device, key and reconnect operations with audit
  events; entity commands remain unavailable.
- Add a Geräte view for connection status, configuration, metadata, entities,
  states and sanitized logs.
- Allow the UDP traffic required for `.local` mDNS name resolution while
  retaining the Ingress-only HTTP boundary.
- Build-test both advertised app architectures (`amd64` and `aarch64`) in CI.

## 0.7.0

Phase 4 security and roles:

- Add hierarchical viewer, editor, publisher, installer and administrator
  roles with per-user assignments from Home Assistant app options.
- Return user-specific capabilities and enforce every write operation in the
  backend, independently from disabled frontend controls.
- Reject traffic that does not originate from the Home Assistant Ingress
  proxy and stop trusting forwarded client headers in Uvicorn.
- Add per-user API and write rate limits with stable `429` responses.
- Restrict audit-log access to administrators and record rejected
  authorizations plus draft save/delete events.
- Add `nosniff`, `no-referrer` and API `no-store` response headers.

## 0.6.0

The constructs an imported config is built from are now editable, not just
preserved and drawn.

- **Layout** section: switch a container between none, flex and grid, and edit
  the grid tracks (`40, FR(1), CONTENT`) or the flex flow and alignment.
  Only the options belonging to the selected type are shown, so grid tracks
  cannot be set on a flex container.
- **Grid cell** section, shown only when the parent actually lays out a grid:
  row and column, spans and per-cell alignment.
- **State** selector on the style section. Picking `pressed` points every
  style control at that state's overrides; the base style is left alone, and
  the heading says which state is being edited.
- **Preserved keys** are listed read-only on the widget that carries them, so
  passthrough is visible rather than a silent black hole.
- Editing layout or placement recomputes the whole canvas, since it moves
  everything else in the container too.
- `animimg` has a palette entry and icon.

Verified against the imported test config: moving a status bar from grid
column 1 to 0 and rewriting its tracks from `[200, FR(1), 200]` to
`[100, FR(1)]` repositions it and its children on the canvas immediately, and
the export writes exactly those values back while leaving everything else -
`bg_image_src`, the container's own cell defaults, the automations - intact.
Editing the `pressed` colour of a button writes a `pressed:` block and leaves
the base `bg_color` untouched.

## 0.5.0

- The canvas now resolves layout instead of only reading stored coordinates.
  A hand-written config places widgets by grid cells and flex flow and lets
  LVGL derive their sizes, so an imported interface used to stack at the
  origin. `frontend/layout.js` computes grid tracks (pixels, `FR(n)` and
  `CONTENT`), cell spans and alignment, flex flow with wrapping, growth and
  the three alignment axes, and absolute placement including `align`/
  `align_to`, which the canvas ignored entirely before.
- Intrinsic sizes come from the project itself where possible: a label is
  measured with the size of the font it actually references, and an image
  uses its declared `resize:` rather than a guess.
- The screen's own layout is honoured. In the test config the 720x720 root
  grid belongs to `lvgl:` itself, not to any widget, so top-level widgets are
  laid out by it.
- A widget positioned by a parent layout is no longer draggable and has no
  resize handle: writing x/y there produces an offset fighting the layout
  rather than a move. Its position is edited through the grid cell instead.

Checked against the real config: of 31 widgets only two now sit at the
origin - and both belong there. Spot-checked positions match the source
design, e.g. a status-bar label centred in the first of three `[200, FR(1),
200]` columns lands at x=159, and an absolutely placed animation inside a
container at (80,40) lands at its own (274,54) plus that origin.

This is an approximation, not an emulation: LVGL computes on the device with
font metrics we do not have. Verify the real arrangement with an SDL preview.

## 0.4.0

Import an existing ESPHome configuration and edit its LVGL interface.

- New "YAML importieren" dialog: pick one of the configurations already on the
  host (or a local file), see what the import would produce - widget counts,
  unsupported types, detected display size and how it was detected - and
  correct the size before committing.
- The source configuration is never written to. Import reads through the same
  guarded accessor as everything else and the import path has no access to the
  draft or publish machinery at all, so this is structural rather than a
  convention. An imported project exports to a *new* file, and its header says
  which config it came from and that the original was left alone.
- Anything this build does not model - unknown style properties, widget types,
  `pages:`, the screen's own layout - is preserved verbatim and written back
  unchanged, rather than silently disappearing on the next export.

Project format version 2 (older desktop builds now refuse such files instead
of loading them and silently dropping the new fields):

- Widgets gained `layout`, `grid_cell`, `extra`, `source` and `synthetic_id`;
  projects gained `theme`, `extra_lvgl`, `canvas_source`, `export_sections`
  and `import_source`. Per-state styles live under a reserved `states` key.
- Layout moved out of the style properties into a nested `layout:` mapping.
  ESPHome never accepted it as flat style keys, so the previous output was not
  valid ESPHome. Version 1 projects are migrated on load.
- A widget may now carry a named style *and* inline overrides; they were
  treated as mutually exclusive, which silently dropped the overrides.
- Assets belonging to an imported config are marked `external`: emitted
  verbatim, never copied, and exempt from the local-file restriction. Without
  this, importing any real config produced a project that could be neither
  saved nor exported.
- Widget sizes are optional. The exporter wrote `width`/`height`
  unconditionally, which would have injected a fixed size into every
  grid-managed widget and broken the layout on write-back.

Verified end to end against a real 1048-line device config: 31 widgets import
with no blocking issues, and an import/export round trip of its `lvgl:` block
differs only in dropping an explicit `align: TOP_LEFT`, which is LVGL's
default anyway.

Not yet: the canvas still places imported widgets by their stored coordinates,
so grid- and flex-managed layouts stack at the origin. Editing works through
the hierarchy and the property panel.

## 0.3.1

- The image widget's source is now a picker over the project's image library
  instead of a free-text field, with "＋ new image source" to add one. The
  widget resizes itself to the picture's native size on pick, as the desktop
  app does.
- Image widgets render the actual picture on the canvas rather than a
  placeholder box, falling back to a labelled marker if the URL cannot be
  loaded in the browser. The reference image behaves the same way.
- Asset validation now distinguishes local files from remote URLs. Importing
  files off the host stays blocked - that would allow arbitrary file reads -
  but `http(s)` URLs are allowed, which the exporter already passed through
  verbatim and which ESPHome resolves at compile time. Previously *every*
  asset source was rejected, so no image could be exported at all. The
  reference image's "export as LVGL image" option is usable again as a
  result.

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
- Moved the hierarchy from the right panel to the left one, below the widget
  palette, matching the desktop app's docking. It previously sat inside the
  properties panel, which is hidden entirely below 900px - so on a narrow
  Ingress frame the hierarchy was simply not reachable. Palette and hierarchy
  now scroll independently.

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
