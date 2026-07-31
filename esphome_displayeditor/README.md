# ESPHome Display Editor

Visual LVGL designer with an isolated read-only browser Viewer, controlled
ESPHome YAML editor, encrypted read-only Native API monitor and optional
fail-closed Device Builder integration for Home Assistant.

The Viewer simulates button, switch, slider and adjustable-arc interaction on a cloned
runtime project. Only a fixed set of literal LVGL show/hide/update actions is
accepted; every unsupported automation is skipped and shown in its event log.
ESPHome `pages`, `page_wrap`, `skip`, `top_layer` and `bottom_layer` are
preserved structurally and can be navigated without leaving the Viewer.
