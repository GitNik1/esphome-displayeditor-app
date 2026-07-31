# Changelog

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
