# Umsetzungsplan: Vollständigere ESPHome-LVGL-Unterstützung

## Aktueller Stand (06.08.2026, nach `msgbox`)

- **Phase 1 vollständig abgeschlossen**: `checkbox`, `arc`, `bar`,
  `dropdown`, `roller`, `textarea` und `keyboard` haben jetzt ein
  vollständiges `WidgetSchema` (Palette, Eigenschaften-Panel, Import,
  Export) sowie Viewer-Rendering und -Interaktion. `dropdown`/`roller`
  brauchten eine neue Options-Listen-Editor-UI (Kind `text_list`,
  komma-getrennt, analog zum bereits bestehenden Muster für
  `image_ref_list`/`grid_track_list`) und einen dritten Style-Part `list`
  (ergänzt in `model.py`/`STYLE_PARTS` und den beiden bislang unabhängig
  geführten Kopien dieses Sets in `yamlexport.py` und `viewer.js`).
  `keyboard` brauchte einen neuen Property-Kind `widget_ref` - ein
  Auswahlfeld, das mit den passenden Widget-Ids des Projekts befüllt wird
  (die "klare Zuordnungs-UI" aus Abschnitt 5, hier für `keyboard.textarea`
  auf `textarea`-Widgets gefiltert). Im Viewer tippt man direkt mit der
  echten Tastatur in die `textarea`; das `keyboard`-Widget selbst ist dort
  bewusst nur ein visueller Platzhalter statt eines simulierten
  Tasten-Layouts, da echtes Tippen im Browser ohnehin schon funktioniert.
  Details siehe CHANGELOG.
- **Phase 2, `tileview` abgeschlossen** (erstes Widget nach Unterplan 3a):
  neuer synthetischer Pseudo-Widget-Typ `tile` (`is_stub=True`, kein
  eigener Palette-Eintrag, kein `LVGL_WIDGET_TYPES`-Mitglied) hält je einen
  Eintrag der `tiles:`-Liste, über die bereits vorher vorhandenen, aber
  ungenutzten Felder `WidgetNode.tile_row`/`tile_col`/`tile_dir` sowie
  `WidgetSchema.is_stub`/`child_role`. Neuer Properties-Panel-Abschnitt für
  Zeile/Spalte/Wischrichtung einer ausgewählten Kachel, "+ Kachel
  hinzufügen"-Button am `tileview` (wählt automatisch eine freie Spalte).
  Im Viewer wird nur die aktive Kachel gerendert (`allWidgetItems()`
  überspringt `tile`-Knoten und rekursiert transparent in ihre Kinder;
  Geschwister-Kacheln werden über den bestehenden `ancestorHidden`-
  Mechanismus versteckt - bewusst ohne Swipe-Simulation, siehe Unterplan).
  `lvgl.tileview.select` (per `tile_id` oder `row`+`column`) ist im Viewer
  als eigene Aktion implementiert und schaltet die aktive Kachel um. Live
  mit einem konstruierten Testprojekt verifiziert (Browser-Konsole,
  temporärer Debug-Hook): `lvgl.tileview.select` macht ein zuvor
  verstecktes Label in der Zielkachel tatsächlich sichtbar. Details siehe
  CHANGELOG.
- **Phase 2, `tabview` abgeschlossen** (zweites und letztes Widget nach
  Unterplan 3a): gleiche Pseudo-Widget-Architektur wie `tile`, hier ein
  synthetischer `tab`-Typ über das bereits vorhandene `WidgetNode.tab_title`-
  Feld. `tabview` selbst bekommt zwei eigene Top-Level-Properties,
  `position` (TOP/BOTTOM/LEFT/RIGHT) und `size` (Prozent-String wie `10%`,
  als einfaches `text`-Property modelliert statt eines eigenen
  Prozent-Kinds). "+ Tab hinzufügen"-Button, Eigenschaften-Panel-Abschnitt
  für den Tab-Titel. Anders als `tileview` (das im Viewer keine eigene
  Bedienoberfläche hat) rendert `tabview` dort eine echte klickbare
  Tableiste (immer oben, unabhängig von `position` - bewusste MVP-
  Vereinfachung); ein Klick schaltet den aktiven Tab um und feuert
  `on_value`/`on_change` mit der Tab-Id in Variable `tab`, wie von ESPHome
  dokumentiert. `lvgl.tabview.select` (per nullbasiertem `index`) ist für
  automatisierungsgetriebenes Umschalten in der Aktions-Allowlist. Live im
  Browser verifiziert: Export erzeugt exakt das erwartete ESPHome-YAML
  (`tabs:` mit `name`/`id`, verschachtelte `widgets:`), im Viewer schaltet
  ein Klick auf den "Settings"-Tab-Button ein zuvor verstecktes Label
  sichtbar. Details siehe CHANGELOG. Damit ist Unterplan 3a vollständig
  abgeschlossen; `meter` bleibt bewusst außerhalb des Umfangs.
- **Phase 3, Runde 1 abgeschlossen**: `led`, `spinner`, `qrcode` und
  `spinbox` haben jetzt ein vollständiges `WidgetSchema`. Recherche über
  alle 8 Phase-3-Kandidaten ergab eine klare Zweiteilung: diese vier sind
  reine "flache Konfigurationsvariablen"-Widgets (wie jedes Phase-1-Widget)
  und brauchten - wie schon bei `checkbox`/`arc`/`bar` festgestellt -
  **keine** Änderung an `yamlimport.py`/`yamlexport.py`, nur die
  Schema-Registrierung. `buttonmatrix` (Zeilen/Spalten-Matrix mit
  Pro-Button-Feldern und -Triggern), `msgboxes` (ein Top-Level-`msgboxes:`-
  Konfigurationsschlüssel wie `pages`, kein Eintrag im Widget-Baum), `line`
  (eine `points:`-Liste, oft mit Lambda-Koordinaten) und `canvas` (reine
  Zeichenbefehl-API über Actions, nichts davon ist ein Zustand zum Anzeigen)
  blieben zunächst bewusst unregistriert - jedes bräuchte einen grundlegend
  anderen Editor. Im Viewer: `led` als Farbpunkt, dessen Deckkraft aus
  `brightness` kommt; `spinner` als CSS-animierter Ring (keine
  SVG-Bogen-Mathematik nötig, da nie per Drag bedienbar); `qrcode` als
  beschrifteter Platzhalter mit dem kodierten Text (keine
  QR-Generator-Bibliothek eingebunden, passend zur
  Self-contained-Artefakt-Policy); `spinbox` als formatierte Zahlenanzeige
  (`value` auf `decimal_places` gerundet). `spinbox` bekommt zusätzlich
  `lvgl.spinbox.increment`/`.decrement` (eigene Aktionsform, nur eine Id
  statt eines Update-Payloads). Live im Browser verifiziert: alle vier in
  der Palette (richtig kategorisiert), Export erzeugt exakt das erwartete
  ESPHome-YAML, Viewer rendert alle vier ohne Konsolenfehler. Details siehe
  CHANGELOG.
