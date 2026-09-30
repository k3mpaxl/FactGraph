# FactGraph MVP — Browser-Boards mit REST und MCP

FactGraph speichert Boards und Aktionen **ausschließlich im IndexedDB des Browsers**. Der lokale FastAPI-Server liefert die Oberfläche aus, stellt REST und FastMCP bereit und verteilt WebSocket-Nachrichten. Er speichert keine Board-Daten. Es gibt kein Login und keine externe Datenbank.

## Start

Mit Docker:

```bash
docker compose -f deploy/compose.yaml up --build
```

Mit einem veröffentlichten Docker-Hub-Image:

```bash
docker run --rm -p 8080:8080 <DOCKERHUB_USERNAME>/factgraph:latest
```

Oder direkt mit Python 3.11+ und Node.js 20+:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd web && npm ci && npm run build && cd ..
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8080
```

- Oberfläche: [http://127.0.0.1:8080](http://127.0.0.1:8080)
- REST-Dokumentation: [http://127.0.0.1:8080/docs](http://127.0.0.1:8080/docs)
- MCP-Endpunkt: `http://127.0.0.1:8080/mcp/` (Streamable HTTP)

Von einem anderen Gerät im selben LAN `http://<LAN-IP-des-Servers>:8080/boards/<BOARD-UUID>` öffnen. Auf diesem Rechner kann die LAN-IP zum Beispiel mit `ipconfig getifaddr en0` ermittelt werden. Für Docker `FACTGRAPH_BIND_IP=0.0.0.0 docker compose -f deploy/compose.yaml up --build` verwenden. Die Anwendung hat keine Anmeldung; den Port daher nur in einem vertrauenswürdigen Netz freigeben. Ein Browser mit dem Board muss verbunden bleiben, damit neue Geräte die im Browser gespeicherten Aktionen empfangen können.

Die Board-URL enthält eine UUID. Das **Board-Menü** oben links kopiert den Link, legt neue Boards an und zeigt frühere Boards im selben Browser.

## Oberfläche

Die Oberfläche ist auf maximale Graph-Fläche ausgelegt: eine schmale Kopfleiste mit Board-Menü, Ansichten (Graph, Timeline, Evidence review, Activity), Suche, Undo/Redo, **Create** und API/MCP. Links lässt sich der **Entity-Explorer** (nach Typ gruppiert, mit Suche und Beziehungsanzahl) einblenden, rechts erscheint der **Inspector** nur bei einer Auswahl. Hell- und Dunkelmodus folgen dem System und lassen sich umschalten.

Für große Graphen:

- **Fokus**: Eine ausgewählte Entität hebt ihre direkten Nachbarn hervor, alles andere tritt zurück (Fadenkreuz in der Canvas-Leiste).
- **Springen**: `Cmd/Ctrl+K` öffnet die Command-Palette; ein Treffer wird ausgewählt und mit Nachbarn ins Bild gezoomt. Enter in der Suche springt zum ersten Treffer. Im Inspector führen Beziehungen und Nachbarn per Klick weiter.
- **Level of Detail**: Kantenbeschriftungen erscheinen erst ab mittlerem Zoom, Details der Knoten erst beim Hineinzoomen. Kanten docken am Knotenrand an; parallele Beziehungen werden gebogen.
- **Minimap** schaltet sich ab 60 Knoten automatisch ein; **Arrange** ordnet Graph oder Auswahl mit ELK an.
- **Status-Filter** (oben rechts im Graph) und **Evidence-Zeitfenster** (`T`) filtern Kanten nach Prüfstatus und Zeitraum.

| Taste | Aktion |
| --- | --- |
| `Cmd/Ctrl+K` | Command-Palette / Entität suchen |
| `/` | Suche fokussieren |
| `N` | Neue Entität in der Mitte |
| `F` | Graph einpassen bzw. Auswahl zentrieren |
| `1`–`4` | Ansicht wechseln |
| `E` / `T` | Explorer / Zeitfenster umschalten |
| `Cmd/Ctrl+Z`, `Shift+Cmd/Ctrl+Z` | Undo / Redo |
| `Entf` | Auswahl löschen |
| `G` | Mehrfachauswahl gruppieren |
| `?` | Alle Tastenkürzel |

## Ereignisse, Ebenen und Gruppen (ab 0.4.1)

