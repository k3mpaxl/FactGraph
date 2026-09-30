# FactGraph: Investigation UI und Agent-Workflows

Stand: 29.09.2026. Plan auf Basis des aktuellen Codes und des geöffneten Boards; noch keine Implementierung oder Testabnahme dieser Änderungen.

## Ziel und Leitentscheidungen

Ein Analyst baut und prüft einen Untersuchungsgraphen direkt auf der Arbeitsfläche. Ein Agent trägt recherchierte Objekte, Beziehungen und nachvollziehbare Primärbelege in dasselbe Board ein. Der Analyst erkennt sofort, was beobachtet, nur vermutet, geprüft oder widersprüchlich ist.

- Englisch bleibt die Hauptsprache; UI-Texte werden über zentrale Übersetzungsschlüssel geführt.
- Browser/IndexedDB bleiben der dauerhafte Speicher, WebSocket der Relay. REST und MCP brauchen weiterhin ein verbundenes Board; dieser Zustand wird verständlich angezeigt.
- Empfehlung: React Flow als 2D-Editor, eigene Entity-Karten und gerichtete Kanten. Die Entscheidung wird zuerst an einem kleinen Prototyp mit Bestandsdaten und einem großen Testgraphen geprüft.
- Der Graph erhält die gesamte verbleibende Fensterfläche. Listen und Inspector sind einklappbar, der Evidence-Reader kann breit oder bildschirmfüllend geöffnet werden.
- Keine globale Board-Auflistung in REST oder MCP. Alle fachlichen Operationen verlangen eine explizite Board-ID.
- Diese Planung verlangt keine Versionsänderung und keinen automatischen Release.

## Festgestellter Ist-Zustand

| Bereich | Befund | Konsequenz |
| --- | --- | --- |
| Arbeitsfläche | Große Überschrift, Board-Leiste und zusätzliche Graph-Überschrift stehen übereinander. | Viel Höhe fehlt für die eigentliche Untersuchung. |
| Graph | `web/src/GraphView.tsx` verwendet Cytoscape; der Connector ist ein positionierter Button, der Klick auf Quelle und Ziel verlangt. | Kein durchgehendes Ziehen mit Vorschaukante. |
| Layout | Raster und COSE-Auto-Layout existieren. | Gezieltes Anordnen, Fixieren und gemeinsam rückgängig machbare Layout-Änderungen ergänzen. |
| Bearbeitung | Entity-Edit, Merge, Farbe, Evidence-Edit und Undo sind bereits vorhanden. | Bestehende Funktionen sichtbarer und direkt erreichbar machen. |
| Evidence | `Assertion` hat stance, confidence, Quelle, Notiz, Zeitraum und Rückzug, aber keinen Prüfstatus. | Bestätigung ist bisher nicht modelliert. |
| Beziehungsstatus | Jede aktive Aussage zählt für `truth_state`, unabhängig von Prüfung und Quellenqualität. | Ein Agenteneintrag kann unmittelbar als unterstützt erscheinen. |
| REST/MCP | Create/Update/Delete für Entities, Relations, Sources und Evidence existieren bereits. | Vollständigkeit umfasst auch Felder, Validierung, Lesen, Imports und Fehlersemantik. |
| PATCH | MCP-Wrapper entfernen Werte mit `None`; REST unterscheidet über `exclude_unset` zwischen fehlend und explizit null. | Beispielsweise Zeitgrenzen oder Quelle können über MCP nicht gleichwertig geleert werden. |
| Tests | Schema-, Import-, Relay- und einzelne MCP-Tests sowie Frontend-Projektions-/Timeline-Tests vorhanden. | Keine vollständige Browser-Abnahme der Analyst-Agent-Workflows; Schema-Prüfung allein reicht nicht. |

## Arbeitsfläche und Gestaltung

