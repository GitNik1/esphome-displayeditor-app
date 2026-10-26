# Umsetzungsplan: Gesamttest und Optimierung

## Aktueller Stand (26.10.2026, Version 0.401.0)

Am 26.10.2026 wurde die ganze Software getestet: automatische Prüfungen, das echte
Backend lokal mit den Konfigurationen aus `tests/data/` im Browser durchgeklickt, dazu
drei Code-Analysen (Bedienung/Frontend, Backend-Qualität, offene Punkte gegen
`LVGL-VOLLSTAENDIGKEIT-UMSETZUNGSPLAN.md`, `VIEWER-UMSETZUNGSPLAN.md`,
`MCP-UMSETZUNGSPLAN.md`) und eine Gegenprüfung der Lösungswege. Alle Fehler unten
wurden im Code oder per Reproduktion nachgeprüft.

Freigegebener Umfang der ersten Runde: **Phase 0 bis 2**. Phase 3–5 sind die Roadmap.
Entscheidung zu A6: Versionsgrenze des Device Builders ohne Live-Test auf
`< 2026.11` anheben.

| Schritt | Inhalt | Stand |
|---|---|---|
| Phase 0 | venv (Python 3.13, `mcp` 2.0) + `npm ci`, `scripts/dev_server.py`, Plan im Repo | erledigt |
| A1a | Merge: Blockgrenzen, Gesamtprüfung, defekte Entwürfe | offen |
| A1b | Merge: Round-Trip-Treue | offen |
| A2 | Bilder-Negativcache, Rate-Limit-Buckets | offen |
| A3 | Kurzbefehle | offen |
| A4 | Undo-Schnappschuss erst bei echter Änderung | offen |
| A5 | Autosave-Wiederherstellung speicherbar | offen |
| A6 | Builder bis ESPHome 2026.10, Grund statt „Keine Berechtigung“ | offen |
| A7 | Viewer-Bindungsziele Frontend/Backend | offen (eigene Session vorgeschlagen) |
| A8 | Kern-Sync-Test zeilenendenneutral | offen |
| A9 | Docker-Healthcheck | offen |
| A10 | Entwurfsrevision bei Speichern/Merge/Veröffentlichen | offen |
| A11 | Event-Loop entlasten | offen |
| A12 | MCP-Token-Vergleich mit Nicht-ASCII | offen |
| Phase 2 | Speichern, Toasts, Fokus, Hinweise, i18n | offen |

## 1. Testergebnis (Ausgangslage)

| Prüfung | Ergebnis |
|---|---|
| Frontend-Unit-Tests (`node --test`) | 201/201 grün |
| TypeScript strict (`tsc`; alle Module mit `@ts-check` außer generiertem `lvgl-wasm.js`) | grün |
| Ruff, `tools/check_architecture.py` | grün |
| Backend `pytest` (venv, Python 3.13, `mcp` 2.0) | grün, Coverage ≥ 83 % |
| Playwright-E2E | 31/31 grün |
| Manueller Durchlauf mit echtem Backend | Fehler A1–A3 gefunden |

## 2. Bestätigte Fehler

**A1 – Zurückschreiben in eine bestehende Konfiguration zerstört den `lvgl:`-Block.**
`tests/data/p4_86_panel.yaml` importieren und unverändert „Als Entwurf speichern“ →
Entwurf mit doppelten Keys `layout`/`widgets` und 18 doppelten Widget-IDs; die App
meldet „Entwurf gespeichert“. Veröffentlichen verweigert den Entwurf
(`filesystem._yaml_error`), die aktive Datei bleibt heil.
- Ursache: `_find_top_level_block` (`backend/lvgl_merge.py`) beendet den Block an der
  ersten nicht eingerückten Zeile – hier die auskommentierte Zeile
  `#        pad_left: 6` in Spalte 0. Der Patcher bekommt 99 statt ~600 Zeilen, der
  Rest bleibt stehen. Gleiches gilt für `_merge_entity_binding_actions`. Bestand schon
  vor 0.401 (der Ganzblock-Ersatz schnitt an derselben Stelle).