- **`msgboxes` abgeschlossen** (Unterplan 3b): anders als jedes andere
  bisher umgesetzte Widget kein Eintrag im Widget-Baum, sondern ein
  Top-Level-`lvgl:`-Schlüssel, strukturell identisch zu
  `pages`/`top_layer`/`bottom_layer`. Dafür existierte mit
  `backend/page_support.py` bereits eine fertige Vorlage - neues Modul
  `backend/msgbox_support.py` folgt demselben Muster 1:1
  (`materialize_msgboxes`/`apply_msgbox_payload`, `extra_lvgl["msgboxes"]`
  bleibt der einzige Ort im geteilten `designer_core`, unverändert). Damit
  ist dies ein reines Add-on-Feature ohne `test_core_sync.py`-Risiko - die
  Desktop-App sieht `msgboxes` weiterhin nur als unverändertes Passthrough
  (Gegenprobe bestätigt, wie schon bei `pages`). Neuer "+ Message box"-
  Button im Workspace-Toolbar; jede Message-Box bekommt ein eigenes
  Einstellungs-Panel (Titel, Schließen-Button, Body-Text) plus zwei
  umschaltbare Widget-Editier-Flächen ("Buttons"/"Header buttons"), die die
  komplett bestehende Canvas-/Hierarchie-Baum-/Eigenschaften-Panel-
  Maschinerie wiederverwenden (Palette wird auf `button` beschränkt,
  solange eine dieser Flächen aktiv ist, da ESPHome dort nur Buttons
  akzeptiert). Im Viewer rendert eine Message-Box als zentriertes
  Modal-Overlay, standardmäßig versteckt (wie im echten ESPHome - es gibt
  keine "sichtbar beim Booten"-Option), umgeschaltet über die bereits
  generischen `lvgl.widget.show`/`lvgl.widget.hide`-Aktionen; der eigene
  Schließen-Button nutzt denselben Mechanismus. Keine neue Aktionsart
  nötig. Live im Browser verifiziert: Export erzeugt exakt das erwartete
  ESPHome-YAML (inkl. korrektem Entfernen von `widgets: []`, wenn nur
  Message-Boxen ohne Root-Widgets existieren), im Viewer macht
  `lvgl.widget.show` das Modal mit Titel/Text/Buttons sichtbar, der
  ✕-Button versteckt es wieder. Details siehe CHANGELOG.
- `backend/designer_core/widgetschema.py` kennt alle 26 LVGL-Widget-Typen aus
  der ESPHome-Dokumentation (`LVGL_WIDGET_TYPES`), davon haben jetzt 21 ein
  registriertes `WidgetSchema` mit editierbaren Eigenschaften: `obj`,
  `container`, `label`, `button`, `switch`, `slider`, `image`, `animimg`,
  `checkbox`, `arc`, `bar`, `dropdown`, `roller`, `textarea`, `keyboard`,
  `tileview`, `tabview`, `led`, `spinner`, `qrcode`, `spinbox` (plus die
  synthetischen Pseudo-Typen `tile`/`tab`, die keine echten
  ESPHome-Widget-Typen sind und daher nicht in `LVGL_WIDGET_TYPES` stehen).
  `msgboxes` kommt separat hinzu - es ist kein `WidgetSchema`-Eintrag (kein
  Widget-Baum-Element), sondern wird komplett außerhalb von
  `designer_core` in `backend/msgbox_support.py` editierbar gemacht.
  Jedes `WidgetSchema` trägt außerdem ein `category`-Feld (`input`/
  `display`), das die Palette in zwei Gruppen ordnet - eine reine
  UI-Organisationshilfe ohne Auswirkung auf Import/Export/Validierung.
- Die übrigen 4 Typen (`buttonmatrix`, `canvas`, `line`, `meter`) werden
  beim Import als unmodellierte, aber strukturell erhaltene Rohdaten
  behandelt: sie bleiben im YAML-Roundtrip erhalten, sind aber im Designer
  weder erstell- noch bearbeitbar (nur sichtbar als "nicht editierbares"
  Element im Hierarchie-Baum bzw. im Viewer als generische Box).
- Die Stil-Eigenschaften der 15 unterstützten Widgets decken laut
  Code-Kommentar bewusst nur *"a hand-picked subset of ESPHome's BASE_PROPS
  ... not the full ~90-property list"* ab.
- Die Aktionsliste (`widget-actions`-Sektion) existiert nur für `button` und
  bietet nur eine feste Allowlist (`show`/`hide`/`update`/Seite öffnen), nicht
  die volle ESPHome-LVGL-Aktionspalette.
- Top-Level-`lvgl:`-Schlüssel `touchscreens`, `encoders`, `keypads`,
  `rotation`, `gradients`, `animations`, `byte_order`, `buffer_size`,
  `draw_rounding`, `refresh_interval`, `resume_on_input`, `paused`,
  `update_when_display_idle`, `rotary_sensitivity`, `log_level` werden nur
  roh durchgereicht.
- `pages`, `top_layer`, `bottom_layer`, `page_wrap` sind bereits strukturell
  unterstützt (siehe `VIEWER-UMSETZUNGSPLAN.md`, V5) und nicht Teil dieses
  Plans.

## 1. Ziel

Schrittweise Erweiterung des Designers, bis die im Alltag gebräuchlichsten
LVGL-Widgets vollständig visuell erstell- und bearbeitbar sind, ohne die
bestehende "unbekannte Widgets bleiben roh erhalten"-Garantie zu verletzen,
die den sicheren Import fremder Konfigurationen erst ermöglicht.

## 2. Abgrenzung

- Hardware-nahe `lvgl:`-Schlüssel (`touchscreens`, `encoders`, `keypads`,
  `rotation`, `byte_order`, `buffer_size`, `draw_rounding`,
  `refresh_interval`, `rotary_sensitivity`, `log_level`,
  `update_when_display_idle`, `resume_on_input`, `paused`) sind **bewusst
  nicht Ziel** dieses Plans. Das ist Geräte-/Board-Konfiguration, kein
  UI-Design, und gehört inhaltlich eher zur restlichen ESPHome-YAML als zum
  visuellen Editor.
- `gradients` (benannte, wiederverwendbare Verläufe) und `animations`
  (eigenständige Property-Animationen) sind spätere Kandidaten, aber nicht
  Teil der ersten Phasen - sie betreffen wenige Nutzer und lassen sich ohne
  Modellbruch nachrüsten.
- Kein Nachbau einer vollständigen LVGL-Stil-Property-Liste in einem Schritt
  - Erweiterung erfolgt pro Widget-Typ, mit den für diesen Typ jeweils
  sinnvollen zusätzlichen Eigenschaften, nicht als globale "alle 90
  Properties auf einmal"-Aktion.

## 3. Priorisierung der fehlenden Widget-Typen