```text
Board name / saved / peers       Search       Undo Redo       Integrations ···
Evidence window  [●================●]   Previous Next Play   Include undated
Graph | Timeline | Evidence review (12) | Activity
┌────┬─────────────────────────────────────────────────┬─────────────────┐
│ +  │                                                 │ Inspector       │
│Find│           GRAPH / INVESTIGATION CANVAS          │ on selection    │
│Type│                                                 │ resizable       │
│    │                                                 │ closable        │
│    │  Selection toolbar                 Zoom / Fit   │                 │
└────┴─────────────────────────────────────────────────┴─────────────────┘
```

Die linke Leiste ist standardmäßig schmal. „Add entity“ öffnet eine durchsuchbare Palette mit User, Device, IP, Service Principal, AKS, Storage, File, Credential und eigenen Typen. Entity-Liste und Filter öffnen sich bei Bedarf. API/MCP/Token/Kopierfunktionen stehen in einem kleinen Integrations-Popover.

Visuelle Sprache: ruhige dunkle Fläche, dezentes Punktraster, klare Schrift, abgestufte Oberflächen und sparsame Akzentfarbe. Typen erhalten konsistente Icons und Formen; eine individuelle Node-Farbe markiert den Rahmen. Beziehungs- und Prüfstatus erhalten eigene Text-/Symbolmarkierungen, damit Farbe nicht mehrere Bedeutungen tragen muss. Eine Node zeigt Name, Typ und maximal einen wichtigen Identifier. Weitere Daten erscheinen erst im Inspector oder bei größerem Zoom.

Ziel: Bei 1440 × 900 und geschlossenem Inspector stehen mindestens 75 % der Fensterhöhe für den Graphen bereit. Bei schmalen Fenstern wird der Inspector zum Overlay. Bedienelemente bleiben per Tastatur erreichbar; Drag-Aktionen haben eine Klickalternative.

## Graph-Interaktionen

1. **Entity erstellen:** Typ aus der Palette auf die Fläche ziehen; dort eine Entwurfskarte mit Name öffnen. Enter speichert, Escape verwirft. Doppelklick auf freie Fläche und Tastenkürzel öffnen denselben Ablauf. Drop-Koordinaten müssen bei jedem Zoom/Pan stimmen.
2. **Verbinden:** Sichtbaren Handle einer Node zum Handle einer anderen ziehen. Vorschaukante, Zielhervorhebung und Pfeil zeigen die Richtung. Nach dem Drop erscheint ein kleiner Editor für das Verb direkt an der Kante. Escape erzeugt keine halbfertigen Daten.
3. **Kette fortsetzen:** Handle auf freie Fläche ziehen → Entity-Typ und Name wählen → Verb eingeben → Node und Kante als eine gemeinsam rückgängig machbare Aktion speichern.
4. **Beziehung verstehen:** Klick auf die Kante öffnet Claim und Belege. Gleiche Quell-/Ziel-Nodes mit unterschiedlichen Verben bleiben getrennt; eine bestehende identische Beziehung erhält weitere Evidence. Zyklen sind in Untersuchungen erlaubt.
5. **Bearbeiten:** Doppelklick auf Node-Titel zum Umbenennen; Kontextmenü für Edit, Type, Color, Copy ID, Merge und Delete. Kanten unterstützen Verb-Edit, Umhängen der Endpunkte und Delete. Größere Änderungen zeigen betroffene Belege vor dem Speichern.
6. **Anordnen:** Mehrfachauswahl, Gruppenbewegung, Raster optional, Ausrichtungslinien, horizontal/vertikal ausrichten, gleichmäßig verteilen, Nodes fixieren. Auto-Layout für Auswahl oder gesamten Graphen; fixe Nodes respektieren. Layout-Algorithmus anhand von Zyklen und großen Graphen auswählen, ELK als Kandidat.
7. **Navigation:** Pan, Zoom, Fit selection/all, optionale Minimap, Suche mit Fokus auf Treffer. Agenteneinträge dürfen den Viewport nicht ungefragt verschieben oder ein komplettes Layout auslösen.
8. **Rückgängig:** Cmd/Ctrl+Z und Redo; ein Drag oder Import ist eine logische Aktion. Undo entfernt keine unabhängigen Änderungen anderer Teilnehmer. Browser-Zurück navigiert zwischen Ansichten/Boards; Undo ist separat sichtbar.