- Der Nachher-Check in `yaml_patch.patch_top_level_block` sieht nur den Ausschnitt und
  lädt mit `_ImportLoader`, der doppelte Keys still akzeptiert.
- Unveränderter Round-Trip ändert die Datei trotzdem: Glyphen-Liste sortiert
  (`designer_core/yamlexport.py:436`, Escapes und Kommentare gehen verloren),
  `align: TOP_LEFT` entfernt (`yamlexport.py:223`), `widgets: []` am leeren
  `bottom_layer` ergänzt (`page_support.py:168-172`).

**A2 – Fehlende Bilder fluten die API.** Ein `animimg` mit fehlenden Frames lädt jedes
404-Bild bei jedem Frame-Wechsel neu (der Viewer baut pro Tick ein neues `<img>`,
`viewer/widget-content.js:153-160`) → nach wenigen Minuten 128× HTTP 429. Schreibende
Aufrufe verbrauchen zusätzlich das allgemeine Kontingent (`security.py:29-31`), also
scheitert dann auch Speichern. Alle `/api/v1/`-Antworten tragen `no-store`
(`app.py:217-218`).

**A3 – Kurzbefehle** (`frontend/app.js`, Listener in `bindDesigner`): Ctrl+Shift+Z macht
Undo statt Redo; Ctrl-Kürzel greifen in Eingabefeldern; Delete/Pfeile wirken hinter
offenen Dialogen; Cmd (Mac), Backspace, Ctrl+C/V/A fehlen.

**A4 – Redo geht beim Anklicken verloren.** `pushUndo()` leert Redo und läuft schon bei
Pointer-Down und Feld-Fokus. Zusätzlich legt ein reiner Klick einen identischen
Schnappschuss ab – das erste Ctrl+Z scheint nichts zu tun.

**A5 – Speichern nach Autosave-Wiederherstellung scheitert.** Restore setzt die Revision
auf `null` und übernimmt den Projektnamen nicht ins Feld `#project-name` → 409
`project_exists` bzw. Speichern unter falschem Namen.

**A6 – Device Builder sperrt ESPHome ≥ 2026.9** (`backend/builder/compatibility.py`);
die gesperrten Buttons zeigen „Keine Berechtigung für diese Aktion.“.

**A7 – Viewer-Live-Bindungen:** Frontend bietet textarea/checkbox/dropdown/roller inkl.
`selected_index` an, das Backend (`viewer_bindings.py`) nur label/slider/bar/arc/switch
→ 422.

**A8 – Kern-Sync-Test** (`tests/test_core_sync.py`) vergleicht byte-genau, die
Desktop-Kopie hat CRLF → schlägt im Haupt-Checkout fehl, läuft in CI/Worktrees nicht.

**A9 – Docker-HEALTHCHECK** fragt `127.0.0.1:8099/api/v1/health`, die Ingress-Sperre
antwortet 403 → Container dauerhaft „unhealthy“.

**A10 – Entwürfe ohne Revisionsprüfung:** Entwurf speichern/Merge ohne erwartete
Entwurfsrevision, Veröffentlichen prüft nur die aktive Datei – ein inzwischen geänderter
Entwurf würde ungesehen veröffentlicht.

**A11 – Blockierende Arbeit im Event-Loop:** 82 `async def`-Routen, nur 3
`to_thread`-Aufrufe; `/assistant/ask` macht bis zu 6 synchrone HTTPS-Aufrufe.

**A12 – Nicht-ASCII-Bearer-Token** → unauthentifiziert HTTP 500
(`secrets.compare_digest` auf `str`).

## 3. Optimierungspotenzial Bedienung