### Ereignisse mit mehreren Beteiligten

„Angreifer verwendet IP a.a.a.a und Service Principal B und listet Key Vault C auf“ ist **ein** Ereignis, keine drei Kanten. Eine **Activity** hat eine Operation (`listed secrets`), optional eine ATT&CK-Technik, einen Zeitraum und Beteiligte mit Rollen: `actor`, `identity`, `source`, `tool`, `via`, `target`, `other`. Belege hängen am ganzen Ereignis; Review, Status, Timeline und Zeitfenster funktionieren wie bei Beziehungen. Im Graph erscheint die Activity als Raute mit beschrifteten Speichen, in der Ebenen-Leiste lässt sie sich als einfache Kante darstellen.

- UI: **Create → Activity…**, Command-Palette oder Log-Import im Modus **Activities · several roles** (Spalte → Rolle → Typ, z. B. `CallerIPAddress → source → IP`, `AppId → identity → Service Principal`, `ResourceId → target → Key Vault`). Zeilen mit gleicher Operation und gleichen Beteiligten ergeben eine Activity, jede Zeile ist ein eigener Beleg mit Zeitstempel.
- REST/MCP: `POST /activities` (`rest_create_activity`, vereinfacht `add_activity`), `GET/PATCH/DELETE /activities/{id}`, `POST /imports/activities`. Belege über die bestehenden `/relations/{id}/evidence`-Endpunkte.
- Die Zuordnung „IP gehört zum Angreifer“ ist eine eigene Aussage mit eigenem Beleg.

### Ebenen

Jeder Typ gehört zu einer Ebene: Identity & access, Network, Endpoint, Workload (Kubernetes), Cloud control plane, Data & storage, Code & CI, Other. Die Ebene wird aus dem Typ abgeleitet und lässt sich pro Typ (Typ-Editor) oder pro Entität (Inspector → Details) überschreiben. Die Schaltfläche **Layers** blendet Ebenen ein und aus (Verbindungen zu ausgeblendeten Ebenen zeigt ein Zähler am Knoten), zeichnet Bahnen und ordnet den Graphen **nach Ebenen** an. Kombinationen lassen sich als **Perspektive** speichern, werden mit dem Board synchronisiert und sind per `?lens=<id>` verlinkbar.

**Inhalt einklappen**: Hat ein Device oder Cluster `contains`/`runs`/`hosts`-Beziehungen, klappt der Kontextmenüeintrag **Collapse contents** alles darin Enthaltene in den Knoten („12 inside“). Verbindungen der Inhalte laufen dann gebündelt über den Container.

### Gruppen

Eine Gruppe bündelt viele Entitäten zu einem Knoten, z. B. 699 von 700 Repositories. Mitglieder sind explizit (Mehrfachauswahl → `G`) oder per Regel (Typ und/oder Textmuster); neue passende Entitäten kommen automatisch hinzu. **Take out** (Kontextmenü oder Inspector) hält einzelne Entitäten sichtbar außerhalb der Gruppe. Kanten zur Gruppe werden gebündelt und zeigen die Anzahl (`cloned ×699`), der Statusbalken zeigt die Prüfstatus der gebündelten Beziehungen. **Groups** in der Canvas-Leiste schlägt Gruppen aus Entitäten gleichen Typs mit identischen Verbindungen vor und nennt die Ausreißer, die sich unterscheiden. Gruppen und Perspektiven ändern nur die Ansicht, nie Aussagen oder Belege. REST/MCP: `/groups` (`rest_create_group`, vereinfacht `group_entities`), `/perspectives`, `GET /api/layers`.

### Synchronisation und Konflikte

Alle Änderungen sind Aktionen mit logischer Uhr; jeder Browser sortiert sie gleich (Uhr, Akteur, ID), daher ergibt jede Ankunftsreihenfolge denselben Graphen. Gleichzeitige Änderungen desselben Feldes entscheidet diese Reihenfolge deterministisch. Wird eine Entität zusammengeführt, während ein anderer Browser (auch offline) noch mit der alten ID arbeitet, landen dessen neue Beziehungen, Activity-Rollen, Kennungen und Gruppenänderungen beim Ziel der Zusammenführung statt verloren zu gehen. Gruppenmitglieder lassen sich inkrementell ändern (`add_members`, `exclude` …), damit gleichzeitige Änderungen zweier Analysten beide erhalten bleiben. Quellen und Belege prüfen `expected_revision` und melden Konflikte mit HTTP 409.

