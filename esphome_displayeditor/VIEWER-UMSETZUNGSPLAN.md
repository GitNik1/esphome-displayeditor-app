# Umsetzungsplan: Browser-Viewer für den ESPHome Display Editor

## Aktueller Stand (31.07.2026)

- V1/V2 umgesetzt: isolierter Projekt-Clone, eigener Viewer-Renderer,
  Vollbilddialog, Zoom, Einpassen, Rotation, Reset und GlowLine-Ebenen.
- V3-Kern umgesetzt: Theme-, benannte und Inline-Stile mit Zuständen,
  Switch-/Slider-Teile, Farben, Verläufe, Deckkraft, Rahmen, Radius, Schatten,
  Schriftgröße, Ausrichtung, Padding und Abstände.
- V4-Kern umgesetzt: interaktive Buttons, Switches und Slider sowie eine feste
  Action-Allowlist für Widget show/hide/update, Label-/Slider-/Switch-Updates
  und Animimg start/stop. Unbekannte oder ungültige Aktionen werden nur
  protokolliert und niemals dynamisch ausgeführt.
- V5 umgesetzt: `pages`, `page_wrap`, `skip`, `top_layer` und `bottom_layer`
  werden durch eine Add-on-Erweiterung aus dem unveränderten Core-Passthrough
  materialisiert, bleiben beim YAML-Roundtrip erhalten und können im Viewer
  per Toolbar oder erlaubter Seitenaktion gewechselt werden. Die
  schreibgeschützte Desktop-Grundlage und Projektformat 3 bleiben unverändert.
- Noch offen aus V3: visuelle Referenztests und ein optionaler RGB565-Schalter.

## 1. Ziel

Der ESPHome Display Editor erhält einen schreibgeschützten Viewer, der ein
geladenes `.lvgldesign`-Projekt oder eine importierte ESPHome-LVGL-Konfiguration
direkt im Home-Assistant-Ingress darstellt und grundlegende Touch-Interaktionen
simuliert.

Der Viewer soll:

- vollständig im Browser laufen
- den Entwurf und die aktive ESPHome-Datei niemals verändern
- dieselbe Layoutberechnung wie der Designer verwenden
- Bearbeitungsrahmen, Griffe und Hierarchie ausblenden
- Widget-Zustände und eine begrenzte Auswahl sicherer LVGL-Aktionen simulieren
- nicht unterstützte Eigenschaften und Aktionen sichtbar kennzeichnen
- später durch einen LVGL-WebAssembly-Renderer erweitert werden können

## 2. Abgrenzung

Der Browser-Viewer ist zunächst eine kontrollierte Simulation. Er führt keine
ESPHome-Lambdas, C++-Fragmente, Skripte oder beliebigen Automationen aus.

Nicht Bestandteil des MVP:

- Kompilierung einer ESPHome-Host-Anwendung
- SDL-/VNC-Streaming aus dem App-Container
- Live-Framebuffer eines realen ESPHome-Geräts
- Ausführung von Home-Assistant-Diensten
- Ausführung beliebiger `on_*`-Aktionslisten
- vollständige Pixelgleichheit mit LVGL

## 3. Zielarchitektur

```text
Projektquelle
├── aktuell geladenes .lvgldesign-Projekt
├── gespeichertes .lvgldesign-Projekt
└── aktive oder als Entwurf gespeicherte ESPHome-YAML
        ↓
normalisiertes Project-Modell
        ↓
gemeinsame Layoutberechnung (layout.js)
        ↓
ViewerRuntime
├── isolierter Laufzeitzustand
├── Seiten- und Sichtbarkeitszustand
├── Widget-Werte und LVGL-Zustände
└── sichere Action-Allowlist
        ↓
ViewerRenderer
├── HTML/CSS-Renderer (MVP)
└── LVGL-WASM-Renderer (optional später)
```

Wichtig: Editor und Viewer verwenden dasselbe Projektmodell, aber niemals
denselben veränderbaren Laufzeitzustand. Beim Öffnen des Viewers wird ein
strukturierter Clone erzeugt.

## 4. Umsetzungsschritte

### V1: Rendering vom Editor entkoppeln

Ziele:

- Darstellung und Bearbeitungslogik voneinander trennen
- eine wiederverwendbare Renderer-Schnittstelle definieren
- vorhandene Designer-Funktionen unverändert erhalten

Geplante Änderungen:

- `frontend/viewer/model.js`
  - Projekt normalisieren
  - unveränderliche Ausgangsdaten und Laufzeitzustand trennen