Hoch: Speichern versteckt („In App speichern“ im eingeklappten Abschnitt, Ctrl+S lädt
JSON herunter, nach Reload leeres Projekt); Meldungen hinter modalen Dialogen und nur
ein Toast-Slot; Fokusverlust beim Tippen (Theme-/Layout-Felder rendern bei `input` neu);
benannte Stile sperren das Panel, Anlage per `prompt()`, keine Verwaltung;
Firmware-Ablauf (Prüfen/Diff auf gespeicherter Datei, Validierung erst nach
Veröffentlichen, nur letzte Logzeile); Onboarding (Standardrolle `viewer`, UUID muss
man selbst finden); System-Tab zeigt rohes JSON.

Mittel: Unsaved-Warnung ohne YAML-Editor; Viewer/Export markieren das Projekt als
geändert (Glow-Baking); `prompt()`/`confirm()` in Kernabläufen; Buttons während
Requests aktiv; Canvas ohne Mausrad-Zoom, Pan, Copy/Paste, Z-Order; Aktionen nicht
bearbeitbar; drei Bindungsbegriffe; Clipboard über HTTP; feste Spaltenbreiten;
~25 hart codierte deutsche Strings, Backend-Fehler nur Englisch.

Niedrig: ARIA-Rollen/Labels, Fokus-Outline und Tab-Falle im YAML-Editor, Touch.

## 4. Optimierungspotenzial Code

- `frontend/app.js` mit 10 160 Zeilen; die 500-Zeilen-Regel prüft
  `check_architecture.py` nur für `backend/assistant_tools` und `backend/mcp`.
- `renderDesigner()` baut 12 Panels neu (52 Aufrufer); Undo serialisiert das ganze Projekt.
- Zeilenbasierte YAML-Blockerkennung (zweiter Fehler dieser Art, vgl.
  `test_lvgl_merge.py`).
- Router mit Geschäftslogik in auseinanderlaufenden Kopien (Firmware-Workflow,
  Draft-Merge, Revisionen REST vs. MCP); `AssistantToolService` mit eigenen Stores.
- Wiederholtes Parsen (Merge 5–7×), `list_configs` hasht alle Dateien pro Aufruf.
- Sechs Atomic-Write-Varianten; Audit-SQLite ohne WAL/Retention; stille
  `except Exception`; 422-Handler spiegelt Eingaben.
- Härtung: Größenlimit nur über `Content-Length`, SSRF per DNS-Rebinding, Pflicht-
  Legacy-MCP-Token, gemeinsamer Pre-Auth-Bucket, breite CSP.
- Container: Base-Image `latest`, Python aus Alpine, MCP-Listener unüberwacht.
- Ruff nur `E4/E7/E9/F`; keine gzip-Kompression; `.claude/launch.json` hatte nur das
  statische Frontend.

## 5. Was noch fehlt

- Widgets: `buttonmatrix`, `line`, `canvas`, Touchscreens/Encoder/Keypads, `gradients`;
  viele Stil-Keys nur durchgereicht; Scroll-/Klick-Flags nicht editierbar.
- Trigger/Aktionen: nur on_click/press/release/value; es fehlen u. a. long_press,
  Seiten-Trigger, Seite vor/zurück, Tab/Kachel wählen, Aktivieren/Deaktivieren.
- Viewer: RGB565, Referenzbilder, Tileview-Swipe, Tabbar-Position.
- MCP: 7 von 14 Ressourcen, Completions, Progress/Abbruch, weitere Operationen, OAuth.
- Doku: veraltete Planköpfe, Lizenzangabe im README, Benutzerhandbuch,
  undokumentierte Optionen, alte Screenshots, kein Icon/Logo.
- Tests: E2E fast nur Versionshistorie gegen Mock; keine Merge-Round-Trips über Fixtures.
- CI/Release: kein JS-Lint, kein Audit, kein Dependabot, kein Container-Smoke-Test,
  keine Releases.

## 6. Umsetzung