## Untersuchung im Graphen

Ein Knoten kann etwa eine IP, Datei im Repository, Umgebungsvariable, ein Credential oder eine Azure-Ressource sein. Eine gerichtete Kante beschreibt den Zusammenhang. Quellen und Aussagen belegen oder widerlegen ihn. Beispiel:

```text
IP --accessed--> repo/.env --enthält--> Azure-Credential
Azure-Credential --ermöglicht Zugriff auf--> Blob-Storage
```

The canvas uses React Flow with typed entity cards and visible connection handles:

- Drag a type from **Add entity** onto the canvas, or double-click empty space. Drag a node's right handle to another node, or onto empty space to create the next entity and relation together.
- Double-click a title to rename. Right-click for type/color editing, merge, copy ID, pin, or delete. **Arrange** uses ELK; pinned nodes retain their positions. Multi-select with Shift, align, distribute, and move groups.
- **Undo / Redo** treats an import or group movement as one action. Browser Back changes the active view. The header is 38 px high; board/import/export and integration actions live in compact menus.
- The evidence window uses observation times, includes an explicit undated toggle, and steps through event boundaries. Confirmed evidence within the selected interval determines the visible relationship status.

### Evidence review

New and legacy evidence starts **Unconfirmed**. Open **Evidence review** to inspect the claim, observation, event locator, original source/results, KQL query, interpretation, and history. The reader supports editing, confirmation/unconfirmation, retract/restore, and copying IDs/context for an agent. Original JSON results and the review queue are paginated.

Confirmation requires a **primary source**, source reference, stored results/excerpt, a concrete locator, observation and review note. Updating evidence, its claim, or its source invalidates confirmation. Revisions prevent stale evidence/source edits and reviews. Supports/Refutes describes the evidence direction; Confirmed/Unconfirmed describes its review. Only active confirmed evidence contributes to Supported/Refuted/Disputed.

The shared session token does not prove that a reviewer is human. Agents are instructed to submit unconfirmed findings for analyst review; enforced human-only approval would require separate permissions.

## REST und MCP

**Ein Browser mit dem Board muss geöffnet und verbunden sein.** REST und MCP senden Schreibaufträge an diesen Browser und antworten erst nach dessen IndexedDB-Bestätigung. Ohne Browser antwortet REST mit `409`. So bleibt die Architektur ohne Server-Datenbank erhalten.

Beim Öffnen eines Boards erzeugt der Browser ein zufälliges Sitzungs-Token. REST und MCP erwarten es im Header `X-FactGraph-Token`; MCP akzeptiert zusätzlich den Tool-Parameter `session_token`. Nur ein damit verbundenes Browser-Board darf Aktionen ausführen. Das Token ist eine lokale Sitzungskopplung, kein Benutzerkonto und kein Ersatz für einen vorgeschalteten Auth-Proxy.

| Aufgabe | REST | MCP |
| --- | --- | --- |
| Graph lesen | `GET /api/boards/{id}/graph` | `board_graph` |
| Entität anlegen | `POST /api/boards/{id}/entities` | `add_entity` |
| Entität ändern | `PATCH /api/boards/{id}/entities/{entity_id}` | `update_entity` |
| Entitäten zusammenführen | `POST /api/boards/{id}/entities/{entity_id}/merge` | `merge_entities` |
| Entität löschen | `DELETE /api/boards/{id}/entities/{entity_id}` | `delete_entity` |
| Quelle anlegen | `POST /api/boards/{id}/sources` | `add_source` |
| Quelle ändern | `PATCH /api/boards/{id}/sources/{source_id}` | `update_source` |
| Quelle löschen | `DELETE /api/boards/{id}/sources/{source_id}` | `delete_source` |
| Kante anlegen | `POST /api/boards/{id}/relations` | `link_entities` |
| Kante ändern | `PATCH /api/boards/{id}/relations/{relation_id}` | `update_relationship` |
| Kante löschen | `DELETE /api/boards/{id}/relations/{relation_id}` | `delete_relationship` |
| Beleg hinzufügen | `POST /api/boards/{id}/relations/{relation_id}/evidence` | `add_evidence` |
| Beleg ändern | `PATCH /api/boards/{id}/relations/{relation_id}/evidence/{evidence_id}` | `update_evidence` |
| Beleg löschen | `DELETE /api/boards/{id}/relations/{relation_id}/evidence/{evidence_id}` | `delete_evidence` |
| KQL-Ergebnisse importieren | `POST /api/boards/{id}/imports/kql` | `add_kql_evidence` (bis 100 Zeilen) |
| Modellierungsregeln lesen | — | `factgraph_guidelines` |

