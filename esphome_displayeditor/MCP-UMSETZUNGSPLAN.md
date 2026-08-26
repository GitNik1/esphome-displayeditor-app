# Umsetzungsplan: vollständige MCP-Unterstützung

## Aktueller Stand (21.08.2026, App-Version 0.278.0)

### Bereits umgesetzt: Preview-2-Grundlage und sichere M6-Lesepfade

- `mcp_mode: disabled|lan`, standardmäßig `disabled`
- separater, standardmäßig nicht veröffentlichter Port `8100/tcp`
- Streamable HTTP auf `/mcp` mit MCP SDK `2.0.0`
- Handshake-Tests für `2025-11-25` und `2026-07-28`
- Bearer-Token (mindestens 32 Zeichen), Host-/Origin-Allowlist,
  DNS-Rebinding-Schutz, 1-MiB-Requestlimit, 512-KiB-Antwortlimit und
  Request-Rate-Limit
- im Standardmodus ausschließlich lesende Tools: Serverinfo, Katalog, Projektliste,
  Projektansicht und Projektvalidierung
- Resources für Serverinfo, Binding-Katalog, Projektliste und dynamische
  Projektzusammenfassung
- gemeinsame transportneutrale `AssistantToolService`-Fassade
- getrenntes `mcp_access: read_only|project_write`, wobei Schreiben zusätzlich
  ein schreibbares App-`access_level` voraussetzt
- typisierte Operationen `add_widget`, `update_widget` und `place_widget` für
  Root, Seiten, Layer, Messagebox-Buttons und verschachtelte Widgets
- strenge absolute, Alignment-, Flex- und Grid-Platzierung einschließlich
  Bounds-, Hierarchie-, Stub-, ID- und Zyklusprüfung
- persistente 15-Minuten-Change-Sets mit Vorschau, Ownership, exakter
  Basisrevision, idempotentem Apply und 24 Stunden Apply-ID-Aufbewahrung
- atomische, prozessübergreifend gesperrte Projektwrites und Audit für
  Vorschlag, Apply, Konflikt und Fehler
- typisierte Projekt-Binding-Operationen mit Prüfung gegen alle vorhandenen
  Entity-/Widget-Fähigkeiten; Custom-YAML bleibt schreibgeschützt
- getrennte Viewer-Binding-Change-Sets mit Projekt- und Sidecar-Revision,
  Registry-, Widgetziel- und Sidecar-Limitprüfung
- paginierte kompatible Projekt-/Viewer-Binding-Ziele, abgeleitet aus den
  vorhandenen Richtungs-, Datentyp- und Capability-Regeln
- signierte, abfrage- und revisionsgebundene Cursor für Projekt-,
  Konfigurations- und Binding-Ziel-Listen
- lesender, eingegrenzter Konfigurationszugriff sowie YAML→Projekt-Import als
  Project-Create-Change-Set mit Quellrevision und atomarem Namenskonflikt
- revisionsgebundener YAML-Export und read-only Merge-Vorschau mit
  65.536-Zeichen-Segmenten und Erhalt unbekannter Konfigurationsinhalte
- YAML-Merge als geprüftes Configuration-Draft-Change-Set mit exakter
  Projekt-, Active- und optionaler Draft-Revision, 32-KiB-Diffvorschau,
  prozessübergreifenden Locks und idempotentem Apply
- zugriffsabhängige Prompts für Analyse, YAML-Review, Import, Layout und
  Bindings sowie kontextgebundene Completions mit höchstens 50 Werten
- revisionsgebundene, paginierte `structured_layout_v1`-Vorschau je Surface
  sowie schlüsselreferenzfreie Lesesicht auf registrierte Geräte
- aufgelöste Vorschau-Boxen mit gemeinsamen Python-/JavaScript-Paritätsfixtures
  für absolute/äußere Ausrichtung, Grid, Flex, Verschachtelung, Seiten und Layer
- requestlokale Identitäten und serverseitige Scopeprüfung für Tools/Resources;
  bis zu 100 separat benannte, gehashte, ablaufende und sofort widerrufbare
  Client-Tokens mit einmaliger Secret-Ausgabe und Audit über Admin-API und die
  administratorgeschützte Systemseite
- kopierbarer Claude-Code-Befehl und umgebungsvariablenbasierte `.mcp.json`
  sowie ein tokenfreier, auf Loopback/2 Sekunden/4 KiB begrenzter Listenertest
- dependency-freie stdio→Streamable-HTTP-Bridge mit Sitzungs-, Versions-,
  JSON-/SSE- und Größenlimit-Tests sowie ein reproduzierbares, offiziell
  validiertes MCPB-v0.4-Paket für Claude Desktop (Nachfolger von DXT)
- freie YAML-Uploads über `display_project_import_yaml_propose` (inline
  YAML-Text statt gespeicherter Konfiguration, revisionsfreier Change-Set-Pfad
  da der Inhalt bereits vollständig im Change-Set liegt) sowie
  `display_configuration_apply` zum Veröffentlichen eines bereits geprüften
  Entwurfs als aktive Konfiguration, gebunden an den eigenen Scope
  `configuration:publish`, getrennt von `configuration:draft`/`project:write`
- Live-Buildwerkzeuge `display_configuration_validate`, `display_build` und
  `display_install`, nur registriert bei `access_level: write_with_builder`.
  Der MCP-Listener-Prozess führt dafür eine eigene, unabhängig probende
  `BuilderManager`-Instanz gegen denselben `builder_url`, da die Instanz der
  Hauptanwendung an deren eigenen asyncio-Event-Loop gebunden ist (getrennte
  Prozesse, siehe run.sh). Validierungsnachweise laufen weiterhin über den
  gemeinsamen, SQLite-basierten `WorkflowStore`. `display_install` erfordert
  immer ein explizites `confirmed: true` und erlaubt ausschließlich
  `port: "OTA"`; die drei Tools nutzen eigene Scopes
  (`configuration:validate`, `firmware:compile`, `firmware:install`),
  getrennt von `project:write`/`configuration:publish`
- MCP-Apps-Erweiterung (`io.modelcontextprotocol/ui`) für die Preview-View:
  `display_preview` ist über das offizielle SDK-`Apps`-Extension zusätzlich an
  eine gebündelte, sandboxed `ui://display-editor/preview`-Ressource
  gebunden. Unterstützende Hosts erhalten dieselbe Toolantwort plus eine
  clientseitig gerenderte Canvas-Ansicht (absolut positionierte Boxen aus den
  bereits vorhandenen `resolved`-Werten der Preview-Projektion); Clients ohne
  MCP-Apps-Unterstützung sehen exakt dieselbe strukturierte Antwort wie zuvor.
  Das Bundle implementiert das postMessage-Wire-Protokoll direkt (kein
  externes JS-Paket, keine externen Origins, keine `csp`-Domains gewährt,
  unter dem 512-KiB-Bundle-Limit) und kann ausschließlich bereits
  registrierte Servertools aufrufen.