Reihenfolge nach Gegenprüfung: Phase 0 → A1a → A2 → A4 → A5 → A3 → A7 → A6 → A8–A12 →
A1b → Phase 2. Jeder Schritt mit Regressionstest und eigenem Commit; bestehende
Schwellen werden nicht gesenkt. Neue Frontend-Logik entsteht als eigene Module, nicht in
`app.js`.

### Phase 0 – Arbeitsumgebung
- `.venv` mit Python 3.13 und `constraints.txt` (wie CI), `npm ci`.
- `scripts/dev_server.py`: echtes Backend mit `ESPHOME_ALLOW_DIRECT_ACCESS`/
  `ESPHOME_ALLOW_ANONYMOUS_WRITE`, kurzer Scratch-Pfad (Windows-MAX_PATH), Beispiel-
  konfigurationen aus `tests/data`; Eintrag `esphome-backend-dev` in `.claude/launch.json`.

### Phase 1 – Fehler

- **A1a** – `yaml_patch.top_level_spans(text)`: `yaml.compose` mit `_ImportLoader`;
  Block = Key-Zeile bis zum Ende des Wertes (`last_line`), höchstens bis zum nächsten
  Top-Level-Key; Kommentare dazwischen gehören keinem Block. YAML-Fehler, mehrere
  Dokumente, doppelte Top-Level-Keys, Tags/Aliase/Merge-Keys am Wert → `MergeError`.
  Ersetzungen von unten nach oben. Danach Gesamtprüfung: Ergebnis mit einem
  duplikat-strikten `StrictImportLoader` (neues Add-on-Modul, Merge-Keys ausgenommen,
  Alias-Grenze) laden und jeden Top-Level-Key mit dem Sollwert vergleichen; scheitert
  das, Merge ohne Patcher (Ganzblock) wiederholen, scheitert es erneut → `MergeError`
  (422). Ist ein vorhandener Entwurf selbst kaputt, dient die aktive Datei als Basis
  (Hinweis B). Ganzblock-Ersatz behält CRLF. Kern (`designer_core/`) bleibt unberührt.
- **A1b** – in `lvgl_merge.py` neben `_without_restated_defaults`: gleiche Glyphen-Menge →
  Quellliste behalten; Defaults, die die Quelle ausdrücklich schrieb, wiederherstellen;
  `widgets: []` nur, wenn die Quelle es hatte. Golden-Round-Trip über alle
  `tests/data/*.yaml` (auch CRLF): Ergebnis == Quelle, jede Widget-Definition einmal.
- **A2** – Viewer erzeugt Frame-Bilder einmal und schaltet nur die Sichtbarkeit;
  Negativ-Cache für fehlgeschlagene Asset-URLs neben `fontLoadState` in
  `viewer/assets.js`, auch im Canvas genutzt, nach Upload geleert. Rate-Limit: Schreiben
  verbraucht nur noch das Schreib-Kontingent, Asset-Lesezugriffe bekommen ein eigenes,
  großzügiges Kontingent (keine Ausnahme). Assets: `private, no-cache` + ETag aus
  mtime/Größe, 304 ohne Dateilesen.
- **A3** – `frontend/designer/shortcuts.js` als reine Funktion (Event + Kontext →
  Aktion), Ordner in die Reinheitsprüfung von `check_architecture.py` aufnehmen; nichts
  bei offenem Dialog oder Eingabefokus; Mod = Ctrl oder Cmd; Shift+Mod+Z = Redo;
  Backspace = Löschen; Mod+C/V/A; Mod+S speichert in die App (vorher Feld verlassen,
  damit `change` greift).
- **A4** – `pushUndo()` merkt nur einen ausstehenden Schnappschuss;
  `flushPendingUndo()` (in `markProjectDirty` und vor Undo/Redo) legt ihn nur bei
  tatsächlicher Abweichung ab und leert erst dann Redo. Logik in `project/history.js`.
- **A5** – Autosave speichert Name und Revision; Restore setzt beide inkl.
  `#project-name`; ältere Autosaves ohne Revision und jeder 409 führen in einen Dialog
  „Überschreiben / Als neues Projekt / Verwerfen“ – Überschreiben nutzt die
  `actual_revision` aus dem 409; die alte Fassung bleibt unter „Versionen“.