### Phase 1 - alltägliche UI-Bausteine (höchster Nutzen)

| Widget | Warum zuerst | Status |
|---|---|---|
| `checkbox` | Einfaches Kern-Widget, ähnlich `switch` bereits vorhanden - geringer Aufwand, hoher Nutzen | ✅ umgesetzt |
| `arc` | Fortschritts-/Wertanzeige, im Viewer (`SUPPORTED_WIDGETS`) bereits renderbar, fehlte nur die Editor-Schema-Seite | ✅ umgesetzt |
| `bar` | Ebenfalls schon im Viewer renderbar, gleiche Situation wie `arc` | ✅ umgesetzt |
| `dropdown` | Häufigstes Auswahl-Widget für Optionslisten | ✅ umgesetzt |
| `roller` | Zweithäufigstes Auswahl-Widget, ähnliche Optionsliste wie `dropdown` | ✅ umgesetzt |
| `textarea` + `keyboard` | Gehören zusammen (Texteingabe braucht i. d. R. eine Tastatur-Bindung) - als Paar umsetzen | ✅ umgesetzt |

### Phase 2 - Struktur-Widgets

| Widget | Warum | Status |
|---|---|---|
| `tabview` | Eigene Navigationsebene, ähnlich den bereits unterstützten `pages`, aber innerhalb eines einzelnen Widgets | ✅ umgesetzt |
| `tileview` | Analog zu `tabview`, kachelbasierte Navigation | ✅ umgesetzt |
| `meter` | Komplexere Konfiguration (Skalen, Nadeln, Bögen) - mehr Aufwand als `arc`/`bar` | Unterplan 3c geschrieben, Umsetzung offen |

## 3a. Unterplan: `tabview` und `tileview` (Stand 04.08.2026, vor Umsetzung; beide am 06.08.2026 umgesetzt - siehe "Aktueller Stand" oben)

Anders als die 15 bereits umgesetzten Widgets sind `tabview` und `tileview`
**keine** reinen "flache Properties"-Widgets: Beide haben eine Liste von
Unter-Containern mit eigenen verschachtelten Widgets
(`tabs: [{name, id, widgets: [...]}]` bzw.
`tiles: [{column, row, dir, id, widgets: [...]}]`). Das passt nicht ins
bestehende `PropertyDef`-Muster und braucht eigene Import-/Export-Logik statt
nur einer Schema-Registrierung. `meter` ist noch komplexer verschachtelt
(Skalen → Indikatoren → Bogen/Nadel/Linie/Tick-Stil) und bleibt vorerst
bewusst zurückgestellt - kein Teil dieses Unterplans.

### 3a.1 Überraschender Fund: die Datenbasis existiert schon

`WidgetNode` hat bereits die Felder `tab_title: str`, `tile_row: int`,
`tile_col: int`, `tile_dir: str` (vollständig verdrahtet in `to_dict()`/
`from_dict()`), und `WidgetSchema` hat bereits ein `child_role`-Feld
(`generic | tab | tile`) sowie ein bislang ungenutztes `is_stub`-Feld. Das
Datenmodell wurde offenbar schon in Milestone 1 auf genau diesen Fall
vorbereitet - nur Import/Export/UI fehlen noch. **Keine Änderung an
`model.py` nötig.**

### 3a.2 Architekturentscheidung: synthetische `tab`/`tile`-Pseudo-Widgets

Ein Tab bzw. eine Kachel wird als **ein synthetischer Wrapper-`WidgetNode`**
modelliert - zwei neue Pseudo-Widget-Typen `tab` und `tile`, registriert mit
`is_stub=True`:

- `is_stub=True` bedeutet: kein eigener Palette-Eintrag (kann nicht direkt
  freistehend platziert werden), nur als Kind eines `tabview`/`tileview`
  erzeugbar.
- Beide bekommen **keine eigenen `PropertyDef`s** (leeres `properties`-Tupel)
  - `name`/`column`/`row`/`dir` werden über die bereits vorhandenen
  `tab_title`/`tile_row`/`tile_col`/`tile_dir`-Felder auf `WidgetNode`
  gepflegt, nicht über das generische Property-System. Das ist bewusst: in
  echtem ESPHome-YAML hat ein Tab/eine Kachel **keinen eigenen Stil** (nur
  `tab_style`/`content_style` auf `tabview`-Ebene) - ein volles
  Eigenschaften-Panel mit Stil-Optionen würde Einstellungen anbieten, die
  beim Export klanglos verloren gingen.
- `tabview`/`tileview` selbst werden ganz normal registriert
  (`allows_children=True`, `child_role="tab"` bzw. `"tile"`), mit ihren
  eigenen Top-Level-Properties (`position`, `size` bei `tabview`; nichts
  Zusätzliches bei `tileview`).

### 3a.3 Import (`yamlimport.py`)

Neue, auf `widget_type in {"tabview", "tileview"}` bedingte Fallunterscheidung
in `_import_widget()`: statt `body.get("widgets")` als Kinder zu lesen, wird
`body.get("tabs")` bzw. `body.get("tiles")` gelesen. Für jeden Listeneintrag:

1. Einen synthetischen Kind-`WidgetNode` vom Typ `tab`/`tile` anlegen
   (Id aus `id:`, sonst generiert wie bei jedem anderen Widget).
2. `tab_title` aus `name:` übernehmen (bei `tab`), bzw. `tile_row`/
   `tile_col`/`tile_dir` aus `row:`/`column:`/`dir:` (bei `tile`, Default
   `dir: ALL` passt zum bestehenden `WidgetNode`-Default).
3. Den Eintrags-eigenen `widgets:` rekursiv als Kinder **dieses**
   Wrapper-Knotens importieren (normaler `_import_widget`-Rekursionspfad).
4. `tab_style`/`content_style` (bei `tabview`) landen vorerst in `extra`
   (unmodelliert, aber erhalten) - kein eigener Editor dafür in diesem
   Schritt.

### 3a.4 Export (`yamlexport.py`)

Ebenfalls eine bedingte Fallunterscheidung in `_widget_dict()`: hat der
Knoten `widget_type in {"tabview", "tileview"}`, werden seine Kinder nicht
als `widgets: [...]` geschrieben, sondern als `tabs: [...]`/`tiles: [...]`
- jedes Kind liefert `{name: child.tab_title, id: ..., widgets: [rekursiv
exportierte Enkel]}` bzw. `{column, row, dir, id, widgets: [...]}`. Die
Wrapper-Knoten selbst (`tab`/`tile`) werden nie als eigenständiges
`{tab: {...}}`/`{tile: {...}}`-YAML-Objekt geschrieben - sie sind rein
strukturell und existieren in echtem ESPHome-YAML gar nicht als Widget-Typ.

### 3a.5 Frontend: Eigenschaften-Panel

Neuer bedingter Abschnitt (analog zum bestehenden Muster für
`#grid-cell-section`, das sich nach dem *Eltern*-Layout richtet - hier
richtet sich der neue Abschnitt nach dem Typ des **ausgewählten** Widgets
selbst):

