# FactGraph — gemeinsame Incident-Analyse als Beweisgraph

FactGraph ist ein leichtgewichtiger **Relay-Dienst**, mit dem mehrere Analystinnen und Analysten zusammen mit **KI-Agenten** größere Sicherheitsvorfälle bearbeiten. Der Vorfall wird als **Graph** modelliert: Entitäten (IPs, Konten, Service Principals, Geräte, Key Vaults, Repositories …), Beziehungen und Ereignisse zwischen ihnen und zu jeder Aussage die **Belege** aus Logs, KQL-Ergebnissen oder Dateien. Menschen arbeiten im Browser, Agents über **MCP** oder **REST** – alle im selben Board, live synchronisiert.

## Die Idee

Bei einem größeren Incident entstehen schnell hunderte Spuren: Anmeldungen, Zugriffe, Prozesse, Cloud-Operationen. Wer hat was mit welcher Identität von wo getan – und woher wissen wir das? FactGraph beantwortet diese Frage als Graph und trennt dabei konsequent:

- **Was behauptet wird** (eine Kante oder ein Ereignis im Graphen),
- **womit es belegt ist** (Primärquelle, konkrete Fundstelle, Beobachtung, Zeitraum) und
- **ob es geprüft wurde** (unbestätigt, bestätigt, widerlegt, zurückgezogen).

KI-Agenten recherchieren Logs, werten Abfragen aus und tragen Funde mit Belegen ein. Analysten sehen dieselben Einträge sofort im Graphen, prüfen sie gegen das Original und bestätigen oder widersprechen. So wächst ein gemeinsames, nachvollziehbares Lagebild, statt dass Ergebnisse in Chats, Tickets und Tabellen verstreut sind.

## Architektur: Relay statt Datenbank

```text
 Analyst A (Browser)          Analyst B (Browser)
  IndexedDB ◄──────┐          ┌──────► IndexedDB
                   │ WebSocket│
             ┌─────┴──────────┴─────┐
             │   FactGraph-Server   │   speichert keine Board-Daten
             │  Relay · REST · MCP  │
             └─────┬──────────┬─────┘
                   │ REST     │ MCP
            Skripte/Importe   KI-Agent (VS Code, Claude Code …)
```

- **Die Daten liegen ausschließlich in den Browsern** (IndexedDB). Jede Änderung ist eine Aktion mit ID und logischer Uhr; alle geöffneten Browser eines Boards tauschen diese Aktionen über den Server aus und berechnen daraus denselben Graphen.
- **Der Server speichert nichts.** Er liefert die Oberfläche aus, verteilt Aktionen in Echtzeit und stellt REST und MCP bereit. Es gibt keine externe Datenbank und kein Login.
- **REST und MCP schreiben über einen geöffneten Browser.** Ein Aufruf wird an einen Browser mit dem Board weitergereicht und erst nach dessen Speicherbestätigung beantwortet. Ohne geöffnetes Board antwortet die API mit `409`.
- **Folge:** Ein Board existiert, solange mindestens ein Browser es hält. Ein neues Gerät erhält die Daten nur, während ein solcher Browser verbunden ist. Wer Browserdaten löscht, löscht die Boards – regelmäßig als JSON exportieren (Board-Menü).

## Start

Mit Docker Hub (amd64 und arm64):

```bash
docker run --rm -p 8080:8080 k3mpaxl/factgraph:latest
```

Mit Docker Compose aus dem Repository:

```bash
docker compose -f deploy/compose.yaml up --build
```

Direkt mit Python 3.11+ und Node.js 20+:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd web && npm ci && npm run build && cd ..
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8080
```

- Oberfläche: <http://127.0.0.1:8080>
- REST-Dokumentation: <http://127.0.0.1:8080/docs>
- MCP-Endpunkt: `http://127.0.0.1:8080/mcp/` (Streamable HTTP)

Jede Board-URL enthält eine UUID (`/boards/<uuid>`). Das **Board-Menü** oben links kopiert den Link, legt neue Boards an und listet die Boards dieses Browsers. Kollegen im selben Netz öffnen `http://<Server-IP>:8080/boards/<uuid>`. Compose bindet standardmäßig nur `127.0.0.1`; für das LAN:

```bash
FACTGRAPH_BIND_IP=0.0.0.0 docker compose -f deploy/compose.yaml up -d
```

> **Sicherheit:** Es gibt keine Anmeldung. Wer den Server erreicht und einen Board-Link kennt, kann das Board lesen und ändern. FactGraph nur in vertrauenswürdigen Netzen oder hinter einem Auth-Proxy betreiben.

## Arbeiten im Graphen

### Oberfläche

- Schmale Kopfleiste mit Board-Menü, Ansichten (**Graph**, **Timeline**, **Evidence review**, **Activity**), Suche, Undo/Redo, **Create** und API/MCP. Links der einklappbare **Entity-Explorer** (nach Typ gruppiert), rechts der **Inspector**, der nur bei einer Auswahl erscheint.
- Heller Modus ist Standard, der dunkle Modus lässt sich per Mond-Symbol einschalten und bleibt gespeichert.
- Beim ersten Besuch fragt FactGraph nach dem Anzeigenamen, der anderen Analysten und in der Historie erscheint.
- Das **?** oben rechts erklärt, wo die Daten liegen, zeigt den belegten Speicher, kann den Browser um dauerhafte Speicherung bitten, bietet den JSON-Export an und nennt die Versionen von App und Server. Der zweite Reiter listet alle Tastenkürzel.

### Entitäten, Beziehungen, Belege

- Entität anlegen: **Add entity** (Typ auswählen oder auf die Fläche ziehen), Doppelklick auf freie Fläche oder `N`.
- Verbinden: den rechten Anfasser eines Knotens auf einen anderen ziehen – oder auf freie Fläche, um Ziel und Beziehung in einem Schritt anzulegen.
- Doppelklick auf einen Titel benennt um; Rechtsklick bietet Typ/Farbe, Zusammenführen, ID kopieren, Fixieren, Löschen, Inhalt einklappen und Gruppen-Ausnahme.
- Der Inspector zeigt Beziehungen, Kennungen und Belege und führt per Klick zu Nachbarn weiter. **Copy context for agent** kopiert IDs und Kontext für einen Agenten-Chat.
- Lange Kantenbeschriftungen werden gekürzt; Mouseover oder Auswahl zeigt sie vollständig.

### Große Graphen

- **Fokus:** Eine Auswahl hebt ihre direkten Nachbarn hervor, der Rest tritt zurück.
- **Springen:** `Cmd/Ctrl+K` öffnet die Command-Palette; ein Treffer wird ausgewählt und mit Nachbarn ins Bild gezoomt.
- **Level of Detail:** Beschriftungen und Knotendetails erscheinen erst beim Hineinzoomen; Kanten docken am Knotenrand an, parallele Beziehungen werden gebogen.
- **Minimap** ab 60 Knoten automatisch.
- **Arrange:** bis 150 Knoten als gerichteter Fluss (links → rechts, ↓ für oben → unten), darüber **organisch** (Kräfte-Layout: Verbundenes bildet Cluster, Karten überlappen nicht; auch direkt über das Knoten-Symbol wählbar). 1.100 Knoten dauern rund zwei Sekunden. Fixierte Knoten behalten ihre Position.
- **Status-Filter** und **Evidence-Zeitfenster** (`T`) filtern Kanten nach Prüfstatus und Zeitraum; das Zeitfenster lässt sich Schritt für Schritt abspielen.

### Maus, Trackpad, Tastatur

| Eingabe | Aktion |
| --- | --- |
| Mausrad, Trackpad-Pinch | Zoomen |
| Rechte Maustaste ziehen, Trackpad mit zwei Fingern wischen, `Leertaste` + ziehen | Ansicht verschieben |
| `Shift` + Mausrad | Seitwärts verschieben |
| Linke Maustaste auf freier Fläche ziehen | Bereich auswählen |
| `Cmd/Ctrl+K` | Command-Palette / Entität suchen |
| `/` | Suche fokussieren |
| `N` | Neue Entität |
| `F` | Graph einpassen bzw. Auswahl zentrieren |
| `G` | Auswahl gruppieren |
| `1`–`4` | Ansicht wechseln |
| `E` / `T` | Explorer / Zeitfenster |
| `Cmd/Ctrl+Z`, `Shift+Cmd/Ctrl+Z` | Undo / Redo |
| `Entf` | Auswahl löschen |
| `?` | Hilfe und Tastenkürzel |

