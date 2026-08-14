# LVGL 9 WebAssembly viewer findings

Date: 2026-08-14

## Result

The optional LVGL 9 renderer is fully implemented for the widget model exposed
by the editor. The viewer remains switchable at runtime between `HTML
(Standard)` and `LVGL 9 / WASM`. Switching does not mutate the editor project;
both engines operate on the same isolated viewer clone, shared layout, runtime
bindings, pages/layers, and safe action interpreter.

The WebAssembly module contains real LVGL 9.2.2 widget classes and renders an
RGB565 display buffer into the browser canvas. Native pointer events are read
by LVGL and returned to the existing allowlisted action runtime.

## Functional coverage

- all modeled widgets: `obj`/`container`, `label`, `button`, `switch`, `slider`,
  `image`, `animimg`, `checkbox`, `arc`, `bar`, `dropdown`, `roller`,
  `textarea`, `keyboard`, `tileview`, `tabview`, `led`, `spinner`, `qrcode`,
  `spinbox`, and `meter`
- synthetic tile/tab nodes materialized through native tileview/tabview pages
- root projects, active pages, top layer, bottom layer, page switching and wrap
- message-box surface, title, body and modeled buttons
- main, indicator, knob, selected, items, and cursor parts
- default, checked, pressed, focused, and disabled states
- numeric ranges, modes, values, selection, checked state and text input
- image decoding, RGBA upload, RGB565 display output, rotation and zoom
- animimg frame timing and cleanup
- meter scales, ticks, tick styles, arc and line indicators
- project styles, named styles, themes, colors and part/state precedence
- Native-API runtime bindings through the shared project clone
- allowed viewer actions, including updates, visibility, pages, tabs, tiles,
  animimg and meter-indicator changes, through the shared interpreter
- native LVGL click, press, release, value and text events
- zoom, fit, rotation, reset, close and automatic HTML fallback

## Measured acceptance envelope

- WASM payload: 288,064 bytes uncompressed
- initial linear memory: 16 MiB; acceptance limit: 32 MiB
- cold browser initialization acceptance limit: 2,000 ms
- complete browser matrix: 23 visible projected objects and all modeled types
- browser acceptance: more than 10,000 non-black output pixels
- integrity: SHA-256 checked before WebAssembly instantiation

Exact build metadata lives in `frontend/viewer-wasm/build-manifest.json`.

## Security properties

- no YAML, lambda, script, service, device command or arbitrary action enters C
- no network API is exposed to LVGL; assets are decoded by the controlled JS
  adapter and copied as bounded RGBA buffers
- bridge limits display dimensions, object count, image count and image size
- unknown actions still pass through the existing skip-and-log policy
- CSP enables `'wasm-unsafe-eval'`, never general `'unsafe-eval'`
- build inputs are pinned and compilation happens outside the add-on runtime
- the static binary is SHA-256 verified in the browser before execution

## Product decision

Both renderers remain available. HTML stays the default for compatibility and
fast startup; LVGL/WASM is the selectable high-fidelity engine. Neither engine
is allowed to write the project or execute arbitrary ESPHome behavior.
