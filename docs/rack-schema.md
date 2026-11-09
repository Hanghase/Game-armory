# Rack-Schema: Spiele und Dienste

Entwurf vom 2026-11-06. Kein Code, zum Drüberlesen. Grundlage: der Code von
v1.3.2, nachgemessen — jede Zahl und jeder Feldname ist belegt.

---

## 1. Der Befund, der alles vereinfacht

Geprüft wurde, was beim Umbau „Spiel → Dienst“ neu erfunden werden müsste.
Das Ergebnis: **fast nichts.** Die Instanz-Ebene kennt Container schon.

```json
// swords/sword.schema.json, control.type
"enum": ["systemd", "screen", "tmux", "docker", "process"]
```

`docker` steht dort **seit v1.0.0** — und im Code liest **niemand** dieses Feld:

```
grep -rn "control\.type" app/*.js   ->  0 Treffer
```

Das heißt: die Steuerung geht heute **fest** über systemd
(`app/control.js:32` — `sudo -n armory-service-ctl <action> <service>`), egal
was in `control.type` steht. Der Umbau ist damit kein Neubau, sondern:
**einen vorhandenen Enum-Wert endlich bedienen.**

Das ist deutlich billiger als ein zweites Instanzmodell danebenzustellen.

---

## 2. Die Ist-Architektur in drei Ebenen

```
RACK        Vorlage: "wie installiert man diese Art Ding"
            racks/*.rack.json  +  racks/rack.schema.json
            austauschbar, vom Betreiber editierbar

SWORD       Instanz: "dieser eine laufende Server"
            swords/*.sword.json  +  swords/sword.schema.json
            wird beim Install angelegt, enthält Zustand

CONTROL     Prozesssteuerung: systemctl / docker / screen / tmux
            heute fest systemd, Enum kennt mehr
```

**Wichtig für den Umbau:** der Rack beschreibt nur, *wie* man installiert. Was
danach passiert, steht im Sword. Ein Rack darf keine Laufzeit-Zustände
enthalten — sonst steht der Zustand an zwei Stellen.

---

## 3. Was ein Rack-Feld heute wirklich tut

Gezählt wurde, welche Rack-Felder im Betrieb überhaupt gelesen werden
(`installRoutes.js` + `installer.js`):

| Feld | wo | wofür |
|---|---|---|
| `id`, `name`, `game` | überall | Anzeige, Ablage |
| `installMethod` | `installRoutes.js:997` | wählt den Install-Weg |
| `defaultRoot` | `installer.js:1493` | Zielverzeichnis der Instanz |
| `ports` | `installer.js:1537` | in den Sword übernommen |
| `eula` | Install-Ablauf | EULA-Schritt ja/nein |
| `singleton` | `installRoutes.js:1014` | nur eine Instanz erlaubt |
| `configTemplate` | Install-Ablauf | Vorlage für die Konfig |
| `source` | Install-Ablauf | woher das Archiv kommt |

Der Rest (`description`, `icon`, `tier`, `licenseRequired`, `javaRequired`,
`packMarkers`, `readyMarkers`, `startArgs`, `saveDir`, `logFile`,
`configFile`, `startScript`) ist **Metadaten** — Anzeige, Marker, Hinweise.

Das ist eine saubere Trennung: **acht Felder mit Verhalten, sechzehn mit
Bedeutung.** Der Umbau sollte diese Grenze sichtbar machen.

---

## 4. Der eine Bruch, der geändert werden sollte

Heute gilt: `source.type` **muss** dem Wert von `installMethod` entsprechen.

```js
// installRoutes.js:977
const INSTALL_TYPE_FOR_METHOD = {
  curseforge: 'curseforge',
  steamcmd: 'steam',
  zip: 'zip',
  upload: 'upload',
  github: 'github',
};
// :997  wenn source.type !== expectedType -> 400
```

Das ist genau die Stelle, an der 1.3.2 drei Fehler hatte. Und es ist
konzeptionell falsch: **der Betreiber soll nicht den Ableitungswert
mitschreiben.** Der Server kann ihn selbst bilden.

```js
// Vorschlag
const SOURCE_TYPE_FOR_METHOD = { ... };   // wie heute
const type = SOURCE_TYPE_FOR_METHOD[rack.installMethod];
// source.type wird beim Laden/Anlegen GESETZT, nicht geprüft
```