- Ist das ausgewählte Widget vom Typ `tab`: ein Textfeld "Tab-Titel"
  (schreibt direkt auf `widget.tab_title`, kein generisches `PropertyDef`).
- Ist es vom Typ `tile`: drei Felder "Zeile"/"Spalte" (Zahl) und
  "Richtung" (Enum `LEFT/RIGHT/TOP/BOTTOM/HOR/VER/ALL`), analog gegen
  `tile_row`/`tile_col`/`tile_dir`.
- Ein neuer Button "+ Tab hinzufügen" bzw. "+ Kachel hinzufügen", sichtbar
  wenn das ausgewählte (oder das zuletzt aktive) Widget ein `tabview`/
  `tileview` ist - analog zum bestehenden `+ Seite`-Button, legt einen neuen
  `tab`/`tile`-Kind-Knoten mit eindeutigem Titel/Zeile+Spalte an.
- Die Palette filtert `is_stub`-Schemas heraus (`tab`/`tile` erscheinen
  nicht als eigene Kacheln in der Widget-Übersicht).

### 3a.6 Viewer

MVP-Ansatz, keine vollständige LVGL-Swipe-Simulation:

- `tabview`: rendert eine Tab-Leiste (ein Button je Kind-`tab`, Beschriftung
  = `tab_title`) plus den Inhalt des aktuell aktiven Tabs. Klick auf einen
  Tab-Button wechselt die Ansicht und feuert `on_value`/`on_change` mit der
  Tab-Id in der Variable `tab` (wie von ESPHome dokumentiert). Kein
  Wisch-/Swipe-Gesten-Support in dieser Phase.
- `tileview`: rendert zunächst nur die aktive Kachel (Startposition: die
  Kachel mit `tile_row=0, tile_col=0`), ohne Drag/Swipe. `lvgl.tileview.select`
  wird in der Aktions-Allowlist unterstützt (Wechsel zu einer Kachel per
  `row`/`column` oder `tile_id`), echtes Wischen bleibt ein späterer Ausbau.
- Beide Fälle folgen damit demselben Muster wie `keyboard`: eine bewusst
  vereinfachte, aber funktional korrekte Basis-Simulation statt einer
  vollständigen 1:1-LVGL-Nachbildung.

### 3a.7 Tests

Analog zu den bisherigen Roundtrip-Tests: ein Fixture-YAML mit
verschachtelten `tabview`/`tileview` inkl. mehrerer Tabs/Kacheln mit eigenen
Kind-Widgets, Import → Export → erneuter Import muss dieselbe Struktur
liefern (`tab_title`/`tile_row`/`tile_col`/`tile_dir` erhalten, Enkel-Widgets
korrekt verschachtelt).

### 3a.8 Reihenfolge

1. `tileview` zuerst (weniger Zusatzfelder auf `tabview`-Ebene, `dir`-Enum
   bereits mit sinnvollem Default vorhanden).
2. `tabview` danach (gleiche Grundmechanik, zusätzlich `position`/`size`
   sowie die Tab-Leisten-UI im Viewer).
3. `meter` bleibt bewusst außerhalb dieses Unterplans - eigene Bewertung erst
   nach Abschluss von `tabview`/`tileview`, da die Verschachtelungstiefe
   (Skalen → Indikatoren → Bogen/Nadel/Linie) einen grundlegend anderen,
   noch nicht entworfenen Editor bräuchte.

### Phase 3 - spezialisierte/seltenere Widgets

| Widget | Warum | Status |
|---|---|---|
| `led` | Reine flache Konfigurationsvariablen, wie `checkbox`/`arc`/`bar` | ✅ umgesetzt |
| `spinner` | Reine flache Konfigurationsvariablen | ✅ umgesetzt |
| `qrcode` | Reine flache Konfigurationsvariablen | ✅ umgesetzt |
| `spinbox` | Reine flache Konfigurationsvariablen, eigene increment/decrement-Actions | ✅ umgesetzt |
| `buttonmatrix` | Zeilen/Spalten-Matrix mit Pro-Button-Feldern (`id`/`text`/`control`/`width`) und -Triggern - braucht einen eigenen Matrix-Editor | zurückgestellt |
| `msgbox` | Top-Level-`msgboxes:`-Konfigurationsschlüssel wie `pages`, kein Widget-Baum-Eintrag | ✅ umgesetzt |
| `line` | `points:`-Liste, oft mit Lambda-Koordinaten - braucht einen Punktlisten-Editor | zurückgestellt |
| `canvas` | Reine Zeichenbefehl-API über Actions (`lvgl.canvas.fill`/`.draw_rectangle`/...), kein visuell editierbarer Zustand | zurückgestellt |

`buttonmatrix`/`line`/`canvas` nur bei konkretem Bedarf angehen - jedes
bräuchte eine eigene Unterplan-Runde wie 3a/3b, da keins dem
Flach-Properties-Muster folgt.

## 3b. Unterplan: `msgbox` (Stand 06.08.2026, vor Umsetzung; am 06.08.2026 umgesetzt - siehe "Aktueller Stand" oben)

### 3b.1 Warum `msgbox` architektonisch anders ist als `tabview`/`tileview`

`msgboxes` ist laut ESPHome-Doku **kein Eintrag im Widget-Baum**, sondern ein
eigener Top-Level-Schlüssel direkt unter `lvgl:`, parallel zu `pages:`,
`top_layer:`, `bottom_layer:`:

```yaml
lvgl:
  displays: [my_display]
  msgboxes:
    - id: message_box
      close_button: true
      title: Message box
      body:
        text: "This is a sample message box."
        bg_color: 0x808080
      buttons:
        - id: msgbox_apply
          text: "Apply"
        - id: msgbox_close
          text: ""
          on_click:
            - lvgl.widget.hide: message_box
```

Jeder Eintrag hat `title` (Pflicht, String), optional `body` (Text +
Style-Optionen), `buttons` (Liste normaler `button`-Widgets mit voller
Style-/Trigger-Unterstützung), `header_buttons` (Liste von Bild-Buttons,
gleiches Schema wie `buttons` aber mit `src` statt `text`), `close_button`
(bool, Default `true`). Message-Boxen sind standardmäßig versteckt und
werden ausschließlich über die bereits generischen Actions
`lvgl.widget.show`/`lvgl.widget.hide` ein-/ausgeblendet - **keine eigene
`lvgl.msgbox.*`-Action existiert**.

### 3b.2 Überraschender Fund: es gibt schon eine fertige Vorlage dafür

`pages`/`top_layer`/`bottom_layer` sind strukturell fast identisch zu
`msgboxes` (Top-Level-Liste/Objekt mit eigenem `widgets:`) - und dafür
existiert bereits ein komplettes, funktionierendes Muster:
**`backend/page_support.py`**. Das ist add-on-only Code, *außerhalb* von
`designer_core/` (nicht mit der Desktop-App geteilt):