- MCP-Apps-Erweiterung für die Change-Set-Review-View: alle sechs
  Change-Set-erzeugenden Tools (`display_project_propose`,
  `display_project_import_propose`, `display_project_import_yaml_propose`,
  `display_configuration_draft_propose`, `display_binding_propose`,
  `display_viewer_binding_propose`) sind zusätzlich an eine zweite gebündelte
  Ressource `ui://display-editor/changeset-review` gebunden, nur registriert
  bei `mcp_access: project_write`. Die View rendert `preview` generisch nach
  Form (Widget-/Issue-Zähler und hinzugefügte/entfernte IDs für Projekt- und
  Binding-Vorschläge, Unified Diff für Konfigurations-Entwurf-Merges,
  getrennte Tabellen für Projekt- und Viewer-Bindings) und bietet einen
  Apply-Button, der `display_changeset_apply` über dieselbe MCP-App-Bridge
  aufruft wie jeder andere Tool-Aufruf — dieselbe Scope-, Revisions- und
  Idempotenzprüfung, keine neue Berechtigung, nur ein visueller
  Bestätigungsschritt vor einer bereits autorisierten Aktion. Ein
  „Dismiss"-Button blendet die Ansicht nur lokal aus; es gibt keinen
  separaten Discard-Tool-Aufruf, ein nicht angewendetes Change-Set läuft
  weiterhin über seine TTL ab.
- unbedingter `secrets.yaml`/`secrets.yml`-Schutz für die gesamte
  Assistant-Tools-/MCP-Schicht (`assistant_tools/secrets_guard.py`),
  unabhängig von der abschaltbaren `protect_sensitive_paths`-Einstellung, die
  nur den REST-/Browser-Pfad regelt. Greift an jedem Einstiegspunkt, der eine
  Konfiguration per Name entgegennimmt: Lesen, YAML-Export/Merge-Vorschau,
  Konfigurations-Entwurfs-Vorschlag und -Apply, YAML-Import und
  Firmware-Validieren/-Kompilieren/-Installieren.