Beispiel für eine Entität:

```bash
curl -X POST 'http://127.0.0.1:8080/api/boards/BOARD_UUID/entities' \
  -H 'Content-Type: application/json' \
  -d '{"name":"repo/.env","kind":"Datei"}'
```

Die Antwort enthält die Entitäts-ID. Mit zwei IDs eine Kante erstellen:

```bash
curl -X POST 'http://127.0.0.1:8080/api/boards/BOARD_UUID/relations' \
  -H 'Content-Type: application/json' \
  -d '{"subject_id":"IP_UUID","predicate":"accessed","object_id":"FILE_UUID","note":"Zeile aus Access-Log"}'
```

Für große Mengen `POST /api/boards/{id}/actions` mit `{"actions":[{"id":"UUID","type":"entity.add","payload":{...}}, ...]}` verwenden. Die REST-API verarbeitet in Chargen von 200, mit gebündelter Neuzeichnung. Eigene Aktions-UUIDs machen Wiederholungen idempotent. Unterstützte Typen stehen in [board.ts](web/src/board.ts). Der Endpunkt nimmt bis zu 50.000 Aktionen pro Anfrage an. Für Logdaten ist der Import-Endpunkt einfacher.

FastMCP ist unter `/mcp/` eingebunden. Ein lokaler Client kann sich so verbinden:

```python
from fastmcp import Client

async with Client("http://127.0.0.1:8080/mcp/") as client:
    result = await client.call_tool("add_entity", {
        "board_id": "BOARD_UUID", "session_token": "TOKEN_FROM_BOARD_UI",
        "name": "Azure-Credential", "kind": "Credential"
    })
print(result.data)
```

Der MCP-Server liefert zusätzlich verbindliche Arbeitsregeln: Nodes sollen konkrete Entities sein, gerichtete Beziehungen sollen nicht erfunden werden, wichtige Claims brauchen Evidence, primäre Quellen (Logs, KQL-Ergebnisse, Repository-Dateien und First-Party-Telemetrie) haben Vorrang und sekundäre Quellen dienen nur als Kontext. Unsicherheit, Widerspruch, Confidence und Evidence-Zeiträume werden erhalten. Diese Regeln stehen in den Server-Instructions und können mit `factgraph_guidelines` abgerufen werden.

### VS Code / GitHub Copilot

Im Repository liegt bereits [.vscode/mcp.json](.vscode/mcp.json). VS Code öffnen, den Ordner `/Users/gregor/Projekte/FactGraph` laden und in der Command Palette **MCP: List Servers** aufrufen. Den Server `factgraph` starten; danach stehen Lese-, Create-, Update- und Evidence-Tools sowie `factgraph_guidelines` im Agent-Tools-Picker zur Verfügung. Alternativ **MCP: Open Workspace Folder Configuration** öffnen und diesen Eintrag einfügen:

```json
{
  "servers": {
    "factgraph": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp/",
      "headers": {
        "X-FactGraph-Token": "${env:FACTGRAPH_TOKEN}"
      }
    }
  }
}
```

Vor einem Tool-Aufruf muss die passende Board-URL in einem Browser geöffnet sein. Das Token kann im **API/MCP-Menü** (Stecker-Symbol oben rechts) über **Copy session token** kopiert werden. Für VS Code `FACTGRAPH_TOKEN` auf den kopierten Wert setzen und den MCP-Server neu verbinden. Für REST:

```bash
curl -X POST 'http://127.0.0.1:8080/api/boards/BOARD_UUID/entities' \
  -H 'X-FactGraph-Token: TOKEN_FROM_BOARD_UI' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Azure-Credential","kind":"Credential"}'
```

Für VS Code auf einem anderen Gerät `127.0.0.1` durch die LAN-IP des Servers ersetzen, zum Beispiel `http://10.42.12.221:8080/mcp/`.

