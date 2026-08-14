# LVGL 9 WebAssembly research prototype

This prototype compiles a pinned LVGL release into a browser-only WebAssembly
module. It is not part of the add-on runtime build and does not execute YAML,
lambdas, services, scripts, or network requests.

Build from PowerShell:

```powershell
.\tools\lvgl_wasm_prototype\build.ps1
```

The script downloads pinned build inputs into `.wasm-toolchain/`, which is
ignored by Git. The deliverables are `frontend/viewer-wasm/lvgl-wasm.js`,
`lvgl-wasm.wasm`, and `build-manifest.json`. The manifest records the exact
versions, byte size, and SHA-256 digest. Only those static deliverables are
needed by the running add-on.

The fixed bridge covers every real widget currently modeled by the editor:
`obj`/`container`, `label`, `button`, `switch`, `slider`, `image`, `animimg`,
`checkbox`, `arc`, `bar`, `dropdown`, `roller`, `textarea`, `keyboard`,
`tileview`, `tabview`, `led`, `spinner`, `qrcode`, `spinbox`, and `meter`.
Synthetic `tile` and `tab` nodes are materialized through their native parent
widgets. The adapter uses the editor's shared layout, style, page/layer,
runtime-binding, asset, and safe-action infrastructure.