Abnahmeszenario: Device → reads → Repository file → exposes → Credential → grants access to → Blob storage lässt sich ohne ständig wechselnde große Dialoge aufbauen. Jede Relation kann anschließend einen eigenen Beleg erhalten.

## Evidence: konkrete Aussage mit überprüfbarem Beleg

Evidence bekommt einen eigenen breiten Reader/Editor mit folgenden Bereichen:

- **Claim:** Ein präziser Satz: „IP 10.0.0.5 hat Datei /repo/.env um 10:42 UTC gelesen.“ Entity-Links und Richtung sind sichtbar.
- **Observation:** Was zeigt der konkrete Datensatz? Zitat oder strukturierte Ergebniszeile, hervorgehobene relevante Felder, Zeilen-/Event-ID.
- **Primary source:** Quelle, URI/Repo-Pfad und Commit oder Logsystem, Query, Ergebnisreferenz und Erfassungsinformationen. Eine KQL-Query ohne Ergebnisse beweist kein Ereignis.
- **Evidence period:** Zeitpunkt oder Intervall in UTC; ausdrücklich undatiert ist erlaubt. Erstell- und Prüfzeit stehen nur in der Historie.
- **Assessment:** Supports/Refutes, Confirmed/Unconfirmed, Prüfnotiz und gegebenenfalls Interpretation/Limitation. Confidence ist optional und ersetzt keine Prüfung.
- **History:** Wer hat welche Fassung über UI, REST oder MCP eingebracht, geändert, geprüft oder zurückgezogen? Vollständige IDs und „Copy for agent“ sind direkt verfügbar.

Große KQL-Ergebnisse werden tabellarisch mit Suche, Zeilenreferenzen und bedarfsgesteuertem Rendering gezeigt. Query, Rohbeleg und analytische Interpretation bleiben getrennte Felder. Sekundärquellen dürfen als Kontext gespeichert werden, erfüllen aber die Bestätigungsanforderung nicht. Ein Hash kann die gespeicherte Fassung identifizieren, garantiert jedoch nicht die Authentizität der Quelle.

### Prüfmodell und Übergänge

- Neues Feld `review_status: unconfirmed | confirmed`; bestehende Evidence wird als `unconfirmed` migriert. Keine automatische nachträgliche Bestätigung alter Aussagen.
- Review speichert Evidence-Revision, Quellenrevision, Reviewer-Session, Kanal, Zeitpunkt und Prüfnotiz.
- Analyst kann Unconfirmed → Confirmed und Confirmed → Unconfirmed ändern. Eine Bestätigung verlangt einen verlinkten Primärbeleg mit konkreter Fundstelle/Ergebnis und eine nachvollziehbare Beobachtung. Fehlende Angaben werden feldbezogen erklärt.
- Änderungen an Beobachtung, Quelle, Fundstelle, Zeitraum, Claim oder stance invalidieren eine vorhandene Bestätigung. Quelländerungen invalidieren abhängige Reviews ebenfalls. Reine Darstellung wie Node-Farbe hat keine Auswirkung.
- `supports/refutes` bezeichnet die Richtung des Belegs. `confirmed/unconfirmed` bezeichnet seine Prüfung. `retracted` bleibt ein gesonderter Lebenszykluszustand. Bestätigte Gegenbelege sind ausdrücklich möglich.
- Confirmed + supports ergibt Supported, Confirmed + refutes ergibt Refuted, beide ergeben Disputed. Ohne aktive bestätigte Belege bleibt die Relation Unknown und zeigt die Zahl unbestätigter Belege.
- Rückzug entfernt Evidence aus der aktiven Bewertung, erhält aber die Historie; Restore führt sie erneut als unbestätigt ein. Löschen ist über eine nachvollziehbare Operation rückgängig machbar.
- Im Zeitfenster wird der Beziehungsstatus aus den dort aktiven Belegen ermittelt; der globale Status bleibt separat im Inspector sichtbar. Ein außerhalb des Fensters liegender Gegenbeleg darf den angezeigten Zeitraum nicht verdeckt bestimmen.