## Aktivitätslogs und KQL als Evidence

**Logs/KQL** importiert CSV, JSON-Arrays oder JSONL direkt in der Oberfläche, ohne Agent. Für Skripte gibt es `POST /api/boards/{id}/imports/file` (Multipart), `/imports/activity` (JSON-Zeilen) und `/imports/kql` (JSON-Zeilen mit `query`). Bis zu 20 MB und 50.000 Zeilen pro Datei sind erlaubt. Quell- und Zielspalten werden für gängige Namen automatisch erkannt oder explizit angegeben. `predicate_field` kann pro Zeile einen anderen Kantentyp liefern; andernfalls gilt der gemeinsame `predicate`. Entitätsarten lassen sich mit `subject_kind` und `object_kind` festlegen.

Beispiel für bereits vorliegende KQL-Ergebnisse:

```json
{
  "title": "Access Logs 28.09.",
  "query": "AccessLogs | project IPAddress, FilePath, TimeGenerated",
  "rows": [
    {"IPAddress": "10.0.0.8", "FilePath": "repo/.env", "TimeGenerated": "2026-09-28T10:00:00Z"}
  ],
  "subject_field": "IPAddress",
  "object_field": "FilePath",
  "subject_kind": "IP",
  "object_kind": "Datei",
  "predicate": "accessed"
}
```

Der Import legt IP und Datei als Knoten, `IP → accessed → Datei` als Kante, die KQL-Abfrage als Quelle und jede Ergebniszeile als einzelne stützende Aussage an. Bestehende Knoten und Kanten mit gleichem Typ, Namen und Bezeichner werden wiederverwendet. Dieselben Ergebniszeilen können erneut importiert werden, ohne Belege zu verdoppeln. **FactGraph führt KQL nicht aus**; die Abfrage und die gelieferten Ergebnisse werden gemeinsam als Herkunft des Belegs gespeichert.

Weitere Schritte der lateralen Bewegung können aus anderen Logdateien, manuell, per MCP oder REST ergänzt werden. Ein Beleg kann über `/evidence` ausdrücklich widerlegt werden (`"stance":"refutes"`).

## Synchronisierung und Grenzen

- Jede Änderung ist eine Aktion mit UUID und logischer Uhr. Geöffnete Ansichten desselben Boards tauschen beim Beitritt und Wiederverbinden ihre Historien aus; neue Aktionen, Namen und Anwesenheit werden live verteilt. Cursor werden bewusst nicht übertragen, weil viewport-relative Positionen bei unterschiedlichen Graph-Ansichten irreführend sind.
- Ohne Verbindung bleiben Änderungen im Browser und werden später mit offenen Peers synchronisiert.
- Wenn kein Browser mit den Board-Daten geöffnet ist, kann ein neues Gerät das Board allein aus der UUID nicht wiederherstellen. Dafür einen zuvor exportierten JSON-Datenstand importieren. Werden Browserdaten gelöscht, ist ohne Export keine Wiederherstellung möglich.
- **Export** lädt den Aktionsverlauf als JSON; **JSON** kopiert ihn alternativ in die Zwischenablage. **Import** kann auch ältere FactGraph-JSON-Exporte übernehmen. Das Repository enthält keine Board-Datenbank und keine Forschungs-/Beispieldaten.
- Der Dienst ist standardmäßig nur auf `127.0.0.1` erreichbar. Für andere Geräte im lokalen Netz kann Docker mit `FACTGRAPH_BIND_IP=0.0.0.0 docker compose -f deploy/compose.yaml up --build` gestartet werden. Ohne Authentifizierung kann jeder mit Zugang zum Relay und Board-Link lesen und schreiben.

## GitHub und Docker Hub

Das Repository enthält zwei GitHub-Actions:

- `CI` führt die Python-Tests aus, baut das Frontend und prüft das Docker-Image bei Pushes und Pull Requests.
- `Publish Docker image` veröffentlicht bei einem Versionstag wie `v0.4.1` oder über **Run workflow** nach Docker Hub.

Dafür im GitHub-Repository die Actions-Secrets `DOCKERHUB_USERNAME` und `DOCKERHUB_TOKEN` anlegen. Der Token sollte ein Docker-Hub-Access-Token mit Schreibrecht für das Image `factgraph` sein. Nach dem Push eines Tags:

```bash
git tag v0.4.1
git push origin v0.4.1
```

Das Image ist danach als `DOCKERHUB_USERNAME/factgraph:latest` und mit Versions-/Commit-Tags verfügbar. Für eine LAN-Freigabe beim Start des Compose-Stacks:

```bash
FACTGRAPH_BIND_IP=0.0.0.0 docker compose -f deploy/compose.yaml up -d
```

Die Docker-Hub-Tags enthalten `linux/amd64` und `linux/arm64`, damit dasselbe
Image auf üblichen Linux-Servern und Apple-Silicon-Rechnern startet. Ein
manueller Multi-Arch-Publish mit unveränderter Version ist ebenfalls möglich:

```bash
./deploy/publish-multiarch.sh
```

Für einen anderen Namespace oder Tag können `FACTGRAPH_IMAGE` und
`FACTGRAPH_VERSION` gesetzt werden.

## Tests

```bash
.venv/bin/python -m unittest discover -s tests -v
cd web && npm run build
```

## Evidenzzeit und Bearbeitung

Die Zeitachse zeigt aktive Belege chronologisch mit Uhrzeit in UTC. Belege derselben Beziehung mit demselben Zeitraum werden als ein Ereignis zusammengefasst. `valid_from` und `valid_to` beschreiben den Evidenzzeitraum; ein einzelner Beginn ist ein Ereigniszeitpunkt. Unbekannte Zeiten stehen am Ende. Erstellungszeiten werden nicht als Ersatz verwendet. Ältere Logimporte werden anhand der originalen JSON-Zeile gelesen, anschließend gelten explizite Gültigkeitszeiten der Beziehung als Rückfall.

Logimporte erkennen `TimeGenerated`, `timestamp`, `Timestamp`, `time`, `event_time` sowie `StartTime`/`EndTime` und `valid_from`/`valid_to`. REST und MCP unterstützen Evidenzzeiträume beim Anlegen von Beziehungen und Belegen.

Entitäten lassen sich im Inspektor über **Edit** umbenennen sowie in Typ, Farbe und Beschreibung ändern oder über **Merge** zusammenführen. Evidence kann direkt im Beleg bearbeitet werden. Vollständige Board-, Entity-, Relationship-, Identifier- und Evidence-IDs lassen sich für Agent-Chats kopieren. **Undo** beziehungsweise `Ctrl/Cmd+Z` nimmt die letzte eigene Aktion über eine synchronisierte Undo-Aktion zurück.

Die Oberfläche verwaltet Boards lokal über ihre UUID. In der Oberfläche kopiert **Copy** den Endpunkt des aktuellen Boards. Die REST-Aufrufe müssen an denselben Server gehen wie die Browser-Verbindung. Ohne geöffneten Browser liefert ein Schreibaufruf `409`; unbekannte API-Pfade liefern `404`. Es gibt bewusst keinen globalen Board-Listing-Endpunkt und kein MCP-Tool zum Auflisten von Boards.

## Shared REST/MCP contracts and tests

Every JSON REST operation has a canonical `rest_<operation_id>` MCP tool with the same typed parameters, validation and result. For example, `rest_update_evidence` takes `board_id`, `relation_id`, `evidence_id`, and a `body` patch. Explicit `null` clears nullable fields; omitted fields remain unchanged. Existing MCP names remain compatible. Multipart file upload is REST-specific; MCP uses the equivalent JSON row import.

Both interfaces cover board-scoped reads, entity/relation/source/evidence CRUD, identifiers, custom types, positions, merge, evidence review/retract/restore, import preview, history, undo and redo. There is no global board listing. Source/evidence PATCH accepts `expected_revision`; review requires current evidence and source revisions. Activity records include UI/REST/MCP channel, actor and action group.

```bash
python3 -m unittest discover -s tests -v
cd web
npm ci
npm test
npx playwright install chromium
npm run test:e2e
```

Browser tests use temporary board UUIDs on port 18088 and a real HTTP MCP client. They cover analyst/agent review, null patches, cross-board token isolation, two-browser synchronization, reload persistence, connection dragging, grouped undo/redo, mobile layout, import preview/deduplication, pinned layout, and 10,000 imported evidence rows. CI runs the same workflows.