## Ereignisse, Ebenen und Gruppen

### Ereignisse mit mehreren Beteiligten

„Angreifer verwendet IP a.a.a.a und Service Principal B und listet Key Vault C auf“ ist **ein** Ereignis, keine drei Kanten. Eine **Activity** hat eine Operation (`listed secrets`), optional eine MITRE-ATT&CK-Technik, einen Zeitraum und Beteiligte mit Rollen:

| Rolle | Bedeutung |
| --- | --- |
| `actor` | wer handelt (Angreifer, Benutzer) |
| `identity` | verwendete Identität (Konto, Service Principal) |
| `source` | Herkunft (IP, Gerät) |
| `tool` | Werkzeug oder Prozess |
| `via` | Zwischensystem |
| `target` | worauf gehandelt wurde |
| `other` | sonstige Beteiligte |

Belege hängen am ganzen Ereignis; Review, Status, Timeline und Zeitfenster funktionieren wie bei Beziehungen. Im Graphen erscheint die Activity als Raute mit beschrifteten Speichen, unter **Layers** auch als einfache Kante. Die Zuordnung „diese IP gehört zum Angreifer“ ist eine eigene Beziehung mit eigenem Beleg.

### Ebenen und Perspektiven

Jeder Typ gehört zu einer Ebene: **Identity & access**, **Network**, **Endpoint**, **Workload** (Kubernetes, Container), **Cloud control plane** (Subscriptions, Key Vaults), **Data & storage** (Buckets, Blobs, Datenbanken), **Code & CI**, **Other**. Die Ebene wird aus dem Typ abgeleitet und lässt sich pro Typ oder pro Entität überschreiben.

**Layers** blendet Ebenen ein und aus (Verbindungen in ausgeblendete Ebenen zählt ein Hinweis am Knoten), zeichnet Bahnen und ordnet **nach Ebenen** an. Kombinationen lassen sich als **Perspektive** speichern, werden mit dem Board synchronisiert und sind per `?lens=<id>` verlinkbar.

**Inhalt einklappen:** Hat ein Gerät oder Cluster `contains`-, `runs`- oder `hosts`-Beziehungen, klappt der Kontextmenüeintrag **Collapse contents** alles Enthaltene in den Knoten („12 inside“).

### Gruppen

Eine Gruppe bündelt viele Entitäten zu einem Knoten – etwa 699 von 700 Repositories, bei denen dasselbe passiert ist. Mitglieder sind explizit (Mehrfachauswahl, `G`) oder per Regel (Typ und/oder Textmuster); neue passende Entitäten kommen automatisch hinzu. **Take out** hält einzelne Entitäten außerhalb der Gruppe sichtbar – typischerweise genau die, bei denen etwas anderes passiert ist. Kanten zur Gruppe werden gebündelt und gezählt (`cloned ×699`). **Groups** in der Canvas-Leiste schlägt Gruppen aus Entitäten gleichen Typs mit identischen Verbindungen vor und nennt die Ausreißer. Beim Aufklappen zoomt die Ansicht auf die Mitglieder. Gruppen und Perspektiven ändern nur die Ansicht, nie Aussagen oder Belege.

## Belege und Prüfung