- `Project.extra_lvgl` (im geteilten `designer_core/model.py`) bleibt der
  einzige Ort, an dem `pages`/`top_layer`/`bottom_layer`/`msgboxes`
  überhaupt vorkommen - unverändertes reines Passthrough, exakt wie beim
  Speichern/Export gebraucht. **`designer_core` wird für diese Funktion gar
  nicht angefasst.**
- `page_support.materialize_surfaces(project)` liest `project.extra_lvgl`
  und baut daraus ein normalisiertes Payload für das Frontend (jede Seite/
  jeder Layer bekommt `{id, widgets: [...WidgetNode.to_dict()], style_tree,
  extra}}`), unter Wiederverwendung von `yamlimport._import_widget()` für
  die verschachtelten Widgets.
- `page_support.apply_surface_payload(payload)` macht das Gegenteil: baut
  aus dem vom Browser bearbeiteten Payload wieder die rohe
  `extra_lvgl["pages"]`/`["top_layer"]`/`["bottom_layer"]`-Form, unter
  Wiederverwendung von `yamlexport._widget_dict()`.
- Beide Funktionen werden zentral in `backend/designer.py::validate()`
  aufgerufen (einmal vor, einmal nach dem eigentlichen `Project.from_dict`/
  `export_project`-Durchlauf) - jeder Export-/Import-/Normalisierungs-Pfad
  bekommt die Umwandlung automatisch mit.
- Bestätigt durch Gegenprobe: Die Desktop-App (`lvgldesigner/`) hat *keine*
  Pages-UI (`panels.py`/`mainwindow.py` kennen `pages`/`top_layer`/
  `bottom_layer` nicht) - dieses Feature ist tatsächlich exklusiv für den
  Add-on. Das ist der exakte Präzedenzfall für `msgbox`: ein neues Feature,
  das nur im Add-on editierbar ist, während die Desktop-App es weiterhin
  nur als unverändertes Passthrough sieht.

Das senkt den Aufwand erheblich gegenüber der `tabview`/`tileview`-Runde:
**kein `test_core_sync.py`-Risiko, keine Desktop-App-Synchronisation
nötig**, da nichts in `designer_core/` geändert wird.

### 3b.3 Architekturentscheidung: `backend/msgbox_support.py` nach demselben Muster

Neues Modul, 1:1 nach dem Vorbild von `page_support.py`:

- `materialize_msgboxes(project, issues=None) -> tuple[list[dict], dict]`
  liest `project.extra_lvgl.get("msgboxes")`. Pro Eintrag:
  - `id` (aus `id:`, sonst `registry.unique_id("msgbox")`, `synthetic_id`
    wie bei Seiten).
  - `title`, `close_button` direkt übernommen.
  - `body`: `text` + Style-Optionen, wie ein `_surface()`-artiger Block
    (Wiederverwendung von `_classify_style_dict()`).
  - `buttons`/`header_buttons`: jeder Eintrag ist bereits ein flaches
    Mapping ohne `{type: body}`-Hülle (anders als bei normalen
    `widgets:`-Einträgen) - vor der Delegation an `_import_widget()` muss
    er künstlich zu `{"button": entry}` gewrapped werden. `header_buttons`
    nutzen dasselbe `button`-Schema (ein `button` mit `src`, wie ein
    Bild-Button - siehe die bereits bestehende Image-Button-Logik für
    `button`-Kinder).
- `apply_msgbox_payload(payload) -> dict` macht die Rückrichtung: baut aus
  dem vom Browser bearbeiteten `msgboxes`-Array wieder
  `extra_lvgl["msgboxes"]`, unter Entfernen der künstlichen `{"button": …}`-
  Hülle vor dem Schreiben.
- Aufruf-Stellen: dieselben wie in `designer.py` für `page_support`
  (`validate()`, `import_yaml`, den Normalisierungs-Endpunkt) - `msgboxes`
  einfach als weiterer Payload-Key neben `pages`/`top_layer`/`bottom_layer`
  mitgeführt.

### 3b.4 Frontend: eigenes Panel statt Properties-Panel-Sektion

Anders als `tab`/`tile` ist eine Message-Box kein auswählbares Widget im
Baum - sie lebt komplett außerhalb des Canvas. Sinnvollstes UI-Muster: ein
neuer Abschnitt im bestehenden "Workspace"-Panel (dort, wo aktuell
"+ Page"/"+ Bottom layer"/"+ Top layer" sitzen), z. B. "+ Message box", der
eine neue Message-Box zur Liste hinzufügt und als eigene, wählbare
Oberfläche in der Workspace-Leiste erscheint (analog zu einer Page). Die
Auswahl einer Message-Box wechselt den Canvas auf eine eigene bearbeitbare
Fläche für `body`-Text-Widget-artige Eigenschaften (Titel, Schließen-Button
An/Aus, Body-Text + Stil) plus zwei Listen (`buttons`/`header_buttons`),
die mit den bereits vorhandenen Widget-Hierarchie-/Eigenschaften-Mechanismen
bearbeitet werden (jeder Button ist ein stinknormales `button`-Widget -
keine neue Editor-Logik nötig, nur die Listen-Verwaltung selbst: hinzufügen/
entfernen/reihenfolge, analog zum bestehenden Seiten-Array).

### 3b.5 Viewer

Message-Boxen sind laut Doku standardmäßig versteckt und werden nur über
`lvgl.widget.show`/`lvgl.widget.hide` gesteuert - **diese Actions
existieren im Viewer bereits generisch** (siehe `applyViewerAction()`).
Der fehlende Teil ist rein die Rendering-Seite:

- `viewerWidgetRoots(project)` muss `project.msgboxes` (analog zu `pages`)
  mit einbeziehen, damit `findWidget()` eine Message-Box und ihre Buttons
  per Id findet.
- Eine Message-Box ist keine normale absolut positionierte Box im
  Canvas-Koordinatensystem (ESPHome zentriert und sized sie automatisch) -
  sie braucht eine eigene Rendering-Route: ein `<dialog>`-artiges,
  zentriertes Overlay über dem gesamten Viewer-Display, das nur sichtbar
  ist, wenn `hidden !== true`. Titel, optionaler Schließen-Button (× oben
  rechts), Body-Text, Footer mit `buttons` (normale Button-Widgets, volle
  Interaktion/Styling über die bestehende `renderWidget()`-Pipeline),
  Header mit `header_buttons` (Bild-Buttons).
- Bewusste MVP-Vereinfachung (wie bei `keyboard`/`tileview`): keine
  automatische Größen-/Umbruchberechnung wie im echten LVGL - eine feste
  oder Content-abhängige Breite reicht für eine visuelle Vorschau.

### 3b.6 Tests

