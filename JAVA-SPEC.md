# javaWarning-Persistenz + Schemata (Spec 2026-09-24)

## Entscheidungen (verbindlich)
- javaWarning PERSISTIEREN (nicht nur im fluechtigen Install-Ergebnis)
- UI-Badge auf der Sword-Karte, wenn javaWarning gesetzt
- Beide Schema-Dateien schreiben: racks/rack.schema.json + swords/sword.schema.json
- atm10 + atm11 nachtraeglich befuellen (Java-Stand jetzt einmal ermitteln)

## Felder

### Sword-JSON (swords/<id>.sword.json) — NEU
  "javaRequired": 25 | null      <- aus startserver.sh erkannte Anforderung
  "javaInstalled": 25 | null     <- erkannte installierte Hauptversion
  "javaWarning": "Pack verlangt Java 25, installiert ist Java 21" | null

Bestehende Felder bleiben unveraendert:
  $schema, id, rack, name, port, protocol, control{type,service,user,workingDir,startScript},
  logs{type,path}, rcon{host,port,passwordFile}, update{...}, tier

### Rack-Schema (racks/<id>.rack.json) — bestehend
  $schema, id, name, description, icon, game, loader, tier, licenseRequired,
  source{type,projectId}, javaRequired

## API-Schnittstelle (FEST — Frontend ruft genau das)
  GET /api/swords        -> Liste; JEDES Element enthaelt zusaetzlich:
                            javaRequired, javaInstalled, javaWarning (alle koennen null sein)
  GET /api/swords/:id    -> dasselbe Objekt
  (swords.js loadSwords() reicht die Felder aus dem JSON durch; nichts erfinden)

## UI (public/app.html)
- Auf der Sword-Karte: wenn sword.javaWarning truthy -> sichtbarer Warnhinweis.
  Empfehlung: kleines Badge/Zeile im Stil des bestehenden .badge / .warn,
  Text = sword.javaWarning, mit Titel-Attribut. KEIN Modal, keine Interaktion.
- Keine anderen Karten-Elemente veraendern (Start/Stop/⚙ Aktionen-Menue bleiben!).

## Verifikation
- Backend: node --check; loadSwords liefert die 3 Felder; /api/swords enthaelt sie
- Schemata: gueltiges JSON; node-Validierung gegen die vorhandenen JSON-Dateien (nur Struktur-Check, keine Zusatz-Deps)
- Nachrüsten: atm10 + atm11 haben danach javaRequired/javaInstalled/javaWarning gesetzt