Mit dem bisherigen gemeinsamen Session-Token kann der Server Mensch und Agent nicht sicher unterscheiden. Deshalb zunächst transparentes Review mit Kanal/Revision und Agentenregel „Neue Evidence bleibt unconfirmed; keine selbstständige Bestätigung“. Eine technisch erzwungene menschliche Freigabe wäre ein eigener Folgeschritt mit getrennten Berechtigungen oder Freigabe-Mechanismus; ein Herkunftslabel allein garantiert sie nicht.

## Agent und Analyst im selben Board

Der Agent liest zunächst vorhandene Entities/Identifier, verwendet bestehende IDs und legt neue konkrete Untersuchungsobjekte an. Er liefert Claim, Primärquelle, Fundstelle, Zeit und Unsicherheit. Alle neuen Belege erscheinen unbestätigt in „Evidence review“. Der Analyst kann dort den Beleg öffnen, korrigieren, bestätigen, auf unbestätigt setzen oder zurückziehen. Widersprüchliche Ergebnisse bleiben nebeneinander sichtbar.

„Copy for agent“ kopiert Board-ID, ausgewählte Entity-/Relation-/Evidence-IDs und einen strukturierten Kontext. Tokens werden nur über die explizite Token-Funktion kopiert. Änderungen erhalten Actor-Session, Kanal und eine Batch-/Request-ID; Gruppen lassen sich aufklappen. Rohoperationen bleiben zugänglich.

Imports erhalten Mapping-Vorschau, Dry-run mit Validierungsfehlern, Dublettenprüfung, Fortschritt und Zusammenfassung. Wiederholungen mit gleichem Idempotency-Key erzeugen keine weiteren Belege. Bei Teilfehlern wird klar, welche Einträge gespeichert wurden und wie fortgesetzt wird. Große Mengen laufen über REST; MCP kann denselben fachlichen Import mit kleinen Datenmengen oder einer bereits angelegten Importreferenz anstoßen.

## REST- und MCP-Parität

Parität bedeutet identische fachliche Operationen, Felder, Standardwerte, Validierung und Ergebnisobjekte. Transportdetails wie HTTP-Dateiupload oder MCP-Initialisierung bleiben transportspezifisch.

| Fähigkeit | Aktuell | Ziel für beide Schnittstellen |
| --- | --- | --- |
| Graph lesen | REST + MCP | Snapshot mit Revision; gezielte Listen, Einzelobjekte, Suche und Pagination |
| Entities | Create/Patch/Delete/Merge vorhanden | Gleiche IDs, Felder, Positionen, Patch- und Merge-Semantik |
| Relations | Create/Patch/Delete vorhanden | Get/List, Endpunkte ändern, gleiche Dublettenregeln |
| Sources | Create/Patch/Delete vorhanden | Get/List, strukturierte Primärquelle, Revisionen und Referenzschutz |
| Evidence | Create/Patch/Delete vorhanden | Get/List, Review, Retract/Restore, Quellen-/Revisionsbindung |
| Identifiers | UI/Operationen | Typisierte Create/Get/List/Patch/Delete-Operationen |
| Entity-Typen | Freie kind-Werte | Typkatalog mit Icon/Farbe, Create/Patch/Delete und Referenzregeln |
| Board | REST-Status, Browser-Metadaten | Status und Rename für bekannte Board-ID; kein Board-Listing |
| Imports | REST KQL/Activity/File; MCP eingeschränktes KQL | Gleiche Mapping-Felder, Preview/Apply/Status, dokumentierte Größenlimits |
| Aktionen | REST-Batch; UI-Undo | Typisierter Batch, Verlauf, Undo/Redo mit Konfliktprüfung |
| Regeln | MCP instructions + guidelines | Gleiche fachliche Regeln zusätzlich über REST dokumentiert abrufbar |