- `frontend/viewer/style.js`
  - LVGL-Farben, Deckkraft, Radius, Rahmen, Schatten und Textstile in sichere
    CSS-Werte übersetzen
- `frontend/viewer/renderers.js`
  - Renderer-Registry pro unterstütztem Widgettyp
- bestehende Layoutberechnung aus `frontend/layout.js` unverändert wiederverwenden
- gemeinsame Bildauflösung aus `frontend/app.js` herauslösen

Unterstützte Widgettypen des ersten Schritts:

- `obj`
- `container`
- `label`
- `button`
- `switch`
- `slider`
- `image`
- `animimg`

Abnahmekriterien:

- bestehende Designer-Projekte sehen nach dem Refactoring nicht schlechter aus
- Layoutpositionen im Designer und Viewer stimmen überein
- nicht unterstützte Werte führen nicht zu JavaScript-Fehlern
- alle bestehenden Backend- und Frontendtests bleiben erfolgreich

### V2: Viewer-Oberfläche

Ziele:

- Viewer aus dem Designer und aus der Konfigurationsansicht öffnen
- klare Trennung zwischen Bearbeiten und Betrachten

Geplante Oberfläche:

- Button `Viewer öffnen` in der Designer-Werkzeugleiste
- Button `Vorschau` für aktive Konfiguration oder Entwurf
- bildschirmfüllender Dialog innerhalb des Ingress-Fensters
- Toolbar mit:
  - Schließen
  - Neu starten
  - Einpassen
  - Zoom 25–400 %
  - 1:1
  - Rotation 0/90/180/270 Grad
  - optionaler Status-/Warnungsanzeige
- Kennzeichnung `Browser-Simulation – nicht pixelgenau`
- Viewer-Canvas mit festem Display-Seitenverhältnis

Geplante Dateien:

- `frontend/index.html`: Viewer-Dialog und Bedienelemente
- `frontend/styles.css`: isolierte Viewer-Stile
- `frontend/viewer/viewer.js`: Lebenszyklus, Zoom und Eingaben
- `frontend/app.js`: Öffnen/Schließen und Projektübergabe

Abnahmekriterien:

- Viewer funktioniert über Home Assistant Ingress
- keine Navigation verlässt die App
- Viewer verändert weder Projekt noch YAML-Entwurf
- Escape und Schließen beenden Animationen und Timer
- Desktop-, Tablet- und Mobilansicht bleiben bedienbar

### V3: Darstellungsgenauigkeit

Ziele:

- alle bereits im Editor angebotenen Stilwerte sichtbar machen
- Widgetteile getrennt darstellen

Umzusetzende Stile:

- Hintergrundfarbe und Deckkraft
- horizontaler und vertikaler Verlauf
- Rahmenfarbe und Rahmenbreite
- Radius
- Schattenfarbe, Breite, Versatz, Ausbreitung und Deckkraft
- Textfarbe, Schriftgröße/Font-Zuordnung und Textausrichtung
- Padding sowie Flex-/Grid-Abstände
- Zustandsstile für `pressed`, `checked`, `focused` und `disabled`
- `indicator` und `knob` für Switch und Slider

Regeln:

- CSS-Werte werden ausschließlich durch feste Konverter erzeugt
- keine Projektwerte werden als `innerHTML` eingesetzt
- externe Bildquellen werden nur über die vorhandene Asset-Logik geladen
- unbekannte Styles werden ignoriert und als Viewer-Warnung gezählt

Abnahmekriterien:

- Stildefinitionen, Theme und Inline-Stile folgen derselben Priorität
- Switch und Slider zeigen Hauptteil, Indikator und Knopf getrennt
- RGB565-Vorschau kann optional ein- und ausgeschaltet werden
- visuelle Referenztests decken jeden unterstützten Widgettyp ab

### V4: Interaktionen und sichere Action-Runtime

Ziele:

- typische Displayabläufe im Browser ausprobieren
- keinerlei beliebigen ESPHome-Code ausführen

Viewer-Zustände:

- `default`
- `pressed`
- `checked`
- `focused`
- `disabled`
- `hidden`
- Widgetwert für Slider und Switch

Erste erlaubte Aktionen:

- `lvgl.widget.show`
- `lvgl.widget.hide`
- `lvgl.widget.update`
- `lvgl.label.update`
- `lvgl.page.show`
- `lvgl.page.next`
- `lvgl.page.previous`
- `lvgl.animation.start`
- `lvgl.animation.stop`

Nicht ausgeführt werden:

- Lambdas
- `homeassistant.service`
- Skripte
- HTTP-Anfragen
- Gerätebefehle
- Factory Reset, Restart, Safe Mode oder OTA
- unbekannte Aktionsnamen

Nicht unterstützte Aktionen erscheinen in einem Ereignisprotokoll als
`übersprungen`, ohne den Viewer abzubrechen.

Abnahmekriterien:

- Klicks auf Buttons können Container ein-/ausblenden
- Switch und Slider ändern nur den isolierten Viewer-Zustand
- unbekannte Aktionen werden niemals dynamisch aufgerufen
- wiederholtes Öffnen erzeugt keinen mehrfach laufenden Timer
- `Viewer zurücksetzen` stellt exakt den Projekt-Ausgangszustand wieder her

### V5: Seiten und Layer

Der aktuelle Importer visualisiert nur `lvgl.widgets`. Für einen brauchbaren
Viewer werden zusätzlich benötigt:

- `lvgl.pages`
- `top_layer`
- `bottom_layer`
- aktive Startseite
- `page_wrap` und `skip`
- Seitenlayouts und Seitenstile

Umgesetzte Add-on-Darstellung:

```json
{
  "pages": [
    {
      "id": "main_page",
      "widgets": [],
      "layout": {},
      "style_tree": {},
      "skip": false
    }
  ],
  "top_layer": { "widgets": [] },
  "bottom_layer": { "widgets": [] }
}
```

Die Seiten werden aus `extra_lvgl` in diese schreibgeschützte Viewer-Struktur
materialisiert. Die unveränderten Rohdaten bleiben parallel erhalten und sind
weiterhin die Quelle für Speichern und Export. Dadurch bleiben die gemeinsamen
Core-Dateien bytegleich mit der schreibgeschützten Desktop-Anwendung; eine
Formatänderung oder Migration ist nicht erforderlich. Root-Widget-Projekte
werden im Viewer wie eine synthetische Standardseite behandelt.

Betroffene Add-on-Dateien:

- `backend/page_support.py`
- `backend/designer.py`
- `backend/project_store.py`
- `frontend/viewer/viewer.js`
- `frontend/app.js`

Abnahmekriterien:

- Import und Export erhalten Seiten ohne Informationsverlust
- Viewer zeigt immer genau eine aktive Seite sowie Top-/Bottom-Layer
- Seitenwechsel funktionieren über Toolbar und erlaubte Aktionen
- alte `.lvgldesign`-Projekte bleiben ladbar

### V6: Optionale Laufzeitdaten

Nach Fertigstellung des lokalen Viewers können vorhandene Native-API-Zustände
als schreibgeschützte Testdaten verwendet werden.

Vorgehen:

- explizite Zuordnung eines Viewer-Felds zu einer vorhandenen Geräteentität
- Zustände nur über die eigene App-WebSocket-API beziehen
- Verbindungsstatus im Viewer anzeigen
- bei Verbindungsabbruch auf den letzten Wert oder einen Platzhalter wechseln
- keine Gerätesteuerung aus dem Viewer-MVP

Abnahmekriterien:

- nur konfigurierte Geräte und bereits freigegebene Zustände sind verwendbar
- Schlüssel und interne Verbindungsdaten erreichen den Browser nicht
- Viewer bleibt auch ohne Gerät vollständig nutzbar

### V7: LVGL-WebAssembly-Prototyp

Diese Phase beginnt erst nach erfolgreicher Abnahme von V1 bis V5.

Ziele des Prototyps:

- LVGL 9 mit Emscripten als statisches WASM-Modul bauen
- LVGL-Version an die ESPHome-Kompatibilitätsmatrix koppeln
- Label, Button, Switch und Slider über eine feste JavaScript/C-Schnittstelle erzeugen
- Touchkoordinaten vom Browser an LVGL übergeben
- gerenderten Frame in einem Browser-Canvas anzeigen
- Ladezeit, Speicherbedarf und Ingress-Kompatibilität messen

Sicherheitsanforderungen:

- vorgebautes, versioniertes WASM statt Kompilierung im laufenden App-Container
- keine Übergabe oder Ausführung von C++-Lambdas
- keine dynamisch geladenen nativen Bibliotheken
- keine Netzwerkzugriffe aus dem WASM-Modul
- Integritätsprüfung der ausgelieferten WASM-Datei

Entscheidung nach dem Prototyp:

- HTML-Renderer als Standard und WASM als `genaue Vorschau`, oder
- WASM ersetzt den HTML-Renderer, falls Funktionsumfang, Startzeit und Wartbarkeit
  ausreichend sind

## 5. API- und Berechtigungskonzept

