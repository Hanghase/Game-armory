# Adoptieren: bestehende Dienste übernehmen (Arbeitsstand 2026-11-10)

Karte 28. Ziel: das Panel findet selbst, was auf dem Server läuft, prüft es hart
und legt daraus einen Sword an — **ohne Installer, ohne Dateien anzufassen.**

Fünf Späher haben vorher den Code gelesen. Was sie fanden, hat den Plan
verändert; die Abweichungen stehen unten mit Grund.

## Was schon da ist (nicht neu bauen)

| Baustein | Ort |
|---|---|
| `validateSword` | `app/swords.js:45` — Pflichtfelder, tier, installedVersion, Dateiname==id |
| `loadSwords()` | `app/swords.js:80` — Cache neu laden; **muss** nach dem Schreiben aufgerufen werden |
| `writeRackFile` / `validateRackDraft` | `app/racks.js:424` / `:389` (beide exportiert) |
| `withSwordLock` / `withRackLock` | `app/swords.js:19` / `app/racks.js:445` |
| `dockerReihenfolge` | `app/control.js` — Start: db/cache zuerst, Stop: App zuerst |
| Route-Muster | `app/installRoutes.js` + `wrapRouter` am Dateiende |
| Rechte | `requirePerm('...')` in `app/auth.js:516` |

## Was fehlt (der eigentliche Bau)

### 1. Es gibt kein `createSword`

Swords entstehen heute **nur** als Nebenprodukt von vier Installern — an drei
Stellen steht ein direktes `writeFile` (`installer.js:782`, `:1147`, `:1486`).
Es gibt kein Lock, kein tmp+rename, keine Einzelfunktion.

