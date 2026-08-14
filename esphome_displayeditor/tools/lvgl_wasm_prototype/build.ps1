param(
  [string]$LvglVersion = "v9.2.2",
  [string]$EmsdkVersion = "4.0.10",
  [string]$CacheDirectory = "",
  [switch]$KeepDebugSymbols
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$OutputDirectory = Join-Path $ProjectRoot "frontend\viewer-wasm"
if (-not $CacheDirectory) { $CacheDirectory = Join-Path $ProjectRoot ".wasm-toolchain" }
$EmsdkDirectory = Join-Path $CacheDirectory "emsdk"
$LvglDirectory = Join-Path $CacheDirectory "lvgl"

New-Item -ItemType Directory -Force -Path $CacheDirectory, $OutputDirectory | Out-Null
if (-not (Test-Path (Join-Path $EmsdkDirectory ".git"))) {
  git clone --filter=blob:none https://github.com/emscripten-core/emsdk.git $EmsdkDirectory
}
if (-not (Test-Path (Join-Path $LvglDirectory ".git"))) {
  git clone --filter=blob:none --branch $LvglVersion https://github.com/lvgl/lvgl.git $LvglDirectory
}

Push-Location $EmsdkDirectory
try {
  & .\emsdk.bat install $EmsdkVersion
  & .\emsdk.bat activate $EmsdkVersion
} finally { Pop-Location }

$Emcc = Join-Path $EmsdkDirectory "upstream\emscripten\emcc.bat"
$Bridge = Join-Path $OutputDirectory "lvgl_bridge.c"
$Sources = Get-ChildItem -Path (Join-Path $LvglDirectory "src") -Recurse -Filter "*.c" |
  Where-Object { $_.FullName -notmatch "\\draw\\sdl\\|\\drivers\\|\\others\\" } |
  ForEach-Object { $_.FullName }
$Optimization = if ($KeepDebugSymbols) { "-O1" } else { "-Oz" }
$Arguments = @(
  $Optimization, "-std=c11", "-DLV_CONF_INCLUDE_SIMPLE", "-DLV_LVGL_H_INCLUDE_SIMPLE",
  "-I$OutputDirectory", "-I$LvglDirectory", "-I$(Join-Path $LvglDirectory 'src')",
  $Bridge
) + $Sources + @(
  "-sWASM=1", "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=web",
  "-sALLOW_MEMORY_GROWTH=1", "-sINITIAL_MEMORY=16777216", "-sFILESYSTEM=0",
  "-sNO_EXIT_RUNTIME=1", "-sASSERTIONS=0", "-sEXPORTED_RUNTIME_METHODS=['UTF8ToString','HEAPU8','HEAPU16']",
  "-sEXPORTED_FUNCTIONS=['_malloc','_free','_lvgl_bridge_init','_lvgl_bridge_reset','_lvgl_bridge_create','_lvgl_bridge_add_label','_lvgl_bridge_add_page','_lvgl_bridge_set_text','_lvgl_bridge_configure','_lvgl_bridge_link','_lvgl_bridge_select_page','_lvgl_bridge_set_state','_lvgl_bridge_set_style','_lvgl_bridge_set_image_rgba','_lvgl_bridge_pointer','_lvgl_bridge_frame','_lvgl_bridge_object_count']",
  "-o", (Join-Path $OutputDirectory "lvgl-wasm.js")
)
$ResponseFile = Join-Path $CacheDirectory "lvgl-build.rsp"
$ResponseArguments = $Arguments | ForEach-Object {
  # LLVM response files treat backslashes as escapes, so normalize Windows
  # paths before writing them. Forward slashes are accepted by emcc/clang.
  $argument = ([string]$_).Replace('\', '/')
  if ($argument -match '[\s"]') { '"' + $argument.Replace('"', '\"') + '"' } else { $argument }
}
Set-Content -Encoding UTF8 $ResponseFile ($ResponseArguments -join "`n")
& $Emcc "@$ResponseFile"
if ($LASTEXITCODE -ne 0) { throw "emcc failed with exit code $LASTEXITCODE" }

$WasmPath = Join-Path $OutputDirectory "lvgl-wasm.wasm"
$Hash = (Get-FileHash -Algorithm SHA256 $WasmPath).Hash.ToLowerInvariant()
$Manifest = @{
  prototype = "lvgl9-browser-viewer"
  lvgl_version = $LvglVersion
  emscripten_version = $EmsdkVersion
  sha256 = $Hash
  bytes = (Get-Item $WasmPath).Length
  built_at_utc = [DateTime]::UtcNow.ToString("o")
} | ConvertTo-Json
Set-Content -Encoding UTF8 (Join-Path $OutputDirectory "build-manifest.json") $Manifest
Write-Output $Manifest