- Eine **Quelle** beschreibt die Herkunft: Titel, Referenz (Log-Export, `pfad@commit`, Portal-Link), Originalzeilen als Auszug und – bei Abfragen – die KQL. `primary` sind Originallogs, Telemetrie und Dateien; `secondary` ist Kontext und nie Beweis. **FactGraph führt keine Abfragen aus**; Abfrage und gelieferte Ergebnisse werden gemeinsam als Herkunft gespeichert.
- Ein **Beleg** enthält Beobachtung, Fundstelle (Event-ID, CorrelationId, Ergebniszeile, Datei:Zeile), Zeitraum der Aktivität, Richtung (`supports`/`refutes`) und Konfidenz.
- Neue Belege sind **unbestätigt**. Bestätigen setzt eine Primärquelle mit Referenz und Originalauszug, eine konkrete Fundstelle, eine Beobachtung und eine Prüfnotiz voraus und ist an die aktuelle Revision gebunden. Ändern sich Beleg, Aussage oder Quelle, wird die Bestätigung zurückgesetzt.
- Der Status einer Beziehung ergibt sich nur aus aktiven, bestätigten Belegen: **Supported**, **Refuted**, **Disputed** (beides) oder **Unknown**. Zurückgezogene Belege bleiben in der Historie.
- Beziehungen mit bestätigten Belegen lassen sich nicht per Ziehen umhängen („Ends locked“); eine Umbenennung fragt vorher nach.
- **Evidence review** listet offene Belege; der Evidence-Reader zeigt Beobachtung, Quelle, Originalergebnisse als durchsuchbare Tabelle, Abfrage und Historie und erlaubt Bearbeiten, Bestätigen, Zurückziehen und Wiederherstellen.
- Die **Timeline** zeigt aktive Belege chronologisch in UTC. `valid_from`/`valid_to` beschreiben den Zeitraum der Aktivität, nicht den Zeitpunkt der Erfassung; unbekannte Zeiten stehen am Ende.

## KI-Agenten anbinden (MCP und REST)

Beim Öffnen eines Boards erzeugt der Browser ein zufälliges **Sitzungs-Token**. REST und MCP erwarten es im Header `X-FactGraph-Token` (MCP akzeptiert zusätzlich den Parameter `session_token`). Das Token koppelt den Aufruf an diesen Browser-Tab; es ist kein Benutzerkonto. Ein neuer Tab oder Browser erzeugt ein neues Token.

**Connect an agent** (API/MCP-Menü oder Command-Palette) liefert kopierfertige Snippets:

- `.vscode/mcp.json` für VS Code/GitHub Copilot – standardmäßig fragt VS Code beim Start nach dem Token, sodass die Datei ins Repository darf; optional mit eingebettetem Token,
- den Befehl für Claude Code (`claude mcp add --transport http factgraph … --header "X-FactGraph-Token: …"`),
- Endpunkt und Header für andere Clients,
- eine erste Nachricht mit der Board-ID für den Agenten.

Im Repository liegt außerdem [.vscode/mcp.json](.vscode/mcp.json); in VS Code **MCP: List Servers** → `factgraph` → Start. Von einem anderen Gerät `127.0.0.1` durch die IP des Servers ersetzen.

### MCP-Tools

Standardmäßig zeigt der Server ein **kompaktes Agent-Profil mit 24 Tools** (rund 9.000 Tokens Tool-Beschreibungen). Weniger Tools bedeuten weniger Kontextverbrauch und bessere Tool-Wahl.

| Aufgabe | MCP-Tool | REST (relativ zu `/api/boards/{id}`) |
| --- | --- | --- |
| Graph lesen, Entitäten suchen | `get_graph`, `find_entities` | `GET /graph`, `GET /entities?q=` |
| Entitäten | `create_entity`, `update_entity`, `merge_entities`, `delete_entity`, `add_identifier` | `/entities…` |
| Beziehungen | `create_relation`, `update_relation`, `delete_relation` | `/relations…` |
| Ereignisse | `create_activity`, `update_activity` | `/activities…` |
| Quellen und Belege | `create_source`, `update_source`, `add_evidence`, `update_evidence`, `review_evidence`, `retract_evidence` | `/sources…`, `/relations/{id}/evidence…` |
| Importe | `import_rows`, `import_activities` | `/imports/activity`, `/imports/kql`, `/imports/activities` |
| Übersicht und Export | `create_group`, `update_group`, `export_image` | `/groups…`, `/export` |
| Rückgängig | `undo` | `/undo` |

Die REST-API bleibt vollständig (Typen, Perspektiven, Einzelabfragen, Historie, Redo, rohe Aktionen …). Mit `FACTGRAPH_MCP_TOOLS=full` zeigt der MCP-Server stattdessen für jede REST-Operation ein Tool `rest_<operation>` mit identischen Parametern und Validierung:

```bash
docker run -e FACTGRAPH_MCP_TOOLS=full -p 8080:8080 k3mpaxl/factgraph:latest
```