Implementierung: Fachlogik und Schemas aus `app/main.py` in gemeinsame Module extrahieren. REST und MCP werden dünne Adapter. Der Browser validiert dieselben Operationsverträge vor der dauerhaften Speicherung; generische Batch-Aktionen dürfen Referenz-, Review- und Board-Prüfungen nicht umgehen.

PATCH verwendet ein explizites Änderungsobjekt: fehlendes Feld bedeutet unverändert; `null` leert nur nullable Felder. Gleiche Struktur auch bei MCP, statt alle optionalen Argumente mit `None` wegzufiltern. Vorhandene Toolnamen bleiben zunächst kompatible Aliase. Öffentliche IDs bleiben bei der Migration stabil.

Antworten enthalten `board_id`, Objekt-/Batch-ID, Revision und Commit-/ACK-Ergebnis. Erfolg erst nach IndexedDB-Commit; bei Timeout ist der Status unklar und per Request-ID abfragbar. Einheitliche Fehlercodes für ungültige Daten, fremdes Board, fehlende Referenz, veraltete Revision, Offline und Timeout. MCP transportiert denselben fachlichen Fehler im MCP-konformen Fehlerformat.

Beim Löschen einer Quelle mit Referenzen wird standardmäßig blockiert; ein explizites Ablösen zeigt Auswirkungen und setzt betroffene Reviews zurück. Merge zeigt vorher die Zusammenführung von Identifiern, Beziehungen und Evidence. Gleichzeitige Änderungen werden über erwartete Revisionen erkannt; der Konflikt wird angezeigt und nicht still überschrieben.

## Tests und Abnahmekriterien

Die folgenden Tests sind Implementierungsumfang; sie wurden mit diesem Plan noch nicht ausgeführt.

| Ebene | Verbindliche Szenarien |
| --- | --- |
| Projektion/Migration | Alte Boards und Exporte laden; IDs/Positionen erhalten; Evidence unconfirmed; alle Review-Übergänge; Änderungen invalidieren Reviews; Widerspruch/Rückzug/Restore; Merge und Undo/Redo. |
| REST/MCP-Vertrag | Dieselbe Falltabelle über HTTP und echten FastMCP-Client ausführen: CRUD, Lesen, Review, Merge, Imports, Batch, Fehler, explizites null, leere Patches, unbekannte Felder und Referenzen. Ergebnisgraphen vergleichen. |
| Browser E2E | Palette-Drop, Handle-Drag auf Node/freie Fläche, Cancel, Umhängen, Inline-Rename, Typ/Farbe, Merge, IDs kopieren, Tastatur, Inspector, Review und Rohbeleg-Reader. |
| Zusammenarbeit | Zwei echte Browser-Kontexte plus REST/MCP-Client: identische Graphen/Positionen, gleicher Session-Actor mit unterschiedlichem Kanal, ACK erst nach Speicherung, Refresh, Reconnect, Wiederholung und verspätete Nachrichten. |
| Board-Grenzen | Fehlender/falscher Token, Token des anderen Boards, falsche Objekt-ID, veraltete Revision und geschlossener Browser verändern keine Daten. Board-Auflistung bleibt nicht vorhanden. |
| Agent→Analyst | Agent legt Entity/Relation/Source/Evidence an; Analyst sieht Unconfirmed, prüft Original, bestätigt; Agent ändert relevanten Inhalt; Status wird wieder Unconfirmed; Gegenbeleg erzeugt nachvollziehbaren Konflikt. |
| Timeline | Evidence-Zeit statt Erstellzeit; gleiche Ereignisse deduplizieren; verschiedene Ereignis-IDs erhalten; Intervallgrenzen, Zeitzonen, undatiert, Review-/Rückzugsfilter und Event-Stepping. |
| Import/Last | 10.000 Logzeilen: Vorschau, chunkweise Verarbeitung, Abbruch, Wiederaufnahme, kein doppelter Import; kein UI-Freeze. Zielwerte vorab auf benanntem Testgerät messen. |
| UI/Performance | 100/1.000 Nodes und bis zu 3.000 Kanten; Reaktionszeit, Drag-Framerate und Speicher messen. Ziel: mindestens 30 FPS beim Drag im vereinbarten 1.000-Node-Test; andernfalls Detailreduktion/Subgraph-Ansichten. |
| Release | Frontend-/Backend-Tests, Browser-E2E in CI, Build und Container-Smoke-Test; AMD64 und ARM64 vor Veröffentlichung prüfen. |

