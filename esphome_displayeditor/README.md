# ESPHome Display Editor

Visual LVGL designer with an isolated read-only browser Viewer, controlled
ESPHome YAML editor, encrypted read-only Native API monitor and optional
fail-closed Device Builder integration for Home Assistant.

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