**Und alle vier Installer verweigern ein vorhandenes Verzeichnis**
(`installer.js:860`, `:1041`, `:1336`, `:1708`: „Zielordner existiert bereits").

Folge: der Einlese-Weg ist ein **neuer Pfad**, kein Umbau. Er braucht
`withSwordLock` + tmp+rename, weil er sonst als einziger Schreiber ohne
Absicherung dastünde.

### 2. Ein Sword braucht zwingend ein Rack

`validateSword` verlangt `installedVersion` als nicht-leeren String
(`swords.js:64`), und `game` kommt **nicht** aus der Sword-Datei, sondern aus
`getRack(sword.rack)` (`swords.js:135`). Ein adoptierter Dienst ohne passendes
Rack lädt also nicht.

Konsequenz: die Adoption muss entweder ein vorhandenes Rack finden oder eines
mit anlegen — und das sagen, statt es zu tun.

### 3. Der Docker-Helfer ist auf EINEN Stack festgenagelt

```
tools/armory-docker-ctl:29   COMPOSE_FILE="/opt/nextcloud/docker-compose.yml"
tools/armory-docker-ctl:30   ALLOWED_SERVICES="nc-app nc-db nc-redis"
```

`$2` ist heute schon der Dienst. Ein Pfad als Argument kollidiert damit und
bricht `tests/dockerAction.test.mjs:91-110` (der Test verlangt ausdrücklich,
daß der Pfad **nicht** als Argument kommt) und `:71-89` (genau 2 Argumente).

**Entscheidung: kein Pfad, ein NAME.** Der Aufrufer wählt `nextcloud`, nicht
`/opt/nextcloud/...`. Die Auflösung Name → Pfad passiert im Helfer gegen eine
Tabelle, per `realpath -e` geprüft. Damit bleibt die Grenze im Skript, und der
Test „Pfad kommt nie als Argument" bleibt gültig.

Neue Signatur:

```
armory-docker-ctl <stack> <aktion> [dienst] [zeilen]
```

Die alten Tests, die sich ändern **müssen**: `dockerAction.test.mjs:71-89`
(Argumentzahl), `:203-225` (start-Zweig). Sie werden bewußt mitgezogen, nicht
gelöscht.

### 4. Zwei Quellen, eine Wahrheit

Späher 3 hat auf diesem Host nachgemessen:

- `docker ps` mit Labels ist verläßlich für **was läuft**:
  `com.docker.compose.project`, `..service`, `..project.config_files`
- Das Dateisystem ist verläßlich für **wie es konfiguriert ist** — aber nur
  über den Pfad aus dem Label, **nicht** über einen Glob.

**Live-Falle auf felsis.de:** `/root/openclaw/docker-compose.yml` deklariert
zwei Services (`openclaw-gateway`, `openclaw-cli`), und es laufen **null**
Container daraus — das Gateway ist ein Host-Prozeß. Wer pro gefundener YAML
einen Stack annimmt, meldet Geister.

**Zweite Falle:** `/opt/minecraft/{atm10,atm11,atm12,zzbtest-zVDK69}` sehen aus
wie Server. Drei davon sind systemd-Units, `atm12` und `zzbtest` sind Leichen.
Wer nur `docker ps` fragt, übersieht 7d2d, teamspeak6 und game-armory komplett.

Regel daraus: **erst fragen, was läuft, dann die Konfiguration dazu lesen.**
Nie umgekehrt.

### 5. Kein `onclick`, kein Inline-Skript

`app/server.js:63` setzt `scriptSrc: ["'self'"]` — ohne `unsafe-inline`.
Jede neue Maske verdrahtet ihre Events per `addEventListener` in
`public/app.js`. Styles dürfen inline sein (`styleSrc` hat `unsafe-inline`).

## Die fünf Prüfungen (aus docs/rack-schema.md §12)

Nichts anlegen, was nicht vorher geprüft wurde. Alle fünf müssen stimmen.

| Prüfung | Was gemessen wird | Wie |
|---|---|---|
| Steuerart | Compose-Datei existiert und ist lesbar | `realpath -e`, dann `config --services` |
| Arbeitsverzeichnis | existiert, gehört dem Dienst-User | `stat` |
| Struktur | die erwarteten Marker sind da | je Dienst-Typ eine Liste |
| Port | lauscht tatsächlich | `ss -tlnp` gegen den Port aus der Compose/Unit |
| Log-Quelle | Datei oder journald erreichbar | `stat` / `journalctl -n 1` |

## Reihenfolge des Baus

1. **Erkennung** (`app/adopt.js`, neu): `findeStacks()` liest `docker ps`-Labels
   und `systemctl list-units`; `erkenne(quelle)` ordnet einem Stack einen
   Rack-Typ zu — **nur** über eindeutige Merkmale (Projekt + Image-Menge),
   nie über den Container-Namen allein.
2. **Prüfung**: `pruefeAdoption(kandidat)` — die fünf Punkte, jeder mit
   `ok/grund`. Kein Wurf, ein Bericht.
3. **Helfer** (`tools/armory-docker-ctl`): Tabelle Stackname → Verzeichnis,
   neue Signatur, `pruefe_stack()`.
4. **Sword schreiben**: `schreibeAdoptiertenSword()` mit Lock + tmp+rename,
   danach `loadSwords()`.
5. **Route** `POST /api/adopt/vorschau` (nur prüfen) und `POST /api/adopt`
   (anlegen), beide `requirePerm('sword.create')`, am Dateiende `wrapRouter`.
6. **Panel**: Reiter „Übernehmen", Liste der Funde mit Prüfergebnis, Knopf nur
   wenn alle fünf grün.

## Testen

Muster: `node:test`, flaches `test('...')`, **kein** describe/it.
Abhängigkeiten per `deps`-Objekt (`deps.run ?? execFileAsync`).
Bei Ablehnung **immer** `aufrufe.length === 0` prüfen — sonst ist der Test
blind für „Validierung erst nach dem Spawn".

Nicht testbar ohne Systemänderung: ob ein `docker compose start` wirklich
wirkt. Umweg: Aufrufform über injiziertes `run` prüfen, Helfer nur mit bösen
Eingaben (rc prüfen, nicht `!= 0`).

Was ich **nicht** nachahme: `dockerAction.test.mjs:190` liest
`sudo cat /etc/sudoers.d/armory` — hostabhängig. Für neue Tests: Vertrag per
Quelltext-Assertion auf beiden Seiten.

## Abgrenzung

- **Kein Auto-Update** (Karte 31).
- **Keine Pack-Version erfinden.** Bei ATM11 gibt es keine
  `modrinth.index.json`; die `0.12.0-beta` steht im Sword, weil der Betreiber
  sie eingetragen hat. Anzeige sagt die Herkunft: *anggegeben* vs *erkannt*.
- **Kein Raten.** Wenn die Erkennung unsicher ist, sagt sie „unbekannt" und
  legt nichts an.

## Stand

- [ ] Erkennung
- [ ] Prüfung
- [ ] Helfer umbauen
- [ ] Sword schreiben
- [ ] Routen
- [ ] Panel
