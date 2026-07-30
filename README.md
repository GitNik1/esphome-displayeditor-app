# ESPHome Display Editor App Repository

Home Assistant App repository for **ESPHome Display Editor**: a visual LVGL
designer and controlled editor for ESPHome configuration files.

## Install in Home Assistant

1. Open **Settings → Apps → App store**.
2. Open the repository menu and add:
   `https://github.com/GitNik1/esphome-displayeditor-app`
3. Install **ESPHome Display Editor**.
4. Start the app and open its Ingress web interface.

Home Assistant detects updates when the app version in
`esphome_displayeditor/config.yaml` is increased and the repository is
refreshed.

## Development status

The current milestone provides the Home Assistant app container, stable health
and capability endpoints, safe ESPHome YAML draft handling, persistent visual
designer projects, and a web-native port of the model and YAML export engine
from `esphome-lvgl-designer`.

See [app documentation](esphome_displayeditor/DOCS.md) for configuration and
security details.

## License

MIT. The designer engine is derived from the MIT-licensed
`esphome-lvgl-designer` project by Niklaus Riedle.