`page_support.py` hat mit `tests/test_pages.py` (plus Fixture
`tests/data/pages_panel.yaml`) bereits eine eigene, direkt passende
Test-Vorlage. Für `msgbox_support.py` analog: neue Datei
`tests/test_msgboxes.py` (plus eigene Fixture), kein `designer_core`-Test
nötig, da nichts dort geändert wird. Ein Fixture-YAML mit einer
`msgboxes:`-Liste inkl. `body`, mehreren `buttons` (einer davon mit
`on_click`) und einem `header_buttons`-Eintrag, Import → Export → erneuter
Import muss dieselbe Struktur liefern.

### 3b.7 Offene Fragen (entschieden, vor Umsetzung)

- `button_style` (laut Doku deprecated): ignoriert/nicht modelliert, landet
  automatisch im generischen `extra`-Passthrough - genau wie geplant.
- `buttons`/`header_buttons`-Editor: keine eigene Listen-Editor-UI gebaut -
  stattdessen werden `msgbox.buttons`/`msgbox.header_buttons` als zwei
  eigene, per Workspace-Auswahl umschaltbare "Surfaces" behandelt (analog
  zu `page.widgets`), wodurch die komplette bestehende Canvas-/
  Hierarchie-Baum-/Eigenschaften-Panel-Maschinerie unverändert
  wiederverwendet werden konnte - deutlich weniger Aufwand als ein neuer
  Listen-Editor, und volle Widget-Editierbarkeit (Style, Trigger) statt nur
  Id/Text wie ursprünglich als Kompromiss angedacht.
- `+ Message box`-Verortung: im bestehenden Workspace-Panel neben
  `+ Page`/`+ Bottom-Layer`/`+ Top-Layer`, kein eigener Reiter - fügt sich
  nahtlos in die bereits vorhandene Surface-Auswahl ein.

## 3c. Unterplan: `meter` (Stand 06.08.2026, vor Umsetzung)

### 3c.1 Warum `meter` nochmal anders ist als alles bisher Umgesetzte

`meter` ist ein normaler Eintrag im Widget-Baum (anders als `msgbox`), aber
seine Konfiguration ist **verschachtelter als jedes bisher umgesetzte
Widget**:

```yaml
- meter:
    pad_all: 3
    scales:
      range_from: -10
      range_to: 40
      angle_range: 240
      rotation: 150
      ticks:
        count: 51
        length: 3
        major: { stride: 5, length: 7, label_gap: 6 }
      indicators:
        - line: { id: temperature_needle, width: 2, color: 0xFF0000, length: 90% }
        - tick_style: { start_value: -10, end_value: 40, color_start: 0x0000BD, color_end: 0xBD0000 }
```

Drei Besonderheiten, die ins bestehende `PropertyDef`-Muster nicht passen:

1. **`scales`** ist selbst eine Liste (laut Doku "any number of scales"),
   in der Praxis aber fast immer genau ein Eintrag (wie im Beispiel oben,
   das sogar als einzelnes Mapping statt als Liste geschrieben ist - beides
   ist gültiges ESPHome-YAML).
2. **`indicators`** ist eine Liste von **getaggten Varianten** - jeder
   Eintrag ist *entweder* `arc` *oder* `image` *oder* `line` *oder*
   `tick_style`, mit jeweils komplett unterschiedlichen Feldern. Das ist
   strukturell etwas anderes als die bisherigen Listen (Kacheln, Tabs,
   Buttons), die alle **homogen** sind (jeder Eintrag hat dieselbe Form).
3. **`ticks`** (innerhalb einer Scale) ist ein verschachteltes Dict mit
   einem weiteren verschachtelten `major`-Dict darin.

`ticks`/`indicator`/`items` als **Style-*Parts*** von `meter` selbst sind
dagegen unproblematisch: `STYLE_PARTS` in `model.py` enthält bereits
`"indicator"`, `"ticks"`, `"items"` (aus früheren Widgets) - dieser Teil
braucht **keine Änderung**.

### 3c.2 Architekturentscheidung: Single-Scale-MVP mit einem neuen `json`-Property-Kind

Statt eines komplett neuen, bespoke "verschachtelte Listen von getaggten
Varianten"-Editors (der im Aufwand an einen eigenen Mini-Formular-Builder
heranreicht) wird `meter` bewusst vereinfacht modelliert - dieselbe
Denkweise wie bei `keyboard` (Platzhalter statt Tasten-Simulation) oder
`tabview`/`tileview` im Viewer (kein echtes Wischen):

- **Nur die erste Scale wird editierbar gemacht.** `range_from`,
  `range_to`, `angle_range`, `rotation`, `draw_ticks_on_top` werden als
  normale flache `PropertyDef`s (Kind `float`/`int`/`bool`) direkt auf dem
  `meter`-Widget registriert - identisch zum bisherigen Muster.
- **`indicators` und `ticks` werden als ein neues Property-Kind `json`**
  abgebildet: ein Textfeld, das rohes JSON (Liste bzw. Dict) enthält und
  beim Speichern mit `JSON.parse`/`JSON.stringify` validiert wird - exakt
  dieselbe Parse-/Fehlerbehandlung, die `parseSurfaceObject()`/
  `applySurfaceSettings()` in `app.js` für die Seiten-/Layer-Felder
  `#surface-layout-json`/`#surface-style-json`/`#surface-extra-json` schon
  heute verwenden (dort nur auf Surface-Ebene, hier neu als generisches
  Property-Kind im Eigenschaften-Panel). Farben müssen im JSON als String
  eingegeben werden (z. B. `"0xFF0000"`), es gibt in diesem MVP keinen
  Farb-Picker für Indikator-Felder.
- **Mehrere Scales sind in diesem MVP nicht unterstützt** - eine
  ausdrückliche, dokumentierte Grenze. Ein Import mit mehr als einer Scale
  behält die weiteren Scales unverändert im `extra`-Passthrough (nicht
  editierbar, aber nicht verloren), analog zu jedem anderen unmodellierten
  Schlüssel.

Diese Entscheidung ist bewusst **kein Kompromiss beim Datenverlust** (jedes
Feld bleibt YAML-treu erhalten), sondern nur bei der **Editier-Bequemlichkeit**
für die selteneren/komplexeren Fälle (mehrere Scales, viele Indikatoren mit
Style-Feinschliff) - für den weit überwiegenden Fall (ein Messgerät, eine
Scale, ein bis drei Indikatoren) ist der Aufwand für Nutzer:innen
überschaubar (ein JSON-Textfeld statt zwölf Einzelfelder).

### 3c.3 Import/Export: ein einziger Wrap-/Unwrap-Schritt

Anders als bei `checkbox`/`arc`/`bar`/`led`/`spinner`/`qrcode`/`spinbox`
(die **keine** Änderung an `yamlimport.py`/`yamlexport.py` brauchten, weil
ihre Properties 1:1 flache Top-Level-Schlüssel sind) braucht `meter` einen
kleinen, auf `widget_type == "meter"` beschränkten Sonderfall - kleiner als
bei `tabview`/`tileview`, da hier kein neuer Pseudo-Widget-Typ nötig ist:

- **Export** (`yamlexport.py`, `_widget_dict()` oder ein neuer Helfer
  `_meter_scale_dict()`): die flachen Properties (`range_from`, `range_to`,
  `angle_range`, `rotation`, `draw_ticks_on_top`) plus die geparsten
  `indicators`/`ticks`-JSON-Werte werden zu **einem** Scale-Dict
  zusammengebaut und als `scales: [<dict>]`-Liste mit einem Element
  geschrieben.
- **Import** (`yamlimport.py`, `_classify_widget_body()` oder ein
  meter-spezifischer Vorverarbeitungsschritt): `scales[0]` (erstes Element,
  egal ob als Liste oder einzelnes Mapping im Quell-YAML geschrieben) wird
  in die flachen Properties plus die beiden JSON-Strings zerlegt.
  `scales[1:]` (falls vorhanden) wandert unverändert in `node.extra` (mit
  einer Import-Issue "C" analog zum bestehenden Muster für unmodellierte
  Schlüssel).
- Indikator-`id:`-Werte (z. B. `temperature_needle` oben) werden zusätzlich
  in der `IdRegistry` registriert (Kollisionsprüfung), obwohl der Rest des
  Indikators nicht modelliert wird - sonst könnte ein Indikator-Id
  unbemerkt mit einer echten Widget-Id kollidieren.

### 3c.4 Frontend

- Neues Property-Kind `json` in `propertyControl()`/`applyPropertyValue()`
  (`app.js`): ein `<textarea>`, das den aktuellen Wert mit
  `JSON.stringify(value, null, 2)` vorbefüllt und beim Verlassen des Felds
  mit `JSON.parse` validiert (Fehleranzeige analog zu
  `parseSurfaceObject()`).
- Keine weiteren UI-Änderungen nötig - `meter` ist ein normales,
  eigenständiges Widget (kein `allows_children`, keine Pseudo-Kinder), die
  Palette/Kategorie-Zuordnung (`CATEGORY_DISPLAY`) funktioniert wie gehabt.

### 3c.5 Viewer

Ein Meter ganz ohne visuelle Darstellung im Viewer wäre unbefriedigend -
der Sinn des Widgets ist gerade die Visualisierung. Geplanter Umfang für
eine erste Runde (bewusst *nicht* zurückgestellt wie bei `canvas`):

- Hintergrund-Skala (Ticks): ein Kranz kleiner Linien, per Winkelberechnung
  aus `angle_range`/`rotation`/`ticks.count` erzeugt - dieselbe
  Trigonometrie wie in `arcPoint()`/`describeViewerArc()` (schon für `arc`
  vorhanden), nur mehrfach statt einmal angewendet.
  `ticks.major`-Beschriftung optional in einer ersten Runde weglassen.
- Jeder `indicators`-Eintrag wird nach Typ gerendert:
  - `arc`: wiederverwendet dieselbe SVG-Bogen-Logik wie das `arc`-Widget.
  - `line`: eine rotierte SVG-Linie vom Skalenmittelpunkt aus, Winkel aus
    `value` relativ zu `range_from`/`range_to`/`angle_range` berechnet.
  - `image`: ein rotiertes `<img>`, Pivot aus `pivot_x`/`pivot_y`.
  - `tick_style`: in der ersten Runde ignoriert (reine Farbmodifikation der
    Ticks in einem Wertebereich - kosmetische Verfeinerung, kein
    eigenständig sichtbares Element).
- **`lvgl.indicator.update` wird in dieser ersten Runde nicht simuliert**
  (bewusster Nicht-Ziel-Eintrag, siehe unten) - der Meter zeigt im Viewer
  nur die in `indicators[].value`/`start_value`/`end_value` hinterlegten
  Startwerte, keine Laufzeit-Aktualisierung. Grund: die Indikatoren sind
  nicht in der `IdRegistry`-artigen Live-Objekt-Struktur, die
  `applyViewerAction()` für andere `lvgl.*.update`-Aktionen nutzt, sondern
  nur JSON-Text - ihn dafür live durchsuchbar zu machen wäre ein
  eigenständiges Stück Arbeit, das besser in einer separaten Runde bewertet
  wird, nachdem klar ist, ob überhaupt Bedarf an Live-Metern besteht.

### 3c.6 Tests

Analog zum bestehenden Muster: Roundtrip-Test in `test_designer.py`
(Import → Export → Import, `scales[0]` korrekt zu flachen Properties plus
JSON-Strings zerlegt und wieder zusammengesetzt), plus ein Fall mit
mehreren Scales, der bestätigt, dass `scales[1:]` unangetastet in `extra`
landet. Kein `viewer_runtime.test.mjs`-Test für `lvgl.indicator.update`,
da diese Action bewusst nicht simuliert wird (siehe 3c.5).

### 3c.7 Nicht-Ziele dieser ersten `meter`-Runde

- Mehrere Scales gleichzeitig editierbar.
- Ein dediziertes Formular für einzelne Indikatoren (Hinzufügen per Klick,
  Typ-Auswahl arc/image/line/tick_style, Einzelfelder) - JSON-Textfeld nur.
- `lvgl.indicator.update`-Simulation im Viewer.
- `tick_style`-Indikatoren visuell im Viewer (nur Ticks selbst, keine
  Farbverlauf-Modifikation).

Diese Punkte sind explizit spätere Ausbaustufen, keine endgültigen Grenzen -
es lohnt sich, sie erneut zu bewerten, sobald echte Nutzung zeigt, welche
dieser Vereinfachungen tatsächlich stört.

## 4. Zielarchitektur pro Widget

Für jedes neue Widget, exemplarisch am Muster der bestehenden Typen:

1. **`widgetschema.py`**: `WidgetSchema`-Eintrag mit `type_key`, Label
   (de/en), Default-Größe, Content-/Style-/Layout-`PropertyDef`s,
   ggf. `parts` (z. B. `indicator`, `knob` bei `arc`/`bar`/`slider`),
   `allows_children` falls zutreffend.
2. **`yamlimport.py`**: Erkennung und Umwandlung der ESPHome-YAML-Struktur
   in `WidgetNode`, inkl. Migration bereits vorhandener echter Configs
   (Testfälle mit realistischem YAML-Ausschnitt).
3. **`yamlexport.py`**: Rückwandlung in gültiges ESPHome-YAML, inkl.
   Property-Validierung/-Allowlist wie bei den bestehenden Typen.
4. **`designer.py`**: Validierungsregeln (Id-Kollisionen, Pflichtfelder,
   erlaubte Werte) analog zu bestehenden Typen.
5. **`frontend/app.js`**: Palette-Eintrag, Property-Panel-Rendering für
   etwaige Sonderfälle (z. B. Options-Editor für `dropdown`/`roller`,
   analog zum bestehenden Bild-Button-Sonderfall).