- internes KI-Hilfe-Panel (Backend, `POST /api/v1/assistant/ask`), Rolle
  `administrator`, eigener Opt-in (`assistant_mode`/`assistant_api_key`,
  getrennt von `mcp_mode`) plus zusätzlich `mcp_access: project_write` für
  Vorschläge — dieselbe "KI darf schreiben"-Schranke wie für externe
  MCP-Clients, bewusst ein gemeinsames Gate für jeden KI-Schreibpfad. Nutzt
  `AssistantToolService` direkt (kein MCP-Transport, keine MCP-Tokens/Scopes)
  für identische semantische Operationen zu externem MCP. Sicherheitsmodell:
  ein fester, kleiner Tool-Katalog (Projekt lesen/validieren,
  Binding-Targets, Widget-Katalog, zwei Propose-Tools, optional eine
  gebundene Konfiguration lesen — kein Apply/Build/Install/YAML-Import/
  Export), server-seitig hart an das eine Projekt/die eine Konfiguration der
  Anfrage gebunden (kein `project_name`-Parameter im Modell-Tool-Schema,
  keine Möglichkeit zur Umlenkung), kein Auto-Apply (nur Vorschlag, Anwenden
  bleibt explizite Nutzeraktion außerhalb der Schleife), begrenzte
  Tool-Aufruf-Runden und Zeitbudget pro Anfrage, eigenes Stunden-Rate-Limit,
  kein serverseitig persistierter Gesprächsverlauf, `secrets.yaml` über
  denselben unbedingten Guard gesperrt. Anthropic-Anbindung ohne SDK-
  Abhängigkeit (reines `http.client`, gleiches Prinzip wie die MCP-Apps-
  Bridge). Frontend-Panel unter System (`assistant-card`, sichtbar nur bei
  Capability `assistant.ask`) folgt demselben Muster wie die MCP-Token-
  Verwaltung: reiner Controller (`controllers/assistant-controller.js`) plus
  DOM-Bindung in `app.js`. Bindet sich beim Wechsel auf den System-Tab an das
  aktuell im Designer geladene Projekt (`state.projectName`); ohne
  geladenes Projekt bleibt der Frage-Button deaktiviert. Vorschläge werden
  als Karten mit Zusammenfassung (hinzugefügt/entfernt/Hinweise) gerendert,
  „Übernehmen" ruft `POST /api/v1/assistant/changesets/{id}/apply` separat
  auf — nie automatisch. End-to-end gegen die echte Anthropic-API verifiziert
  (ungültiger Test-Key ergab die reale Anthropic-Fehlermeldung „API key is
  invalid.", sauber im UI dargestellt, Audit-Eintrag korrekt geschrieben).

Noch nicht umgesetzt ist der OAuth-Remote-Modus (M7-Rest). Für M3 fehlen
noch weiterführende Placement-Operationen wie Verteilen oder
Ressourcenänderungen; M5 benötigt später noch Client-Bestätigungsflüsse.

Dieser Plan beschreibt einen client-neutralen MCP-Server für den ESPHome
Display Editor. Er soll dieselben geprüften Designer-, Binding-, YAML-,
Konfigurations-, Geräte- und Build-Services verwenden wie die bestehende
FastAPI-Anwendung. MCP wird dabei nur die standardisierte Werkzeug- und
Kontextschicht; ein Sprachmodell ist nicht Bestandteil des MCP-Servers.

Als Protokollbasis gilt MCP `2026-07-28`. Die offizielle Python-SDK-v2-Linie
unterstützt diese Revision und kann weiterhin ältere Clients mit
`2025-11-25` bedienen. Beide Protokollpfade müssen in den Abnahmetests bleiben.

Wichtige Ergebnisse der Vorprüfung:

- Die App ist als modularer Monolith aufgebaut. Neue MCP-Adapter dürfen die
  vorhandenen Services verwenden, aber keine Designerlogik duplizieren.
- Die Webanwendung läuft weiterhin ausschließlich über Home-Assistant-Ingress.
  Der optionale MCP-LAN-Modus nutzt einen getrennten Port, der standardmäßig
  nicht veröffentlicht wird.
  Ein Claude-Remote-Connector kann diesen privaten Endpunkt nicht direkt
  erreichen, da dessen Verbindungen aus der Anthropic-Cloud kommen.
- Das Projektmodell unterstützt 24 Widgettypen. 20 davon besitzen bereits
  typisierte Geräte-Binding-Fähigkeiten; 15 ESPHome-Entity-Domänen werden
  erkannt.
- Es gibt zwei unterschiedliche Binding-Arten, die MCP niemals vermischen
  darf:
  - exportierbare Projekt-Bindings in `project.bindings`
  - ausschließlich für die Laufzeitvorschau bestimmte Viewer-Sidecars
- Die Platzierungslogik kennt absolute Positionierung, Alignment,
  `align_to`, Flex, Grid, Seiten, Layer, Messageboxen und verschachtelte
  Widgets. Flex-/Grid-Positionen werden vom Layout des Elternobjekts bestimmt.
- Koordinaten und Widgetgrößen sind im vorhandenen Backend noch nicht
  ausreichend typ- oder bereichsgeprüft. Für MCP ist daher eine strengere
  semantische Mutationsschicht erforderlich.

## 1. Ziel und Definition von „vollständig“

Die MCP-Unterstützung ist vollständig, wenn ein kompatibler Client:

1. Projekte, Widget-Schemas, Seiten, Layer, Messageboxen, Bindings,
   Konfigurationen, Geräteinformationen und Buildzustände sicher lesen kann,
2. Widgets semantisch anlegen, ändern, verschieben, ausrichten,
   verschachteln und in Flex-/Grid-Layouts platzieren kann,
3. Projekt- und Viewer-Bindings typgerecht vorschlagen und validieren kann,
4. jede dauerhafte Änderung zuerst als prüfbares Change-Set erhält,
5. ein Change-Set nur mit passender Basis-Revision übernehmen kann,
6. YAML importieren, validieren und exportieren kann, ohne unbekannte Inhalte
   stillschweigend zu verlieren,
7. entsprechend der vorhandenen Rolle Entwürfe speichern, veröffentlichen,
   kompilieren oder installieren kann,
8. über Streamable HTTP und über einen lokalen stdio-Adapter verwendbar ist,
9. mit Claude Code, Claude Desktop, Claude-Remote-Connectors und generischen
   MCP-Clients innerhalb deren jeweiliger Funktionsgrenzen funktioniert,
10. alle Aktionen nach Identität, Scope, Projekt und Revision auditiert.

„Vollständig“ bedeutet nicht, jede optionale oder veraltete MCP-Funktion zu
implementieren. Nicht neu verwendet werden die in MCP `2026-07-28`
abgekündigten Funktionen Roots, Sampling, Logging und Legacy HTTP+SSE. Für
ältere Clients werden nur die vom offiziellen SDK bereitgestellten
Kompatibilitätspfade betrieben.

## 2. Protokoll- und Clientkompatibilität

### 2.1 MCP-Kern

Der Server bietet:

- JSON-RPC 2.0 über Streamable HTTP
- zustandslose Requests gemäß `2026-07-28`
- `server/discover` und deterministisch sortierte, cachebare Kataloge
- Kompatibilitäts-Handshake für `2025-11-25`
- Tools mit vollständigem JSON Schema 2020-12 für Ein- und Ausgaben
- `structuredContent` plus kurze Textzusammenfassung
- Resources und Resource Templates mit stabilen benutzerdefinierten URIs
- Prompts für wiederkehrende Display-Editor-Abläufe
- Completions für Projektnamen, Widget-IDs, Entity-IDs und Binding-Ziele
- Cursor-Paginierung mit opaken, signierten Cursors
- Fortschritt und Abbruch für normale Requests
- Multi-Round-Trip Requests für Bestätigungen, wenn der Client sie anbietet
- die offizielle Tasks-Erweiterung nur für Clients, die sie aushandeln
- die offizielle MCP-Apps-Erweiterung für visuelle Vorschau und Freigabe

Die Implementierung verwendet `mcp>=2,<3` und pinnt die konkret getestete
Version im Dependency-Lock. Selbst geschriebene JSON-RPC- oder
Transportimplementierungen sind nicht vorgesehen.

### 2.2 Claude-Matrix

| Client | Verbindung | Nutzbarer Umfang | Einschränkung |
|---|---|---|---|
| Claude Code im LAN | Streamable HTTP | Tools, Resources, Prompts, dynamische Kataloge | benötigt URL und Token |
| Claude Code lokal | stdio-Bridge | voller Serverumfang über die Bridge | Bridge muss separat installiert werden |
| Claude Desktop lokal | MCPB/stdio-Bridge | Tools, Resources und Prompts | lokales MCPB erforderlich; MCP Apps folgen separat |
| Claude/Claude Desktop Remote-Connector | öffentliches HTTPS + OAuth | Tools und bei Host-Unterstützung MCP Apps | Verbindung kommt aus der Anthropic-Cloud |
| Claude Messages API MCP Connector | öffentliches Streamable HTTP | derzeit nur Tools | Resources und Prompts sind dort nicht direkt nutzbar |
| generischer MCP-Client | HTTP oder stdio | ausgehandelte Standardfähigkeiten | abhängig von der Clientimplementierung |

Weil der Claude-API-Connector derzeit nur Tool-Aufrufe unterstützt, müssen
alle für einen vollständigen Workflow erforderlichen Leseoperationen auch als
kompakte Read-only-Tools existieren. Resources bleiben die effizientere
Alternative für Clients, die sie unterstützen.

### 2.3 Home-Assistant-Betriebsarten

Es werden drei explizite Modi vorgesehen:

1. `disabled` – Standard für bestehende Installationen; kein MCP-Netzport.
2. `lan` – separater Container-Port, standardmäßig `8100/tcp`, optional vom
   Benutzer auf das lokale Netz gemappt; Bearer-Token oder lokales OAuth,
   niemals anonym.
3. `remote` – öffentliches HTTPS ausschließlich hinter einem dokumentierten
   Reverse Proxy oder Tunnel mit OAuth 2.1. Der rohe Add-on-Port darf nicht
   direkt ins Internet weitergeleitet werden.

Der Ingress-Endpunkt `/api/v1/` bleibt unverändert. MCP erhält eine getrennte
ASGI-Komposition und einen eigenen Sicherheitsrand. Dadurch kann die
bestehende Ingress-Middleware nicht versehentlich für externe MCP-Clients
geöffnet werden.

## 3. Zielarchitektur

```text
Claude / Codex / anderer MCP-Host
              │
       Streamable HTTP
       oder stdio-Bridge
              │
              ▼
        MCP-Transportadapter
   ├── Versionsaushandlung
   ├── Authentifizierung/Scopes
   ├── Limits/Paginierung
   └── Tools/Resources/Prompts
              │
              ▼
      AssistantToolService
   ├── Katalog- und Leseabfragen
   ├── semantische Projektoperationen
   ├── PlacementService
   ├── BindingService
   ├── ChangeSetStore
   └── Vorschau-/Diff-Projektion
              │
              ▼
       vorhandene App-Services
   ├── DesignerService / ProjectStore
   ├── ViewerBindingStore
   ├── FilesystemBackend
   ├── DeviceManager
   ├── BuilderManager
   ├── WorkflowStore
   └── AuditStore
```

Neue Protokolltypen dürfen nicht in die vorhandenen Domainmodelle einsickern.
MCP-Handler übersetzen MCP-Eingaben in semantische Operationen; die
vorhandenen Services bleiben die einzige Instanz für Validierung, Speichern,
Revisionen und Audit.

Geplante Module:

```text
backend/assistant_tools/
├── service.py             # Anwendungsfassade
├── operations.py          # semantische, versionierte Operationen
├── placement.py           # Placement und Hierarchie
├── binding_operations.py  # Projekt- und Viewer-Bindings
├── changesets.py          # TTL, Revision, Diff und Apply
├── query.py               # kompakte, paginierte Leseprojektionen
└── limits.py              # zentrale, veröffentlichte Grenzen

backend/mcp/
├── app.py                 # getrennte ASGI-Komposition
├── server.py              # SDK-Registrierung
├── auth.py                # OAuth/PAT, Scopes, Identity
├── tools/                 # dünne Tooladapter
├── resources.py
├── prompts.py
├── completions.py
└── errors.py

frontend/mcp-app/
├── changeset-review.js
├── preview.js
└── styles.css

clients/claude-desktop/
└── ...                    # lokaler Proxy und MCPB-Paketquelle
```

Die Architekturgrenzen bleiben verbindlich: Produktionsmodule unter 500
Zeilen, Controller/Adapter unter 300 Zeilen, keine Netzwerkzugriffe aus
Domainmodulen und mindestens 83 Prozent Backend-Coverage.

## 4. MCP-Oberfläche

### 4.1 Tools

Die Oberfläche bleibt bewusst klein und semantisch. Einzelne Properties
werden nicht als jeweils eigenes Tool veröffentlicht.

| Tool | Zweck | Dauerhafte Änderung | MCP-Hinweise |
|---|---|---:|---|
| `display_catalog` | Schemas, Fähigkeiten, Limits und kompatible Ziele abfragen | nein | read-only, closed world |
| `display_project_read` | Projektzusammenfassung, Baum, Widget oder Ausschnitt lesen | nein | read-only, closed world |
| `display_project_validate` | Projekt, Layout und Bindings validieren | nein | read-only, idempotent |
| `display_preview` | Viewer-Projektion oder Vorschaubild erzeugen | nein | read-only; MCP-App-fähig |
| `display_project_propose` | Widget-, Style-, Placement-, Seiten- und Hierarchieoperationen vorschlagen | nur temporäres Change-Set | additive/non-destructive |
| `display_binding_propose` | Projekt- oder Viewer-Bindings vorschlagen/ändern | nur temporäres Change-Set | additive/non-destructive |
| `display_changeset_apply` | geprüftes Change-Set revisionsgeschützt speichern | ja | destructive, idempotent per Change-Set-ID |
| `display_yaml_transform` | Import, Export, Normalisierung oder Merge-Vorschau | nein | read-only |
| `display_configuration_apply` | Entwurf speichern oder publizieren | ja | destructive |
| `display_device_read` | freigegebene Geräte, Entities, Zustände und Logs lesen | nein | read-only, closed world |
| `display_build` | Kompilierung starten/status/canceln | Buildartefakte | nicht read-only; asynchron |
| `display_install` | bestätigtes Artefakt auf das bekannte Ziel installieren | ja, extern | destructive, open world |

Das Löschen von Projekten, Konfigurationen oder Assets wird im ersten
vollständigen Release absichtlich nicht als MCP-Tool angeboten. Das ist eine
Sicherheitsgrenze, keine technische Lücke. Die reguläre App-Oberfläche bleibt
dafür zuständig.

Jedes Tool erhält:

- eine Beschreibung unter 2 KiB, damit Claude Code sie nicht abschneidet,
- ein enges Input- und Output-Schema,
- korrekte `readOnlyHint`, `destructiveHint`, `idempotentHint` und
  `openWorldHint`,
- eine Zuordnung zu App-Capability und OAuth-Scope,
- stabile Fehlercodes und eine kurze, handlungsorientierte Fehlermeldung,
- eine serverseitige Validierung unabhängig davon, ob der Client das Schema
  bereits geprüft hat.

### 4.2 Resources

Vorgesehene URI-Struktur:

```text
esphome-display://server/info
esphome-display://catalog/widgets
esphome-display://catalog/bindings
esphome-display://projects
esphome-display://projects/{name}/summary
esphome-display://projects/{name}/tree
esphome-display://projects/{name}/widgets/{widget_id}
esphome-display://projects/{name}/bindings
esphome-display://projects/{name}/viewer-bindings
esphome-display://configurations/{name}/summary
esphome-display://devices/{device_id}/entities
esphome-display://changesets/{change_set_id}
ui://display-editor/preview
ui://display-editor/changeset-review
```

Große Projekte werden nicht als ein einziger unbeschränkter Resource-Text
zurückgegeben. Baum, Widgets und Collections sind separat adressierbar. Ein
Tool kann zusätzlich mit Cursor, Feldauswahl und Tiefenlimit lesen.

### 4.3 Prompts und Completions

Prompts:

- `display_analyze_project` – Projekt strukturiert lesen und validieren
- `display_review_yaml` – Export oder Merge-Vorschau revisionsgebunden prüfen
- `display_create_project_from_yaml` – YAML-Import als Change-Set begleiten
- `display_edit_layout` – semantische Platzierungsänderungen begleiten
- `display_bind_entities` – kompatible Projekt- oder Viewer-Bindings begleiten

Completions liefern höchstens 50 Werte und unterstützen derzeit:

- Projekt- und Konfigurationsnamen
- Widget- und Elterncontainer-IDs im ausgewählten Projekt
- Entity-Domänen und Entity-IDs im ausgewählten Projekt
- Fokus, Binding-Art, Binding-Richtung und Konfigurationsquelle

Weitere Completions für Seiten-, Style-, Font-, Image- und Color-IDs sowie
Events, Commands und Binding-Properties bleiben geplant.

## 5. Semantische Projektoperationen

### 5.1 Change-Set statt freiem JSON-Patch

Modelle dürfen keine beliebigen JSON-Pointer verändern. Stattdessen erhält
`display_project_propose` eine Liste versionierter Operationen, beispielsweise:

- `widget.add`
- `widget.update_properties`
- `widget.update_style`
- `widget.move`
- `widget.resize`
- `widget.reparent`
- `widget.align`
- `widget.distribute`
- `widget.remove`
- `surface.add_page`
- `surface.update`
- `resource.add_or_update`
- `binding.add_or_update`
- `binding.remove`

Das Ergebnis enthält:

- `change_set_id`
- `base_revision`
- normalisierte Operationen
- Validierungsprobleme und Warnungen
- eine kompakte Vorher-/Nachher-Zusammenfassung
- betroffene Widget- und Binding-IDs
- optional eine Viewer-Projektion und MCP-App-URI
- `expires_at`

`display_changeset_apply` akzeptiert ausschließlich eine unverbrauchte
Change-Set-ID und dieselbe Basis-Revision. Bei Abweichung folgt ein
Revision-Conflict; der Server führt niemals automatisch einen Rebase aus.

### 5.2 Platzierung

Jede Placement-Operation benennt zuerst die Zieloberfläche:

- Root-Widgets
- Seite per Seiten-ID
- Top- oder Bottom-Layer
- Messagebox-Bereich
- Elternwidget per Widget-ID

Danach wird genau ein Placement-Modus verwendet:

#### Absolut

- `x` und `y` beziehen sich auf den Content-Ursprung des Elternwidgets nach
  dessen Padding.
- Breite/Höhe sind Pixel, Prozent oder `SIZE_CONTENT`.
- `overflow_policy` ist `reject`, `clamp` oder explizit `allow`; Standard ist
  `reject`.
- Optional sucht `find_free` deterministisch auf einem 8-Pixel-Raster nach
  einer kollisionsfreien Position.

#### Alignment

- Unterstützt die vorhandenen inneren und `OUT_*`-Alignments.
- `align_to` darf nur auf ein existierendes kompatibles Geschwister zeigen.
- Selbstbezüge, Kettenzyklen und Ziele im eigenen Unterbaum werden abgelehnt.

#### Grid

- Das Elternobjekt muss `layout.type = GRID` besitzen.
- Zeile, Spalte und Spans müssen in die vorhandenen Tracks passen.
- Position und Größe kommen aus der Grid-Zelle; `x`/`y` sind nur explizite
  Offsets.
- `x_align`/`y_align` erlauben `START`, `CENTER`, `END` und `STRETCH`.

#### Flex

- Das Elternobjekt muss `layout.type = FLEX` besitzen.
- Die Reihenfolge entsteht durch den Index im Children-Array.
- Direkte Pixelpositionen werden nicht als vermeintliche absolute Position
  gespeichert; nur dokumentierte Offsets und `flex_grow` sind erlaubt.

#### Reparent, Align und Distribute

- Beim Verschieben in einen anderen absoluten Container werden Koordinaten
  relativ zum neuen Content-Ursprung umgerechnet.
- Bei Flex/Grid wird stattdessen der Einfügeindex beziehungsweise die
  Grid-Zelle gesetzt.
- Gesperrte Widgets werden standardmäßig nicht verändert; ein explizites
  `include_locked=true` erfordert einen höheren Scope.
- Der Backend-Layoutprojektor erhält gemeinsame JSON-Fixtures mit
  `frontend/layout.js`. Abweichungen werden als Vorschauwarnung angezeigt,
  nicht als scheinbare Pixelgenauigkeit verschwiegen.

## 6. Binding-Unterstützung

### 6.1 Projekt-Bindings

Projekt-Bindings werden mit dem Projekt exportiert und können ESPHome-
Automationen erzeugen. MCP verwendet die vorhandenen Capability-Matrizen:

- 15 Entity-Domänen
- 20 bindbare Widgettypen
- Richtungen `entity_to_widget`, `widget_to_entity`, `bidirectional`
- typisierte Inputs/Outputs, Entity-Commands und Widget-Events
- numerische Transformationen, Clamp, Mapping, Bedingungen und Fallback
- Meter-Indikator-IDs und Flow-Richtungs-Sonderfälle

Vor dem Vorschlag muss `display_catalog` die kompatiblen Ziele liefern. Der
Server prüft anschließend unabhängig davon:

- eindeutige gültige Binding-ID
- Existenz von Entity und Widget
- lesbare/schreibbare Richtung
- Datentyp-Kompatibilität
- zulässiges Command/Event/Property
- gültigen Meter-Indikator oder Reverse-Animimg-Verweis
- Gesamtlimit von 512 Projekt-Bindings

Importiertes `custom_yaml` wird verlustfrei angezeigt und validiert. Neue
beliebige Lambdas oder Custom-YAML-Aktionen werden im normalen MCP-Write-Scope
nicht erzeugt. Ein späterer Expert-Scope darf nur eine separate, deutlich
markierte Vorschau liefern; er darf niemals Gerätebefehle direkt ausführen.

### 6.2 Viewer-Bindings

Viewer-Bindings bleiben Sidecars und werden niemals in exportiertes YAML
verschoben. Bestehende Regeln bleiben erhalten:

- höchstens 256 Bindings
- Ziele `text`, `value`, `state_checked`
- genau ein Binding pro `(widget_id, target)`
- typgerechte Zielwidgets
- nur registrierte Geräte und syntaktisch gültige Entity-IDs; MCP prüft die
  Runtime-Entity zusätzlich, wenn das Gerät online ist, und liefert andernfalls
  eine Offline-Warnung statt eine nicht belegbare Typgarantie
- Format und Fallback jeweils höchstens 128 Zeichen
- `stale_after` zwischen 0 und 86.400 Sekunden
- Sidecar-Datei höchstens 256 KiB
- revisionsgeschütztes Speichern

Die MCP-App für Change-Sets zeigt Projekt- und Viewer-Bindings in getrennten,
klar beschrifteten Tabellen.

## 7. Berechtigungen, Bestätigung und Audit

### 7.1 Scopes

Vorgesehene OAuth-/Token-Scopes:

```text
mcp:connect
designer:read
designer:propose
designer:write
configuration:read
configuration:draft
configuration:publish
device:read
firmware:compile
firmware:install
```

Die Scopes ersetzen keine App-Rollen. Effektive Berechtigung ist immer die
Schnittmenge aus Token-Scope, vorhandener Capability, Access-Level und Rolle:

| App-Rolle | MCP-Höchstberechtigung |
|---|---|
| Viewer | lesen, validieren, exportieren, Vorschau |
| Editor | zusätzlich Change-Sets anwenden und Entwürfe schreiben |
| Publisher | zusätzlich Konfiguration publizieren |
| Installer | zusätzlich kompilieren und installieren |
| Administrator | Token/Clients verwalten; keine automatische Gerätesteuerung |

`device.control` ist in der App aktuell grundsätzlich deaktiviert. MCP darf
diese Grenze weder durch ein generisches Tool noch durch Custom YAML umgehen.

### 7.2 Authentifizierung

- Remote HTTP folgt der MCP-Autorisierung für `2026-07-28`, OAuth 2.1,
  Protected Resource Metadata, Resource Indicators und Client Metadata.
- Access Tokens werden auf Audience, Issuer, Ablauf, Scope und Subject
  geprüft; Token-Passthrough an nachgelagerte Dienste ist verboten.
- LAN-Tokens sind zufällig, gehasht gespeichert, an Scopes/Rolle gebunden,
  widerrufbar und standardmäßig zeitlich begrenzt.
- stdio erhält nur ein enges Bridge-Token; der Child-Prozess erbt keine
  unnötigen Umgebungsvariablen oder Secrets.
- HTTP prüft `Origin`, `Host`, Content-Type und Protokollversion. TLS ist im
  Remote-Modus Pflicht.

### 7.3 Bestätigung

Tool-Hinweise allein sind keine Sicherheitsgrenze. Dauerhafte Änderungen
verwenden deshalb immer:

1. Vorschlag/Change-Set,
2. sichtbare Diff- oder MCP-App-Ansicht,
3. getrennten Apply-Aufruf,
4. serverseitige Rollen- und Revisionsprüfung.

Unterstützt ein Client MCP Multi-Round-Trip Requests, kann der Apply-Aufruf
zusätzlich `input_required` mit einer Zusammenfassung anfordern. Ältere
Clients bleiben über den zweistufigen Ablauf sicher nutzbar.

Jeder Tool-Aufruf protokolliert Identität, Client-ID, Tool, Ziel, Scope,
Basis- und Ergebnisrevision, Change-Set-ID, Dauer, Resultat und Fehlercode.
Toolargumente mit Projekttexten oder Secrets werden nicht vollständig geloggt.

## 8. Verifizierte bestehende und geplante Limits

### 8.1 Bereits im Code erzwungene Grenzen

| Bereich | Ist-Grenze |
|---|---:|
| Canvas | 1–4096 Pixel je Achse |
| Widgets insgesamt, inklusive Seiten/Layer/Messageboxen | 1000 |
| Widget-Verschachtelung | 32 Ebenen |
| Projektdatei | Standard 1 MiB, konfigurierbar 64 KiB–4 MiB |
| API-Request | Standard 12 MiB, konfigurierbar 256 KiB–16 MiB |
| YAML-Entwurf oder Import-Text | 4 MiB |
| Custom-Binding-YAML | 128 KiB |
| Projekt-Bindings | 512 |
| Viewer-Bindings | 256 |
| Viewer-Binding-Sidecar | 256 KiB |
| API-Rate | Standard 240 Requests/Minute |
| Schreib-Rate | zusätzlich Standard 60 Requests/Minute |
| API-Timeout | Standard 300 s, konfigurierbar 10–900 s |
| Projektname | eingeschränkter Stamm bis 128 Zeichen plus `.lvgldesign` |

Schreibrequests zählen sowohl gegen das allgemeine als auch gegen das
Schreiblimit.

### 8.2 Festgestellte Lücken

- `WidgetNode.x`, `y`, `width` und `height` akzeptieren im allgemeinen
  Backendmodell weiterhin weitgehend beliebige Werte. Die MCP-Mutationsschicht
  normalisiert und begrenzt sie bereits; eine Vereinheitlichung des
  Domainmodells bleibt offen.
- ESPHome-IDs werden syntaktisch geprüft, besitzen im Projektvalidator aber
  noch kein eigenes Längenlimit.
- Für Anzahl von Styles, Fonts, Images, Colors, Seiten, Grid-Tracks und
  Punkten einer GlowLine gibt es außer der Gesamtdateigröße keine expliziten
  Einzelgrenzen.
- Der MCP-Endpunkt besitzt bereits einen tatsächlichen 1-MiB-ASGI-Body-Zähler
  auch bei fehlendem oder falschem `Content-Length`; andere Transporte müssen
  ihre äquivalente Grenze später separat nachweisen.
- Das Frontend-Layout ist eine dokumentierte LVGL-Näherung. Ein MCP-Ergebnis
  darf deshalb keine Pixelgenauigkeit garantieren.
- Der in-memory Rate-Limiter gilt nur pro Prozess. Ein später horizontal
  skalierter Remote-Server benötigt einen gemeinsamen Limiter.

Diese Lücken werden nicht durch höhere MCP-Limits kaschiert, sondern mit
Tests und zentralen Konstanten geschlossen.

### 8.3 Neue MCP-Grenzen

MCP selbst definiert kein universelles Maximum für Toolanzahl,
JSON-RPC-Nachrichtengröße oder Toolresultate. Deshalb gelten serverseitig:

| Bereich | Grenze / Status |
|---|---:|
| JSON-RPC-HTTP-Body | 1 MiB, umgesetzt |
| serialisierte Tool-/Resource-Ausgabe | 512 KiB, umgesetzt |
| YAML-Lesesegment | 65.536 Zeichen, umgesetzt |
| serialisierte Toolargumente | 256 KiB |
| Operationen pro Change-Set | 50, umgesetzt |
| offene Change-Sets pro Identität | 100, umgesetzt |
| Change-Set-TTL | 15 Minuten, umgesetzt |
| Aufbewahrung angewandter Change-Sets | 24 Stunden, umgesetzt |
| Standard-/Maximal-Seitengröße | 50 / 100 Einträge, umgesetzt |
| Completion-Werte | höchstens 50, umgesetzt |
| Binding-Zielscan | höchstens 1.000 Treffer, umgesetzt |
| Gerätescan | höchstens 1.000 registrierte Geräte, umgesetzt |
| aktive verwaltete Client-Tokens | 100, umgesetzt |
| aufbewahrte Token-Datensätze | 500; Altstände werden beim Erstellen bereinigt |
| lokaler Listener-Health-Probe | 2 Sekunden, 4 KiB, nur `127.0.0.1:8100/health`, umgesetzt |
| opaker Cursor | höchstens 2.048 Zeichen, HMAC-signiert, umgesetzt |
| normale Toolausgabe, Zielwert | höchstens 32.000 Zeichen |
| normale Toolausgabe, harte Grenze | 100.000 Zeichen |
| synchrone Toollaufzeit | 30 Sekunden |
| parallele Leseaufrufe pro Identität | 4 |
| parallele Schreibaufrufe pro Identität | 1 |
| vom MCP erzeugte Widget-ID | höchstens 128 Zeichen, umgesetzt |
| Grid-Zeilen oder -Spalten | derzeit jeweils höchstens 32 |
| GlowLine-Punkte pro Operation | 1000 |
| MCP-App-Bundle | höchstens 512 KiB, keine externen Origins |

Für Placement-Eingaben gelten zusätzlich:

- numerische `x`/`y`: `-4096` bis `4096`
- numerische Breite/Höhe: `1` bis `4096`
- Prozentwerte: `0%` bis `100%`
- Grid-Index: `0` bis `63`
- Grid-Span: `1` bis `64`, zusätzlich passend zu den Tracks

Größere Resultate werden nicht abgeschnitten und als scheinbar vollständig
markiert. Sie liefern Cursor, Resource-Link oder Job-ID. Das Ziel von 32.000
Zeichen bleibt unter der Claude-Code-Warnschwelle von ungefähr 10.000 Tokens;
100.000 Zeichen entspricht zugleich der Schwelle, ab der Claude Managed
Agents MCP-Ausgaben in eine Sandboxdatei auslagern können.

### 8.4 Toolkatalog und Claude-Limits

- Es werden ungefähr zwölf fachliche Tools veröffentlicht, nicht hunderte
  Property-Tools.
- Claude Code lädt MCP-Tools standardmäßig bei Bedarf. Trotzdem bleiben Namen
  und Beschreibungen kurz und eindeutig.
- Claude Code warnt ab 10.000 Output-Tokens und verwendet standardmäßig ein
  Maximum von 25.000 Tokens; einzelne Texttools können bis zur dokumentierten
  Obergrenze mit `anthropic/maxResultSizeChars` versehen werden. Diese
  herstellerspezifische Metadatenoption ist nur ein Client-Hinweis und ersetzt
  nicht die eigenen Limits.
- Der Claude Messages API MCP Connector unterstützt derzeit nur Tools und
  benötigt einen öffentlich erreichbaren HTTP-Server.
- Claude Managed Agents erlauben derzeit bis zu 20 MCP-Server pro Agent;
  dieses clientseitige Limit beeinflusst die Serverarchitektur nicht.

## 9. MCP-App für Platzierung und Bindings

Die MCP-Apps-Erweiterung ist optional ausgehandelt. Unterstützte Hosts erhalten
zwei sandboxed Views:

### Preview

- Canvas mit passendem Seitenverhältnis
- Auswahl von Root, Seite, Layer oder Messagebox
- Vorher-/Nachher-Umschaltung
- markierte geänderte Widgets und Bounding Boxes
- Layoutwarnungen für Flex/Grid, Overflow und Renderer-Näherungen

### Change-Set Review

- semantische Operationsliste statt rohem JSON
- Eigenschaften- und Style-Diff
- getrennte Tabellen für Projekt- und Viewer-Bindings
- Validierungsfehler, Warnungen und Revisionsstatus
- Schaltflächen für Verwerfen und Übernehmen

Die View ruft nur vorab registrierte Servertools über die MCP-App-Bridge auf.
Sie hat keine direkte Fetch-Berechtigung ins LAN, keine Kamera-/Mikrofonrechte,
keine Projektsecrets und eine restriktive CSP. Der Apply-Button umgeht weder
Toolbestätigung noch Backend-Capabilities.

## 10. Umsetzung in Phasen

### M0: Architekturentscheidungen und Testgerüst

- ADR für Protokollrevision, SDK v2, Transporttrennung und Auth-Modi
- offiziellen MCP Inspector und Conformance-Szenarien in Dev-Checks aufnehmen
- Contract-Fixtures für `2026-07-28` und `2025-11-25`
- zentrale `assistant_tools/limits.py` und dokumentierte Limits-Resource
- bestehende Limitlücken mit Regressionstests festhalten

Abnahme:

- keine Produktivfunktion, aber reproduzierbare Protokoll- und Limit-Tests
- Dependency-Lock und Audit prüfen das offizielle SDK

### M1: Gemeinsame Tool-Anwendungsfassade

- `AssistantToolService` mit injizierten bestehenden Services
- kompakte Projekt-, Widget-, Surface-, Binding- und Geräteprojektionen
- opake Cursor und deterministische Sortierung
- einheitliches Ergebnis-/Fehlermodell unabhängig von MCP
- Unit-Tests ohne Transport oder FastAPI-Requestobjekte

Abnahme:

- Leseabfragen funktionieren direkt gegen die Anwendungsfassade
- keine duplizierte Speicherung oder Capability-Logik

### M2: Read-only-MCP

- getrennte MCP-ASGI-App mit SDK v2
- `server/discover`, Tools, Resources, Templates, Prompts und Completions
- Tools `display_catalog`, `display_project_read`,
  `display_project_validate`, `display_preview`, `display_device_read`
- strukturierte Ausgaben, Paginierung, Output-Budgets und Cancellation
- LAN-Token nur für Read-Scopes

Abnahme:

- Claude Code kann ein Projekt analysieren und ein einzelnes Widget lesen,
  ohne das ganze Projekt in den Kontext zu laden
- Claude API kann denselben Ablauf ausschließlich über Read-tools ausführen
- keine Read-Operation verändert Revision, Dateien oder Viewer-Sidecars

### M3: Placement- und Projekt-Change-Sets

- semantische Projektoperationen und TTL-ChangeSetStore
- absolute, aligned, Flex- und Grid-Platzierung
- Seiten, Layer, Messageboxen, Hierarchie und Reparenting
- Backend-Layoutprojektion plus Paritäts-Fixtures zu `frontend/layout.js`
- Vorschau, Validierung, Operations- und Ergebnislimits

Abnahme:

- Widget kann in Root, Seite, Layer und Container platziert werden
- Flex-/Grid-Mitglieder erhalten keine irreführenden absoluten Positionen
- Zyklen, ungültige Align-Ziele, Overflow und mehr als 1000 Widgets werden
  vor Apply abgelehnt

### M4: Vollständige Binding-Change-Sets

- Projekt-Bindings über vorhandene `binding_schemas()` und Validatoren
- Viewer-Bindings über `validate_bindings()` und Registry-Prüfung
- kompatible Entity-/Widget-Ziele als paginierte Abfrage
- Custom-YAML nur lesen/validieren, nicht frei erzeugen
- Bindings im Change-Set-Diff und in der Vorschau

Abnahme:

- alle 15 Entity-Domänen und 20 Binding-Widgettypen sind abgedeckt
- inkompatible Richtung, Property, Event, Command oder Datentyp wird blockiert
- Viewer- und Projekt-Binding können nicht ineinander konvertiert werden

### M5: Revisionsgeschütztes Apply und Audit

- `display_changeset_apply` mit Rollen, Scopes, Basisrevision und Einmal-ID
- Multi-Round-Trip-Bestätigung bei Client-Unterstützung
- atomisches Speichern über `ProjectStore`/`ViewerBindingStore`
- Audit für Vorschlag, Bestätigung, Apply, Konflikt und Fehler
- Wiederholungs- und Race-Condition-Tests

Abnahme:

- doppeltes Apply ist idempotent oder liefert einen eindeutigen Status
- fremde, abgelaufene oder revisionsveraltete Change-Sets werden abgelehnt
- partielle Speicherung von Projekt und Viewer-Sidecar ist ausgeschlossen;
  falls beide betroffen sind, wird eine transaktionale Koordination ergänzt

### M6: YAML, Konfiguration, Build und Installation

- `display_yaml_transform` nutzt Import, Export, Bundle und Merge-Service
- Entwurf/Publish strikt an vorhandene Capabilities und Revisionen koppeln
- Build als bestehender Job plus optionale MCP-Tasks-Erweiterung
- Installation als getrenntes destruktives Tool mit exaktem Artefakt/Ziel
- keine generische Shell, URL, Host-, Port- oder Command-Eingabe

Abnahme:

- Viewer kann nur validieren/exportieren
- Editor kann Entwurf, Publisher kann Publish, Installer kann Build/Install
- unbekannte YAML-Blöcke bleiben beim vorgesehenen Roundtrip erhalten
- Abbruch und Timeout hinterlassen einen eindeutigen Jobstatus

### M7: HTTP-Auth, Add-on-Konfiguration und Clientpakete

- optionaler Port `8100/tcp`, standardmäßig deaktiviert
- Token-Verwaltung in der App: erzeugen, Scopes wählen, Ablauf, widerrufen
  (Systemseite und Admin-API umgesetzt)
- OAuth-2.1-Resource-Server für Remote-Modus
- Origin-/Host-/Body-Limits und getrennte MCP-Rate-Buckets
- kopierbare Claude-Code-Konfiguration (umgesetzt)
- stdio-Bridge und signierbares MCPB-Paket (DXT-Nachfolger) für Claude Desktop
- Remote-Deployment-Anleitung mit TLS und Reverse Proxy/Tunnel

Abnahme:

- Upgrade aktiviert keinen neuen Netzport automatisch
- Ingress bleibt auf den Ingress-Proxy beschränkt
- LAN- und Remote-Identitäten erscheinen korrekt im Audit
- widerrufene Tokens funktionieren sofort nicht mehr

### M8: MCP Apps und eingebaute KI-Hilfe

- MCP-App-Resources für Vorschau und Change-Set-Review
- CSP, Sandbox, Bundle-Integrität und UI-Bridge-Tests
- optionales Hilfe-Panel im Display Editor als separater MCP-Client/Modellanbieter
- dieselben Toolservices und Change-Sets wie externe Clients verwenden
- Modell-API-Schlüssel ausschließlich serverseitig speichern

Abnahme:

- Claude/Claude Desktop zeigen bei Host-Unterstützung die interaktive Vorschau
- nicht unterstützende Clients erhalten weiterhin vollständige Text-/JSON-Diffs
- interne und externe KI-Hilfe erzeugen identische semantische Operationen

### M9: Härtung, Kompatibilität und Release

- Fuzzing für JSON Schemas, Cursors, URIs, Projektbäume und Binding-Inputs
- Prompt-Injection-Tests für Labels, YAML, Entity-Namen und Toolresultate
- Lasttests für Rate, Parallelität, große Projekte und langsame Clients
- Conformance-Tests gegen beide MCP-Revisionen
- Claude Code, Claude Desktop/MCPB und öffentlicher Claude-Connector als
  getrennte Acceptance-Journeys
- Dokumentation, Changelog, Migration und Notfallabschaltung

Abnahme:

- alle Quality Gates bleiben unverändert erfüllt
- kein Tool überschreitet unbemerkt sein Outputbudget
- ein deaktivierter MCP-Modus hinterlässt keinen Listener
- Sicherheitsreview bestätigt Least Privilege und keine Tokenweitergabe

## 11. Testplan

### Unit-Tests

- semantische Operationen und kanonische Normalisierung
- Placement je Surface und Layoutmodus
- ID-, Tiefen-, Mengen-, Body- und Outputlimits
- Binding-Kompatibilitätsmatrix und Sonderfälle
- Change-Set-TTL, Ownership, Einmalverwendung und Revision
- Cursor-Signatur, Paginierung und deterministische Reihenfolge
- Scope/App-Rollen-Schnittmenge

### Integrations- und Protokolltests

- `server/discover` für `2026-07-28`
- Legacy-Initialize für `2025-11-25`
- Tool-/Resource-/Prompt-Listing und Cache-Hinweise
- Input-/Output-Schema-Validierung
- Streamable HTTP JSON und request-scoped Streaming
- MRTR-Bestätigung mit Fallback
- Tasks-Erweiterung nur nach Aushandlung
- stdio-Bridge ohne Protokolltext auf stdout

### API- und Sicherheitstests

- Origin-, Host-, Audience-, Issuer-, Scope- und Ablaufprüfung
- falsches oder fehlendes `Content-Length`, Chunked Body und Oversize
- DNS-Rebinding, Pfadmanipulation und Resource-URI-Injection
- fremde Change-Set-ID und Cross-User-Revisionskonflikt
- gesperrtes Widget, ungültiges `align_to`, Hierarchiezyklus
- Custom-YAML/Lambda, Gerätebefehl und Install ohne Berechtigung
- HTML-/Script-Injection in MCP App und Vorschau

### Client-Acceptance

- Claude Code über LAN-HTTP
- Claude Code über stdio-Bridge
- Claude Desktop über MCPB
- Claude Remote-Connector über öffentliches Test-HTTPS/OAuth
- Claude Messages API im Tools-only-Modus
- MCP Inspector und mindestens ein weiterer unabhängiger MCP-Client

## 12. Release-Schnitte

| Release | Inhalt |
|---|---|
| MCP Preview 1 | M0–M2, vollständig read-only im LAN |
| MCP Preview 2 | M3–M5, Placement, Bindings und Change-Set-Apply |
| MCP Beta | M6–M7, YAML/Build/Auth/Clientpakete |
| MCP 1.0 | M8–M9, MCP Apps, Härtung und dokumentierte Remote-Nutzung |

Der Read-only-Schnitt sollte zuerst veröffentlicht werden. Schreibende Tools
werden erst aktiviert, wenn Change-Set, Revision, Audit und Token-Scopes
gemeinsam fertig sind; kein Zwischenrelease erhält direkte unbestätigte
Projektmutationen.

## 13. Gesamt-Abnahmekriterien

MCP 1.0 ist abgeschlossen, wenn:

1. beide Protokollrevisionen die Conformance- und Contract-Tests bestehen,
2. alle 24 Widgettypen gelesen und über ihre Schemas bearbeitet werden können,
3. absolute, aligned, Flex- und Grid-Platzierung korrekt normalisiert wird,
4. Seiten, Layer, Messageboxen und verschachtelte Widgets adressierbar sind,
5. alle unterstützten Projekt- und Viewer-Bindings typgerecht funktionieren,
6. jede dauerhafte Änderung Change-Set, Berechtigung und Revision benötigt,
7. Tools-only-Clients keinen kritischen Kontext ausschließlich als Resource
   benötigen,
8. Claude Code lokal und Claude Remote über die vorgesehenen getrennten
   Betriebsarten erfolgreich getestet sind,
9. Limits in Code, MCP-Resource, UI und Dokumentation identisch sind,
10. Backend-, Frontend-, Browser-, Security- und Container-Checks unverändert
    erfolgreich bleiben.

## 14. Quellenstand der Protokollprüfung

- MCP `2026-07-28` Release:
  <https://blog.modelcontextprotocol.io/posts/2026-07-28/>
- MCP Python SDK v2:
  <https://github.com/modelcontextprotocol/python-sdk>
- MCP Apps:
  <https://modelcontextprotocol.io/extensions/apps/overview>
- MCP-Tools und Tool-Hinweise:
  <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
- Claude Code MCP, Outputlimits und Tool Search:
  <https://code.claude.com/docs/en/mcp>
- Claude Messages API MCP Connector und Einschränkungen:
  <https://platform.claude.com/docs/en/agents-and-tools/mcp-connector>
- Claude Remote Custom Connectors und Netzanforderungen:
  <https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp>
- Home-Assistant-App-Konfiguration und Ports:
  <https://developers.home-assistant.io/docs/apps/configuration/>
- Home-Assistant-Ingress-Sicherheitsmodell:
  <https://developers.home-assistant.io/docs/apps/presentation/#ingress>