Der Viewer selbst benötigt keine neuen schreibenden Endpunkte.

Empfohlene Capability:

```json
{
  "designer.viewer": true
}
```

Rollenzuordnung:

- Viewer: gespeicherte Projekte und aktive Konfiguration betrachten
- Editor: zusätzlich lokalen Entwurf betrachten
- Publisher/Installer/Administrator: keine zusätzlichen Viewer-Sonderrechte

Falls eine aktive YAML direkt geöffnet wird, nutzt das Frontend den bestehenden
Import-Endpunkt nur zum Normalisieren. Das Ergebnis bleibt im Browser und wird
nicht automatisch als Projekt gespeichert.

## 6. Testplan

### Unit-Tests

- Style-Konvertierung
- Style-Priorität Theme → Named Style → Inline → State
- Viewer-State ohne Mutation des Projektobjekts
- sichere Action-Allowlist
- Seitenwechsel und `page_wrap`
- unbekannte Aktionen und Widgettypen
- Timerbereinigung für Animimg und Glow-Animationen

### API-Tests

- Viewer-Capability für alle Rollen
- Import einer aktiven und einer Draft-Konfiguration
- kein Schreibzugriff durch Viewer-Rolle
- übergroße Projekte und ungültige Assets werden abgelehnt

### Browser-Tests

- Öffnen, Schließen, Zurücksetzen
- Zoom, Einpassen und Rotation
- Button, Switch und Slider
- Show/Hide-Navigation mit der vorhandenen P4-Testkonfiguration
- Seite vor/zurück
- Mobilansicht
- keine Fehler in Browserkonsole

### Visuelle Tests

Für jeden unterstützten Widgettyp wird eine kleine feste Referenzkonfiguration
angelegt. Screenshots werden bei gleicher Browsergröße verglichen. Kleine
Antialiasing-Abweichungen werden toleriert, Geometrie und Farben nicht.

### Sicherheitstests

- HTML-/Script-Injection über Labels und Build-/Eventtexte
- schädliche Bild-URLs
- extrem große Canvas-Werte
- sehr tiefe Widget-Hierarchien
- zyklische oder unbekannte Ziel-IDs
- Event-Schleifen
- unbekannte Aktionsnamen
- manipulierte `.lvgldesign`-Dateien

## 7. Reihenfolge und Aufwand

| Paket | Inhalt | Grobe Größe |
|---|---|---:|
| V1 | Renderer entkoppeln | mittel |
| V2 | Viewer-Dialog und Zoom | klein bis mittel |
| V3 | Stil- und Widgetdarstellung | mittel bis groß |
| V4 | Interaktionen und Action-Runtime | mittel |
| V5 | Seiten und Layer | groß |
| V6 | optionale Livezustände | mittel |
| V7 | LVGL-WASM-Prototyp | groß, separat bewerten |

Empfohlene Releases:

- `0.11.0`: V1–V2, schreibgeschützte statische Vorschau
- `0.12.0`: V3–V4, interaktive Browser-Simulation
- `0.13.0`: V5, Seiten und Layer
- `0.14.0`: optional V6, Native-API-Testwerte
- spätere Haupt-/Minor-Version: V7 nach Prototypentscheidung

## 8. MVP-Abnahme

Der Viewer-MVP ist abgeschlossen, wenn:

1. ein Projekt mit einem Klick im Vollbild-Viewer geöffnet werden kann,
2. der Viewer keine Editorfunktionen oder Schreibendpunkte auslöst,
3. alle acht aktuell unterstützten Widgettypen sinnvoll dargestellt werden,
4. Flex- und Grid-Layouts dieselben Positionen wie der Designer verwenden,
5. Button, Switch, Slider und Animimg lokal funktionieren,
6. Show/Hide- und Label-Update-Aktionen sicher simuliert werden,
7. unbekannte Aktionen nur als Warnung erscheinen,
8. Schließen und Zurücksetzen alle temporären Zustände und Timer entfernen,
9. Tests, Containerstart und Home-Assistant-Ingress-Prüfung erfolgreich sind.

## 9. Empfehlung

Die Umsetzung beginnt mit V1 und V2. Dadurch entsteht schnell ein nutzbarer,
risikoarmer Viewer. V3 und V4 machen ihn anschließend interaktiv. Seiten und
Layer werden als eigene Modelländerung umgesetzt, damit Import/Export und
Viewer dieselbe Struktur verwenden. LVGL-WebAssembly bleibt ein separater
Prototyp und wird nicht zur Voraussetzung für den Browser-Viewer gemacht.