Ein Test zählt nur dann als erfolgreich, wenn der gespeicherte Zustand nach Reload und im zweiten Browser stimmt. Ein HTTP-200 oder ein sichtbarer Toast genügt nicht. Pro Test isolierte Boards und feste Fixtures verwenden; keine Untersuchung des Benutzers verändern.

## Umsetzung in abnehmbaren Schritten

1. **Editor-Prototyp:** React Flow mit drei Entity-Typen, Handle-Drag, Drop auf Fläche, Inline-Verb und breitem Evidence-Reader. Bestehendes Eventmodell anbinden. Design, Zoom-Koordinaten, Mehrbenutzerpositionen und Performance prüfen. Ergebnis: ein kompletter Untersuchungsabschnitt ist direkt editierbar.
2. **Fachmodell:** Evidence-/Source-Revisionen und Reviews, Migration, Statusberechnung, Referenzregeln und gemeinsame Operationsverträge. Ergebnis: Bestätigung und Invalidierung sind deterministisch und getestet.
3. **Canvas und Reader produktiv:** Prototyp integrieren, Palette, Kontextmenüs, Typ-/Farbverwaltung, Tastatur, Layout und Undo/Redo vervollständigen. Ergebnis: manuelles Untersuchungsbeispiel vollständig bedienbar.
4. **API/MCP und Agent-Review:** Adapter vereinheitlichen, Paritätsmatrix schließen, Review-Queue und Herkunftsanzeige implementieren, Import-Vorschau/Idempotenz ergänzen. Ergebnis: Agent und Analyst bearbeiten dieselben Daten mit gleichen Regeln.
5. **Workflow-Abnahme:** Ganze Falltabelle mit Browsern, HTTP und MCP ausführen; Migration und Last prüfen. Erst nach bestandenen Gates veröffentlichen. Grobe Größenordnung: 8–13 Entwicklungstage einschließlich Tests; der Prototyp konkretisiert insbesondere Layout-/Synchronisationsaufwand.

## Referenzen und Einstiegspunkte

- React Flow: [Custom Nodes](https://reactflow.dev/learn/customization/custom-nodes), [Handles](https://reactflow.dev/learn/customization/handles), [Interaktionen und Beispiele](https://reactflow.dev/examples). Diese Bausteine unterstützen die vorgeschlagene Editor-Bedienung; Synchronisation, Undo, Layout und Evidence-Regeln bleiben eigene Arbeit.
- Graph: `web/src/GraphView.tsx`; UI/Inspector: `web/src/App.tsx`; Modelle: `web/src/types.ts`; Projektion: `web/src/board.ts`; Speicherung/Relay-Anbindung: `web/src/useBoard.ts`, `web/src/store.ts`; Zeitfilter: `web/src/timeline.ts`.
- REST/MCP: `app/main.py`; Import: `app/ingest.py`; Tests: `tests/`, `web/tests/`; CI: `.github/workflows/ci.yml`.
