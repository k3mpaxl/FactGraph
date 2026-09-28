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

Die Board-URL enthält eine UUID. **Link** kopiert sie; **Board** legt ein neues Board an. Die Board-Auswahl links zeigt frühere Boards im selben Browser.

## Untersuchung im Graphen

Ein Knoten kann etwa eine IP, Datei im Repository, Umgebungsvariable, ein Credential oder eine Azure-Ressource sein. Eine gerichtete Kante beschreibt den Zusammenhang. Quellen und Aussagen belegen oder widerlegen ihn. Beispiel:

```text
IP --accessed--> repo/.env --enthält--> Azure-Credential
Azure-Credential --ermöglicht Zugriff auf--> Blob-Storage
```

Im Graphen **+** für einen neuen Knoten wählen. Einen Knoten anklicken und **↗** oder **Von hier Kante erstellen** wählen; dabei kann der Zielknoten sofort angelegt oder ein vorhandener gewählt werden. Der Kantentext ist frei. Der Inspektor zeigt Quellen, Aussagen und Widersprüche.

Knoten lassen sich ziehen. Beim Loslassen rasten sie auf einem 20er-Raster ein. Die Position wird als Board-Aktion im Browser gespeichert und über WebSocket an andere geöffnete Ansichten gesendet. Der Graph behält seine Positionen auch beim Hinzufügen von Knoten und Beziehungen; **Alles anzeigen** passt nur den Ausschnitt an. `Delete` oder `Backspace` löscht die ausgewählte Entität oder Beziehung nach Bestätigung, `Escape` schließt den Inspektor oder einen Dialog. Der Inspektor liegt bei Auswahl als Overlay über dem Graphen.

Die Oberfläche verwendet weiterhin Cytoscape als 2D-Graph-Renderer. Three.js wäre für eine 3D-Ansicht möglich, würde aber die Synchronisierung, Aktionen und Rasterpositionen nicht automatisch lösen. Ein Wechsel lohnt sich erst, wenn eine echte 3D-Darstellung oder eine eigene WebGL-Szene benötigt wird.

Typen steuern die Darstellung: User/Personen erscheinen elliptisch, Devices rechteckig, AKS-Knoten hexagonal, Service Principals elliptisch, IPs und Prozesse als Rauten, Credentials/Secrets als Hexagone und Azure-Ressourcen als Oktagone. Farbe und Rand gehören jeweils zum Typ. Ein neuer Typ kann in der Entitätsmaske über **Eigener Typ…** angelegt werden; unbekannte Typen bekommen automatisch eine stabile Farbe und Form.

Bei großen Boards zeigt die Zeichnung einen begrenzten Ausschnitt; Suche und Knotenauswahl arbeiten auf dem vollständigen Datenbestand. Die Anzeige nennt sichtbare und gesamte Knoten/Kanten. Die frühere Pfadansicht bleibt vorerst ausgeblendet.

Graph, Zeitachse und synchronisierte Aktionen sind als Tabs organisiert.

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

Vor einem Tool-Aufruf muss die passende Board-URL in einem Browser geöffnet sein. Das Token kann in der kompakten API-Leiste über **Token** kopiert werden. Für VS Code `FACTGRAPH_TOKEN` auf den kopierten Wert setzen und den MCP-Server neu verbinden. Für REST:

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
- `Publish Docker image` veröffentlicht bei einem Versionstag wie `v0.3.0` oder über **Run workflow** nach Docker Hub.

Dafür im GitHub-Repository die Actions-Secrets `DOCKERHUB_USERNAME` und `DOCKERHUB_TOKEN` anlegen. Der Token sollte ein Docker-Hub-Access-Token mit Schreibrecht für das Image `factgraph` sein. Nach dem Push eines Tags:

```bash
git tag v0.3.0
git push origin v0.3.0
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