- **A6** – `_MAX_ESPHOME_EXCLUSIVE = (2026, 11, 0)`, Test anpassen, DOCS.md vereinheitlichen;
  gesperrte Builder-Buttons nennen den echten Grund aus `system.builder.reason`.
- **A7** – Ziele einmal in `viewer_bindings.py`, MCP-Operationen importieren sie;
  `selected_index` bildet Optionstext über die Widget-Optionen auf den Index ab;
  gemeinsame Fixture als Vertragstest.
- **A8** – Vergleich mit normalisierten Zeilenenden.
- **A9** – `GET /api/v1/health` von Loopback an der Ingress-Sperre vorbei (nur dieser Pfad).
- **A10** – `expected_draft_revision` für Entwurf-PUT, Merge und Veröffentlichen
  (REST und MCP); Frontend merkt sich die Entwurfsrevision.
- **A11** – `/assistant/ask`, Import/Probe, Export, Merge, Projekt speichern/laden,
  Veröffentlichen in den Threadpool.
- **A12** – Token als Bytes vergleichen.

### Phase 2 – Bedienung
- Toolbar-Button „Speichern“ (Mod+S) in den App-Speicher; zuletzt geöffnetes Projekt
  beim Start wieder öffnen; klarer Speicherstatus.
- Toasts als eigenes Modul, `popover="manual"` (Top-Layer über Dialogen), Warteschlange,
  Fehler als `role="alert"`.
- Fokusverlust: bei `input` nur Projekt + Canvas aktualisieren, Panels erst bei `change`.
- Gründe sichtbar: Builder-/Rollenhinweise, Onboarding mit kopierbarer User-ID und
  `user_roles`-Snippet, lesbare System-Seite.
- Buttons während Requests sperren; `prompt()` für Stil/Bild durch Dialoge ersetzen;
  Clipboard-Fallback; hart codierte Strings nach `i18n.js`, Backend-Fehlercodes übersetzen.

### Phase 3–5 – Roadmap
- Phase 3: `app.js` zerlegen (Kurzbefehle → Shell/Toasts → Konfigurationen/Jobs →
  Versionen → Bibliotheken → Glow-Line → Eigenschaften → Canvas), Größen-Ratsche in
  `check_architecture.py`, gezieltes Rendern; Backend-Services für Firmware, Draft-Merge,
  Revisionen; gemeinsame Request-Identität; ein Atomic-Write-Helfer; SQLite mit WAL;
  Ruff `ASYNC`/`BLE`/`B`.
- Phase 4: Trigger/Aktionen im Action-Builder, Stilbibliothek, `line`/`buttonmatrix`,
  Viewer-Lücken, MCP nach Bedarf.
- Phase 5: Doku/Screenshots/Icon, E2E für Import→Merge→Veröffentlichen, CI-Lint/Audit/
  Dependabot/Container-Smoke-Test/Releases, Sicherheits-Härtung.

## 7. Verifikation

- Je Schritt: `pytest --cov-fail-under=83`, `node --test tests/frontend/*.test.mjs`,
  `npm run typecheck`, `npm run test:e2e`, Ruff, `tools/check_architecture.py`.
- A1: Golden-Test + im Dev-Server `p4_86_panel.yaml` importieren → Entwurf → „Syntax
  prüfen“ gültig → Diff leer → Veröffentlichen.
- A2: Viewer mit fehlenden `animimg`-Frames offen lassen → keine 429, Speichern klappt.
- A3–A5: Unit-Tests + im Browser (Mod+Shift+Z, Ctrl+Z im Feld, Autosave → Speichern).
- A6: Versionsmatrix-Test; kein Live-Test gegen den Device Builder (Entscheidung) –
  Restrisiko: eine Protokolländerung ab 2026.9 fiele erst im Jobpanel auf.