6. **`frontend/viewer/viewer.js`**: Falls noch nicht vorhanden (bei `arc`/
   `bar` schon der Fall), Rendering + `applyViewerAction()`-Unterstützung
   für die neuen Widget-Aktionen.
7. **`frontend/i18n.js`**: Deutsche/englische Labels für alle neuen
   Properties, analog zum bestehenden Muster.
8. **Tests**: pro Widget mindestens Import-, Export- und
   Validierungs-Testfälle, wie es bereits für die 8 unterstützten Typen
   existiert (`tests/test_yamlimport.py`, `tests/test_designer.py`, etc.).

## 5. Risiken und offene Fragen

- Jedes neue Widget-Schema vergrößert die Property-Panel-Komplexität - bei
  `meter` (Skalen mit mehreren Nadeln/Bögen) muss geprüft werden, ob sich
  das noch sinnvoll in das bestehende flache Property-Panel-Muster einfügt,
  oder ob ein verschachtelter Editor nötig wird (ähnlich der Sonderbehandlung
  beim Bild-Button).
- `dropdown`/`roller` brauchen eine Listen-Editor-UI für die Optionsliste -
  noch kein bestehendes Muster dafür im Code, muss neu entworfen werden.
- `keyboard` ist ohne eine gebundene `textarea` meist sinnlos - die beiden
  sollten nicht unabhängig voneinander, sondern als Paar mit einer klaren
  Zuordnungs-UI eingeführt werden.
- Erweiterung der Stil-Property-Liste (Punkt "2. Stil-Eigenschaften" aus der
  vorherigen Analyse) ist ein Querschnittsthema - sollte nicht separat,
  sondern jeweils zusammen mit dem Widget behandelt werden, das die
  zusätzliche Property zuerst braucht (z. B. `arc`/`bar`-spezifische
  Indikator-Stile erst bei deren Umsetzung ergänzen).
- Die Aktions-Allowlist (aktuell nur für `button`) muss pro neuem Widget um
  dessen sinnvolle, sicher simulierbare Trigger/Aktionen erweitert werden
  (z. B. `on_value` bei `dropdown`/`roller`, `on_ready` bei `textarea`) -
  jeweils mit derselben Vorsicht wie beim bestehenden Mechanismus (feste
  Allowlist, keine beliebige Aktionsausführung).

## 6. Umsetzungsschritte

1. ✅ `checkbox` umgesetzt (kleinster Schritt, validiert das Muster für neue
   Typen erneut end-to-end).
2. ✅ `arc` und `bar` umgesetzt (Viewer-Rendering existierte bereits,
   Aufwand war Editor-Schema + Tests; Import/Export brauchten dank des
   schema-getriebenen Codes in `yamlimport.py`/`yamlexport.py` keine
   Änderung).
3. ✅ Options-Listen-Editor-UI entworfen und für `dropdown` und `roller`
   umgesetzt (neuer Property-Kind `text_list`, komma-getrennte Eingabe wie
   beim bestehenden `image_ref_list`/`grid_track_list`-Muster - kein neuer,
   aufwendigerer Editor nötig). Dropdown/Roller sind jetzt vollständig im
   Viewer nutzbar: eigenes Rendering als natives `<select>`, Klick-/
   Tastatur-Interaktion, `lvgl.dropdown.update`/`lvgl.roller.update` in der
   Aktions-Allowlist, und `selected_index` als Live-Binding-Ziel.
4. ✅ `textarea` + `keyboard` als Paar umgesetzt. Neuer Property-Kind
   `widget_ref` (Auswahlfeld über die passenden Projekt-Widgets, hier auf
   `textarea`-Typen gefiltert) für `keyboard.textarea`. Im Viewer rendert
   `textarea` als natives `<textarea>`/`<input>` (abhängig von `one_line`,
   inkl. `password_mode` → `type="password"`), tippt sich direkt über die
   echte Tastatur; `keyboard` bleibt bewusst ein nicht-interaktiver visueller
   Platzhalter (siehe Nebenbefund unten). `lvgl.textarea.update`/
   `lvgl.keyboard.update` in der Aktions-Allowlist, `text` als
   Live-Binding-Ziel für `textarea` (nutzt denselben Ziel-Namen wie `label`).
5. Phase 1 damit vollständig abgeschlossen. Nächster Schritt: Phase 2
   (`tabview`, `tileview`, `meter`) angehen, oder erst erneute
   Bestandsaufnahme anhand von Nutzer-Feedback, ob sich die Prioritäten
   verschoben haben.

### Nebenbefund aus Schritten 1-4

Die Architektur ist konsequenter schema-getrieben als der Plan ursprünglich
annahm: `_widget_dict()`/`_classify_widget_body()` iterieren generisch über
`WidgetSchema.properties` und `LVGL_STYLE_KEYS`, ohne Fallunterscheidung nach
Widget-Typ. Für `checkbox`/`arc`/`bar` waren daher **keine** Änderungen an
`yamlimport.py`, `yamlexport.py` oder der Property-Panel-Rendering-Logik in
`app.js` nötig - nur die `WidgetSchema`-Registrierung selbst. Für
`dropdown`/`roller` stimmte das nur teilweise: Import/Export brauchten
ebenfalls keine Änderung, aber ein neuer Property-Kind (`text_list`) und ein
zusätzlicher Style-Part (`list`, für das Dropdown-Menü) waren nötig - Letzterer
mehrfach, weil `STYLE_PARTS` als Konstante an drei Stellen unabhängig
geführt wird (`model.py`, eine eigene Kopie in `yamlexport.py`, eine weitere
in `viewer.js`). Für `keyboard` war die vermutete Zuordnungs-UI tatsächlich
nötig (neuer Kind `widget_ref`), aber auch hier keine Import-/Export-Änderung
- `keyboard.textarea` ist für `yamlimport.py`/`yamlexport.py` einfach ein
gewöhnlicher String-Content-Wert, die Picker-Logik lebt komplett im Frontend.
Das Viewer-Rendering von `keyboard` als bloßer Platzhalter statt eines echten
simulierten Tasten-Layouts ist eine bewusste Abgrenzung, kein technisches
Muss: der Aufwand für ein vollständiges QWERTY-/Zahlen-/Sonderzeichen-Layout
mit Umschaltung stünde in keinem Verhältnis zum Nutzen, da im Browser-Viewer
ohnehin die echte Host-Tastatur bereits direkt in die `textarea` tippt.

## 7. Nicht-Ziele

- Keine Änderung an der "unbekannte Widgets bleiben roh erhalten"-Garantie -
  auch nach Abschluss aller Phasen bleiben immer Widgets/Properties denkbar,
  die der Designer nicht kennt (neue ESPHome-Versionen, exotische
  Kombinationen). Der sichere Fallback bleibt bestehen.
- Keine hardwarenahe Konfiguration (`touchscreens`, `encoders`, `keypads`
  usw.) - siehe Abgrenzung.
- Keine vollständige 1:1-Nachbildung aller ~90 LVGL-Stil-Properties in einem
  großen Schritt.