Damit verschwindet eine ganze Fehlerklasse — und der Editor braucht kein
`source.type`-Dropdown mehr. Das ist der größte Einzelgewinn des Umbaus.

**Achtung, offene Frage:** `source.type` hat heute sieben erlaubte Werte
(`curseforge modrinth ftb steam github local zip upload`), aber nur fünf
Methoden. Was passiert mit `modrinth`, `ftb`, `local`? Sind das geplante
Methoden, die nie gebaut wurden? Oder sind sie für Dienste gedacht? **Das muss
geklärt werden, bevor Zod den Vertrag festschreibt.**

---

## 5. Dienst-Racks: was anders ist

Ein Spiel-Rack beschreibt „lade ein Archiv, entpacke es, starte ein Skript".
Ein Dienst-Rack beschreibt „ziehe ein Image, starte einen Container mit
diesen Bedingungen". Die Unterschiede konkret:

| Spiel | Dienst |
|---|---|
| `loader` (fabric/paper/…) | entfällt |
| `javaRequired` | entfällt |
| `packMarkers` / `readyMarkers` | entfällt (kein Modpack) |
| `installMethod` (Archiv) | `image` + `tag` |
| `source.appId` (Steam) | `image` (Registry-Pfad) |
| `configTemplate` | `composeTemplate` / `envTemplate` |
| `defaultRoot` | `dataRoot` (Volume, nicht Programm) |
| — | `healthcheck` (wann ist der Dienst „bereit"?) |
| — | `dependsOn` (Datenbank vor App, siehe §6) |

Und auf der **Sword**-Ebene: `control.type` = `docker`, `control.service` =
Container-Name, `control.workingDir` = Verzeichnis mit der Compose-Datei.

`startScript` ist bei Diensten **null** — das Schema verlangt es heute als
String. Das muss `string | null` werden.

---

## 6. Ein Compose-Stack als Prüfstein

Das ist der Test, ob der Entwurf trägt. Der Bestand einer Beispielinstallation
auf `example.org`:

```
app    anwendung:latest   -> 127.0.0.1:8080
db     datenbank:11       -> intern
cache  cache:8            -> intern
compose:  /srv/beispiel/docker-compose.yml
```

Das sind **drei Container, die zusammengehören**. Ein Dienst-Rack muss also
mehrere Container beschreiben können, nicht einen. Das ist die härteste
Anforderung an den Entwurf — und der Grund, warum das hier geklärt werden
soll und nicht später.

**Zwei mögliche Modelle:**

```js
// A) Ein Rack beschreibt eine Gruppe (Compose-Datei)
{ kind: 'service', compose: { file: 'beispiel.yml', services: ['app','db','cache'] } }

// B) Drei Racks, die über dependsOn verbunden sind
{ kind: 'service', image: 'anwendung:latest', dependsOn: ['db'] }
```

**A** bildet die Realität ab (der Stack ist eine Einheit, ein `up`/`down`).
**B** ist feinkörniger, aber jeder Start müßte die Reihenfolge selbst
beherrschen — und Compose macht das schon.

Die Neigung geht zu **A**, weil Compose die Ordnung, die Healthchecks und das
Netzwerk bereits löst. B hieße, Compose nachzubauen.

**Aber:** die Armory hat einen `armory-service-ctl`-Helfer, der nur
`systemctl` kann und nur Service-Namen durchläßt, die als Sword registriert
sind (`tools/armory-service-ctl:25`). Für Docker gibt es seit 2026-11-07 den
zweiten Helfer `armory-docker-ctl` mit derselben Enge — nicht `docker` frei
durchreichen.

**Stand 2026-11-07 (v1.3.56): Start/Stop/Restart sind freigegeben.** Der
Helfer kennt `status | ps | logs | start | stop | restart`. Grenzen, die
nicht gelockert werden dürfen:

- EINE feste Compose-Datei (`/srv/beispiel/docker-compose.yml`), Pfad steht
  im Skript und kommt nie als Argument.
- Dienste nur aus der Whitelist `app db cache`, exakter
  Wortvergleich. Ein `case`-Teilstringvergleich ließ `"app db"` als
  EIN Argument durch — docker sah daraus zwei Dienste (im Betrieb erwischt
  2026-11-07, seitdem `pruefe_dienst()`).
- Genau eine Aktion und ein Dienst pro Aufruf; überzählige Argumente → Exit 7.
- Kein `down`, `rm`, `exec`, `build`, `run`. `down` entfernt den Stack samt
  Netzwerk, `exec` wäre root im Container.
- `--timeout` nur bei `stop`/`restart`: `docker compose start` kennt das Flag
  nicht und bricht mit "unknown flag" ab.

Das Panel startet/stoppt bei einem Stack mit mehreren Diensten jeden
**einzeln** und meldet je Dienst ein Ergebnis; ein Fehler bricht die übrigen
nicht ab.

---

## 7. Was NICHT geändert wird

- **Ein Server = ein Kunde = eine Instanz.** Kein Multi-Tenant, keine
  Container-Isolation als Sicherheitsgrenze. Das bleibt (Karte #29).
- **Racks bleiben JSON-Dateien.** Keine Datenbank. Sie sind versionierbar,
  kopierbar, im Zweifel per Hand reparierbar.
- **Die drei Tests, die Listen zusammenhalten, bleiben.** Sie sind der Grund,
  warum 1.3.2 nicht wieder still kaputtgehen kann.

---

## 8. Entschieden (2026-11-06)

**1. `local` bleibt.** Kein Altlast-Wert: die Idee ist, künftig Daten per FTP
in einzelne Swords hochladen zu können. Gehört als Absicht ins Schema,
damit es niemand als "unbenutzt" löscht.

**2. `modrinth` und `ftb` bleiben.** Beides sind Minecraft-Artefakte: eigene
gemodete Packs sollen sich auch von Modrinth oder Feed the Beast ziehen
lassen. Das war geplant und ist nicht fertig gebaut. Damit hat `source.type`
sieben Werte, von denen fünf eine fertige `installMethod` haben und zwei
(`modrinth`, `ftb`) auf Fertigstellung warten.

**3. Ein Rack pro Dienst-Stack.** Ein Dienst-Rack beschreibt App, Datenbank
und Cache zusammen. Begründung: Compose löst Reihenfolge, Netzwerk und
Healthchecks bereits - ein Modell mit Einzel-Racks müsste das nachbauen.

**4. Compose-Vorlage im Rack, erzeugte Datei in der Instanz.** Dasselbe
Muster, das ein bestehender Spiel-Rack heute schon nutzt (`installer.js:1126`:
`templates/teamspeak6.tsserver.yaml` -> `renderConfigTemplate` ->
`/opt/teamspeak6/tsserver.yaml`). Vorteil: der Betreiber kann seine erzeugte
Datei anpassen, ohne das Rack zu ändern, und ein Rack-Update überschreibt
diese Anpassung nicht.

**5. Update und Rebuild getrennt anbieten.**

```
Update   (Image neu)  Backup -> pull -> up -d -> Healthcheck abwarten
Rebuild  (CVE)        Backup -> build --pull --no-cache -> up -d
```

Der Rebuild-Knopf erscheint **nur**, wenn die Compose-Vorlage einen
`build:`-Abschnitt enthält. Bei einem reinen `image:` gibt es nichts zu
bauen; ein Knopf dafür wäre entweder wirkungslos oder zöge ein fremdes
Image.

**6. Bei Diensten ist das Backup Pflicht, nicht Komfort.** Die Anwendung
spielt ihre Datenbank-Migration beim Start selbst ein - nur aufwärts, nie
zurück. Ein fehlgeschlagenes Update lässt sich ohne Restore nicht rückgängig
machen. Bei einem Spielpack ist ein Backup bequem, hier ist es die
Rückversicherung.

## 9. Reihenfolge

```
1. Entwürfe §8 sind entschieden            (2026-11-06)
2. Diesen Entwurf danach korrigieren
3. Zod-Vertrag daraus ableiten            (mit Tests zuerst)
4. armory-service-ctl um docker erweitern (eigener Helfer, gleiche Enge)
5. Bestehenden Compose-Stack adoptieren    (#28)
```

Schritt 3 ist der Punkt, an dem TypeScript wieder ins Spiel kommt: aus dem
Zod-Vertrag fällt der Typ heraus, ohne ihn doppelt zu schreiben. Aber erst
nach 1–4.

---

## 10. Nachtrag: ein vierter Widerspruch, gefunden beim Prüfen

In §5 sollte ursprünglich „`startScript` muss `string | null` werden“ stehen.
Beim Nachsehen kam etwas anderes heraus — und es ist wichtiger als die Notiz.

```
swords/sword.schema.json   control.startScript  -> type "string", minLength 1,
                                                    steht in control.required
swords/teamspeak6.sword.json  startScript: null
app/installer.js:1159         startScript: null   (Kommentar: „kein Shell-
                                                    Skript: binäres Release")
app/swords.js validateSword   prüft startScript GAR NICHT
```

Drei Aussagen, drei verschiedene Wahrheiten:

1. Das **Schema** sagt: Pflichtfeld, nicht-leerer String.
2. Die **Wirklichkeit** (ein Binär-Release wie TeamSpeak 6) sagt: `null` ist
   der Normalfall für Racks ohne Startskript.
3. Der **Validator** sagt: interessiert mich nicht.

Das ist die gefährlichste Sorte Drift: ein Schema, das strenger ist als der
Code und deshalb nicht benutzt wird. Wer es als Vertrag nimmt, baut etwas
anderes als das Panel. Und es ist eine **dritte** Fundstelle neben den zwei
aus 1.3.2 — der Befund „drei Darstellungen derselben Wahrheit" (Karte #30)
gilt auch für das Sword-JSON, nicht nur für das Rack.

**Konsequenz für den Entwurf:** bevor irgendetwas in Zod gegossen wird, muss
entschieden werden, ob `swords/sword.schema.json` ein *Vertrag* ist oder nur
*Dokumentation*. Heute ist es Doku, die lügt. Die ehrlichere Variante:

- Entweder das Schema lockern (`["string","null"]`, aus `required` raus) und
  `validateSword` dagegen laufen lassen,
- oder das Schema löschen und `validateSword` als die eine Quelle nehmen.

Beides ist besser als der Ist-Zustand. Empfohlen wird Letzteres: **der Code
ist die Wahrheit, das Schema wird daraus erzeugt.** Das ist derselbe Grundsatz
wie bei Zod in §9 — nur fängt man beim Sword an, weil es dort schon weh tut.

---

## 11. TeamSpeak: der Fall, der einen zweiten Weg braucht

Entscheidung des Betreibers (2026-11-06): **Fremdskripte sind bei TeamSpeak
sehr zickig, dieser Weg ist nicht gangbar.**

Was heute steht - nachgesehen, nicht angenommen:

```
racks/teamspeak6.rack.json   installMethod: github
                             url: github.com/teamspeak/teamspeak6-server
                             assetPattern: teamspeak6-server-linux-amd64.tar.xz
                             configTemplate: teamspeak6.tsserver.yaml
swords/teamspeak6.sword.json installedVersion: 6.0.0-beta13.1
                             control.startScript: null   (binäres Release)
systemctl is-active teamspeak6  ->  active
systemctl is-enabled teamspeak6 ->  enabled
```

**Es läuft.** Also ist die Aussage nicht "TeamSpeak geht nicht", sondern
etwas Genaueres: das *Rack* ist der zickige Teil. Die Kombination aus
`github`-Download, `assetPattern`-Passung auf ein Release-Asset, `tar.xz`-
Entpacken und einer YAML-Vorlage mit Platzhaltern hat viele bewegliche Teile -
und jedes davon bricht, wenn TeamSpeak sein Release-Format ändert.

**Konsequenz für den Umbau:** Es braucht einen Weg für Racks, die man
**einmal von Hand installiert** und danach nur noch *verwaltet*. Das Panel
muss nicht jede Installation selbst können, um einen Dienst zu steuern.

Konkret heisst das: eine dritte Art neben `game` und `service` -

```
kind: 'existing'   ("bereits installiert, nur noch steuern")
```

Ein `existing`-Rack beschreibt nur, wie man den Dienst **bedient** (Compose-
Datei oder Unit-Name, Arbeitsverzeichnis, Log-Quelle, was ein "gesund" ist),
und kennt keinen Installer. Das ist genau die Form, die Karte #28 für
einen bestehenden Compose-Stack braucht - und die TeamSpeak rettet, ohne dass
jemand das Release-Format nachbauen muss.

**Warum das den Umbau vereinfacht:** Der schwierige Teil (fremde Downloads,
fremde Archive, fremde Formate) fällt weg. Was bleibt, ist das, was das Panel
ohnehin gut kann: starten, stoppen, Logs zeigen, Updates anstoßen, Zustand
melden.

**Offene Frage:** Soll `existing` auch für Spiele gelten (also ein ATM11, das
von Hand aufgesetzt wurde und nur noch im Panel erscheinen soll), oder ist es
auf Dienste beschränkt?

---

---

## 12. `existing`: Bestehendes übernehmen (ohne Auto-Update)

Entschieden 2026-11-06. Ein `existing`-Rack beschreibt **keinen Installer**,
sondern nur, wie ein bereits laufender Dienst bedient wird.

### Vier Stufen, klar getrennt

```
Stufe 1  Verwalten      start/stop/restart, Logs, Zustand, Port
                        -> sofort, jede Instanz
Stufe 2  Version sehen  "läuft", Version angegeben/erkannt
                        -> Prüfung + Proxy-Version
Stufe 3  Update fahren  Klick, Backup, neu starten
                        -> braucht eine Quelle
Stufe 4  Auto-Update    prüft und entscheidet selbst
                        -> EIGENES FEATURE, Karte #31
```

**`existing` deckt Stufe 1 und 2 ab.** Punkt 3 und 4 sind unabhängig davon -
ursprünglich war beides vermischt worden, das war falsch.

### Was beim Übernehmen geprüft wird

Nichts anlegen, was nicht vorher geprüft wurde - sonst stehen Swords im
Panel, die auf nichts zeigen.

```
Steuerart      systemd-Unit / Compose-Datei existiert
Arbeitsverz.   Verzeichnis existiert, gehört dem Dienst-User
Struktur       die erwarteten Marker sind da
Port           lauscht tatsächlich
Log-Quelle     Datei oder journald erreichbar
```

Alle sechs müssen stimmen, sonst bricht die Übernahme ab.

### Minecraft/ATM: was die Prüfung realistisch trägt

Nachgemessen in `/opt/minecraft/atm11` (2026-11-06):

```
vorhanden:      startserver.sh, user_jvm_args.txt, mods/,
                libraries/net/neoforged/, server.properties, world/
NICHT vorhanden: modrinth.index.json, manifest.json
```

**Es gibt keine Pack-Version in der Installation.** Die `0.12.0-beta` im Sword
stammt vom Betreiber (`installedVersionSource: "manual"`).

Daraus folgt die ehrliche Trennung:

| Was | Prüfbar? | Woher |
|---|---|---|
| Ist es eine echte NeoForge-Instanz? | **ja, hart** | Struktur + Unit + Port |
| Läuft sie? | **ja, hart** | systemd `is-active` |
| NeoForge-Version | **ja, hart** | `libraries/net/neoforged/neoforge/<ver>` |
| Pack-Version | **nein** | nur vom Betreiber |

Bei der Übernahme wird `armory-instance.json` ins Verzeichnis geschrieben -
ab dann kennt das Panel die Pack-Version. Für die Zeit davor ist sie
*angegeben*, nicht erkannt.

**Anzeige sagt die Herkunft mit:** "ATM 11 · Pack 0.12.0-beta (angegeben) ·
NeoForge 26.1.2.124 (erkannt)". Das Feld `installedVersionSource` gibt es
heute schon; es wird nur nirgends angezeigt.

### Was `existing` ausdrücklich NICHT verspricht

- **Kein Auto-Update.** Siehe Karte #31.
- **Kein automatisches Update-Erkennen ohne Quelle.** Ohne CurseForge-`projectId`
  gibt es keine Soll-Version (`versionCheckReason: "keine projectId im Rack"`).
- **Kein Raten.** Wenn der Betreiber vier Angaben macht, prüft das Panel sie -
  es rät nicht, was "eine normale Instanz" ist. Eine Heuristik würde bei
  fremden Setups falsch liegen, und ein falsch übernommener Dienst ist
  schlimmer als keiner.