Beim Verbinden überträgt der Server verbindliche **Arbeitsregeln** an den Agenten (auch per `GET /api/guidelines`): erst lesen und vorhandene IDs verwenden; konkrete Entitäten; spezifische Verben; bei drei oder mehr Beteiligten ein Ereignis; jede wichtige Aussage mit Primärbeleg; Unsicherheit und Widerspruch erhalten; Importe zuerst als `dry_run`. Agents dürfen Belege bestätigen, aber nur nach Prüfung des Originals und mit Prüfnotiz.

### REST-Beispiele

```bash
TOKEN=...   # aus "Connect an agent" oder "Copy session token"
BOARD=...   # Board-UUID

curl -X POST "http://127.0.0.1:8080/api/boards/$BOARD/entities" \
  -H "X-FactGraph-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"203.0.113.7","kind":"IP"}'

curl -X POST "http://127.0.0.1:8080/api/boards/$BOARD/activities" \
  -H "X-FactGraph-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"operation":"listed secrets","participants":[
        {"entity_id":"ACTOR_ID","role":"actor"},{"entity_id":"IP_ID","role":"source"},
        {"entity_id":"SP_ID","role":"identity"},{"entity_id":"KV_ID","role":"target"}],
       "valid_from":"2026-09-28T10:42:07Z","source_id":"SOURCE_ID",
       "observation":"SecretList from 203.0.113.7 as sp-deploy-prod","locator":"CorrelationId=7f3a"}'
```

Python mit FastMCP:

```python
from fastmcp import Client

async with Client("http://127.0.0.1:8080/mcp/") as client:
    result = await client.call_tool("create_entity", {
        "board_id": "BOARD_UUID", "session_token": "TOKEN",
        "body": {"name": "Azure-Credential", "kind": "Credential"},
    })
    print(result.data)
```

PATCH-artige Aufrufe ändern nur übergebene Felder; ein explizites `null` leert ein Feld. Quellen und Belege akzeptieren `expected_revision`; bei gleichzeitiger Änderung antwortet die API mit `409`. Für große Mengen gibt es `POST /actions` (bis 50.000 Aktionen, eigene Aktions-IDs machen Wiederholungen idempotent) und die Import-Endpunkte. Es gibt bewusst keinen Endpunkt zum Auflisten aller Boards.

## Logs und KQL-Ergebnisse importieren

**Import logs / KQL** (Board-Menü) übernimmt CSV, JSON-Arrays oder JSONL bis 20 MB und 50.000 Zeilen, zuerst als Vorschau:

- **Relationships · 2 columns:** eine Quell- und eine Zielspalte (z. B. `IPAddress → accessed → FilePath`), gängige Spaltennamen werden erkannt.
- **Activities · several roles:** mehrere Spalten mit Rollen, z. B. `CallerIPAddress → source → IP`, `AppId → identity → Service Principal`, `ResourceId → target → Key Vault`, die Operation fest oder aus einer Spalte (`OperationName`).

Jede Zeile wird ein eigener, unbestätigter Beleg mit ihrem Zeitstempel (`TimeGenerated`, `timestamp`, `StartTime`/`EndTime` …). Gleiche Operation und gleiche Beteiligte ergeben ein gemeinsames Ereignis. Bestehende Entitäten werden wiederverwendet; ein erneuter Import derselben Zeilen verdoppelt nichts. Für Skripte: `POST /imports/file` (Multipart), `/imports/activity`, `/imports/kql` und `/imports/activities`, jeweils mit `dry_run`.

```json
{
  "title": "Key Vault AuditEvent 28.09.",
  "query": "AzureDiagnostics | where OperationName startswith \"Secret\"",
  "rows": [{"CallerIPAddress": "203.0.113.7", "AppId": "sp-deploy-prod", "ResourceId": "kv-prod-secrets",
            "OperationName": "SecretList", "TimeGenerated": "2026-09-28T10:42:07Z"}],
  "roles": [{"field": "CallerIPAddress", "role": "source", "kind": "IP"},
            {"field": "AppId", "role": "identity", "kind": "Service Principal"},
            {"field": "ResourceId", "role": "target", "kind": "Key Vault"}],
  "operation_field": "OperationName",
  "dry_run": true
}
```

## Export als PNG oder SVG

**Export image** (Bild-Symbol in der Canvas-Leiste, Board-Menü oder Command-Palette) exportiert den Graphen so, wie er gerade zu sehen ist – mit Filtern, Ebenen, Gruppen und Ereignissen:

- **SVG** als eigenständige Vektordatei; Texte bleiben in Illustrator, Inkscape, Word oder PowerPoint editierbar.
- **PNG** in 1×, 2× oder 3×; sehr große Graphen werden automatisch auf die Größengrenzen des Browsers reduziert.
- Bereich: ganzer Graph, sichtbarer Ausschnitt oder Auswahl; helles oder dunkles Theme, transparenter Hintergrund, Titel mit Filtern und Datum, Status-Legende. **Copy** legt das Bild in die Zwischenablage.
- Agents nutzen `export_image` bzw. `POST /export`; die Antwort enthält `content` als SVG-Text oder Base64-PNG:

```bash
curl -s -X POST "http://127.0.0.1:8080/api/boards/$BOARD/export" \
  -H "X-FactGraph-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"format":"png","theme":"light","scale":2}' | jq -r .content | base64 -d > graph.png
```

## Synchronisation, Konflikte und Grenzen

- Jeder Browser sortiert alle Aktionen gleich (logische Uhr, Akteur, ID). Deshalb ergibt jede Ankunftsreihenfolge denselben Graphen; gleichzeitige Änderungen desselben Feldes entscheidet diese Reihenfolge überall gleich.
- Beim Beitreten und Wiederverbinden tauschen Browser ihre Historien aus. Offline vorgenommene Änderungen bleiben lokal und werden nachgeliefert.
- Wird eine Entität zusammengeführt, während ein anderer Browser noch mit der alten ID arbeitet, landen dessen neue Beziehungen, Ereignis-Rollen, Kennungen und Gruppenänderungen beim Ziel der Zusammenführung, statt verloren zu gehen.
- Gruppenmitglieder werden inkrementell geändert, damit gleichzeitige Änderungen zweier Analysten beide erhalten bleiben.
- **Undo** (`Cmd/Ctrl+Z`) nimmt die letzte eigene Aktionsgruppe zurück (ein Import zählt als eine Gruppe) und verweigert das, wenn inzwischen jemand anderes dieselben Datensätze geändert hat. Die **Activity**-Ansicht zeigt alle Aktionen mit Kanal (UI, REST, MCP), Autor und Zeit.
- Ist kein Browser mit dem Board geöffnet, kann ein neues Gerät es nicht allein aus der UUID wiederherstellen – dafür einen JSON-Export importieren. Ohne Export gehen Boards beim Löschen der Browserdaten verloren.
- Das Sitzungs-Token belegt nicht, dass ein Mensch prüft. Eine technisch erzwungene menschliche Freigabe bräuchte getrennte Berechtigungen.

## Entwicklung und Tests

```bash
.venv/bin/python -m unittest discover -s tests -v   # Backend, REST/MCP-Verträge, Relay
cd web
npm ci
npm test                                           # Projektion, Review, Konvergenz, Export, Layout, Wheel
npx playwright install chromium
npm run test:e2e                                   # Browser-Workflows gegen einen echten Server
```

Die Browser-Tests laufen mit temporären Boards auf Port 18088 und einem echten MCP-Client. Sie prüfen unter anderem Analyst- und Agent-Review, Offline-Sync mit gleichzeitigem Zusammenführen in zwei Browsern, Ereignisse, Gruppen, Ebenen, Export, Maus- und Trackpad-Steuerung, Mobil-Layout, Importe mit Vorschau und Deduplizierung sowie 10.000 importierte Belege.

## Veröffentlichung (GitHub und Docker Hub)

- **CI** führt bei jedem Push alle Tests aus und baut das Docker-Image.
- **Publish Docker image** baut bei einem Versionstag (`v*.*.*`) oder per **Run workflow** das Image für `linux/amd64` und `linux/arm64` und veröffentlicht es als `latest` und mit Versionsnummer. Voraussetzung sind die Repository-Secrets `DOCKERHUB_USERNAME` und `DOCKERHUB_TOKEN` (Docker-Hub-Access-Token mit Schreibrecht).

```bash
git tag v0.4.6
git push origin v0.4.6
```

Ein manueller Multi-Arch-Build ist mit `./deploy/publish-multiarch.sh` möglich (`FACTGRAPH_IMAGE` und `FACTGRAPH_VERSION` überschreiben Namespace und Version).
