# Changelog

Alle nennenswerten Aenderungen an der Game-Armory.
Format orientiert an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [1.0.1] - 2026-10-20

### Behoben
- **Versionsabgleich holte Tags ueber SSH und scheiterte immer.** Der Helfer
  rief `git fetch origin` auf; der Dienst laeuft mit `ProtectHome=yes` und
  sieht `/root/.ssh` nicht, also konnte die Authentifizierung nie gelingen
  ("Could not read from remote repository", rc 128). Von Hand - ausserhalb
  der Unit - funktionierte es, was die Fehlersuche in die Irre fuehrte.
  Jetzt wird die Remote-URL zur Laufzeit nach HTTPS umgeschrieben und mit
  `git ls-remote --tags` gelesen. Das Repo ist oeffentlich, ein Schluessel
  ist nicht noetig.
- Nebeneffekt: `ls-remote` liest nur, damit entfaellt der Schreibzugriff auf
  `.git/FETCH_HEAD`, den der Panel-User nicht hat.

## [1.0.0] - 2026-10-19

### Neuanfang
Dieser Stand ist der erste Commit einer neuen, sauberen Historie. Die
vorherige Historie enthielt Betreiber-Infrastruktur (IP-Adressen in der
Login-Whitelist) und die Betreiber-Mailadresse in den Commit-Metadaten. Beides
ist in einem oeffentlichen Repository nicht korrigierbar - deshalb wurde die
Historie ersetzt statt repariert.

### Geaendert
- **Login-Whitelist ist eine Einstellung.** Die IPs des Betreibers standen fest
  in `app/auth.js`. Jetzt: `login_whitelist` in den Einstellungen, Vorgabe nur
  127.0.0.1 und ::1. Im Panel gibt es dafuer ein Feld beim Brute-Force-Schutz.
- Namen und Hosting-Details aus Kommentaren und Specs entfernt (neutral
  formuliert).
- `.gitignore` um Datenbank-Muster ergaenzt (`*.sqlite*`, `*.db`, `*.db-wal`,
  `*.db-shm`).

### Entfernt
- Backup-Dateien im Arbeitsbaum (`*.bak-*`) - waren nie versioniert, gehoerten
  aber nicht in ein Produktverzeichnis.

### Unveraendert uebernommen
- Selbst-Update mit Trockenlauf, Sicherung und Rollback
- Versions-Gegenprobe (Steam, GitHub, CurseForge, manuell) mit gruen/gelb/grau
- Rechte-Erkennung und privilegierte Helfer
- Rack-abhaengige Archiv-Pruefung (zip/tar.gz/tar.xz)

## [0.9.5] - 2026-10-19

### Behoben
- **Ein fehlgeschlagener `git fetch` brach den Helfer stumm ab.** Das Skript
  laeuft mit `set -euo pipefail`; die Zuweisung `out="$(git ... fetch ...)"`
  beendet die Shell sofort mit gits Exitcode (128), bevor `rc=$?` und `fail()`
  laufen. Im Panel stand deshalb nur "git fetch fehlgeschlagen 5" - ohne Grund,
  ohne Ausgabe. Neue Funktion `fetch_tags()` faengt den Fehler ab und gibt
  gits eigene Meldung mit: "git fetch fehlgeschlagen: fatal: unable to access
  ... (rc 128)".

## [0.9.4] - 2026-10-19

### Behoben
- **Der Versions-Badge war nicht klickbar**, obwohl `cursor: pointer` genau das
  versprach. Es fehlte jeder Handler. Jetzt oeffnet ein Klick (und Enter/
  Leertaste) den Einstellungen-Tab mit der Sektion "Armory selbst".
  Wer `settings.read` nicht hat, bleibt beim Tooltip statt in einen leeren
  Tab zu laufen.
- **Der Einstellungen-Tab war beim Oeffnen ueber den Badge leer**, weil
  `openProfile('settings')` die Selbst-Update-Sektion nicht mitlud
  (`loadSelfUpdate()` lief nur beim direkten Tab-Klick).

## [0.9.3] - 2026-10-19

### Geaendert
- **"Arbeitsstand" wird getrennt gezaehlt**: `dirty_tracked` (geaenderte
  verfolgte Dateien) und `dirty_untracked` (neue Dateien ausserhalb
  .gitignore). Nur `tracked` sperrt das Update - bei denen kann ein checkout
  etwas verwerfen. Neue Dateien werden gemeldet, bleiben aber unberuehrt.
- **Gesperrt wird jetzt auch im Helfer, nicht nur im Panel.** Bisher konnte ein
  Direktaufruf von `armory-self-update apply` an der Panel-Sperre vorbei.
  Der Helfer prueft selbst: bei geaenderten verfolgten Dateien bricht er ab.
- Der Helfer meldet unversionierte Dateien im Log, ohne abzubrechen.

### Behoben
- `local` im `case`-Block des Helfers (keine Funktion) fuehrte zu
  "can only be used in a function" und haette den Apply-Pfad abgebrochen.

## [0.9.2] - 2026-10-19

### Neu
- **Header-Badge zeigt den Zustand**: gruen = aktuell, gelb = neuer Stand
  verfuegbar, grau = keine belastbare Aussage. Dieselben Farben wie bei den
  Swords, eine Bedeutung.
- **Taegliche Gegenprobe fuer die Armory selbst**, rollierend (Default 24 h).
  Neues Setting `self_update_check_minutes` (0 = nur manuell).
- **Sektion "Armory selbst" im Versions-Bereich** statt im Einstellungen-Tab.
  Dort: Rechte, installierter Stand, Zustand, Knopf "Jetzt pruefen",
  Trockenlauf und Update.
- `GET /api/self-update/state` (jeder Angemeldete) und
  `POST /api/self-update/check` (Superuser).

### Behoben
- **Helfer fand den Tag nie**: `git describe -c "safe.directory=..."` uebergab
  `-c` an `describe` statt an `git` (exit 129). Folge: jeder Stand erschien als
  "(kein Tag: <commit>)", die Versionspruefung war blind. Reihenfolge korrigiert.

## [0.9.1] - 2026-10-19

### Geaendert
- **Rechte werden nur noch beim Start gemessen**, nicht mehr im 60-Sekunden-Takt.
  Rechte aendern sich nur, wenn jemand die sudoers-Datei anfasst - und dann
  folgt ohnehin ein Neustart. Der Timer haette lediglich alle 60 s einen
  sudo-Login ins Journal geschrieben, ohne neue Erkenntnis.
- **Knopf "Rechte neu pruefen"** (`POST /api/system/rights/recheck`) fuer den
  Fall, dass die sudoers-Datei geaendert wurde und der Dienst nicht neu
  gestartet werden soll.

## [0.9.0] - 2026-10-19

### Neu
- **Rechte-Erkennung beim Start** (`app/systemRights.js`, `GET /api/system/rights`).
  Prueft fuer die drei Helfer, ob `sudo -n` wirklich laeuft, und meldet
  `ok` / `password-required` / `missing` / `denied` / `timeout`. Das Ergebnis
  wird 60 s gecacht; die Messung laeuft parallel mit 5-s-Deckel, damit der
  Serverstart nie darauf wartet.
  Ein Kunde mit gesperrtem ssh-root, aber erlaubtem sudo, sieht damit sofort,
  woran es liegt - statt kryptischer Fehler bei jedem Klick.
- **Selbst-Update im Panel** (`app/selfUpdate.js` + vier Routen, nur
  `superuser`): Stand anzeigen, verfuegbare Tags holen, Trockenlauf und
  echtes Update. Der Tausch laeuft im privilegierten Helfer; das Panel kann
  sich nicht selbst ersetzen.
- **Sektion "Selbst-Update der Armory"** in den Einstellungen: zeigt die
  erkannten Rechte, den installierten Stand und erlaubt Trockenlauf bzw.
  Update mit Bestaetigung.

## [0.8.1] - 2026-10-19

### Neu
- **Selbst-Update-Helfer** (`tools/armory-self-update`). Wechselt das Panel
  auf einen Git-Release-Tag, sichert vorher die versionierten Dateien und
  rollt zurueck, wenn das Panel danach nicht antwortet.
  - Schritte: `status`, `tags`, `apply <vX.Y.Z>` - kein freies Durchreichen.
  - Nur Tags aus dem Remote, nie Branches oder Commits.
  - **Eigentuemer-neutral**: laeuft als root (braucht Schreibrecht auf
    `.git`), merkt sich den Besitzer des Repos und stellt ihn nach dem
    `checkout` wieder her. Funktioniert damit auf einer root-Installation
    und auf einer, die dem Panel-User gehoert.
  - `DRY_RUN=1`: prueft alles bis zum `checkout` (Tag, Sauberkeit,
    Sicherung), tauscht aber nichts und startet nicht neu.

### Behoben
- `current_tag` schrieb die git-Fehlermeldung ("no tag exactly matches")
  in den Status-Text, weil `git_cmd` stderr nach stdout umleitet.
- `.self-update-backup/` fehlte in `.gitignore` - nach einem Trockenlauf war
  das Arbeitsverzeichnis "dirty" und blockierte das naechste Update.

## [0.8.0] - 2026-10-19

### Neu
- **Versions-Pruefung fuer alle Quellen** (`app/versionCheck.js`).
  Fragt je nach Rack-Typ die passende Quelle: Steam (`UpToDateCheck`),
  GitHub-Release, CurseForge oder eine manuell gepflegte Soll-Version.
  Ergebnis ist `current` / `outdated` / `unknown` - gruen wird nur, was die
  Quelle wirklich bestaetigt.
- **Soll-Version von Hand** fuer Quellen ohne Abfragemoeglichkeit
  (`POST /api/swords/:id/target-version`).
- **CurseForge-Pack-Nummer je Sword** (`POST /api/swords/:id/project-id`).
  Die Pack-Nummer ist ein Curse-Thema und steht nicht im Serverpack - sie
  laesst sich beim Install nicht erraten, also traegt sie der Betreiber ein.
  Nur damit ist ein direkter Abgleich gegen CurseForge moeglich.
- **Pruef-Intervall als Einstellung** (`version_check_minutes`, 0 = nur
  manuell), inklusive Sektion "Versions-Pruefung" im Panel.
- **API-Setup-Anleitung im Panel**: vier aufklappbare Bloecke zu CurseForge
  (Application- vs. Studio-Key), Steam (kein Key, aber `version_is_listable`),
  GitHub (60 Anfragen/Stunde) und der Farb-Legende.
- **Archiv-Upload formatneutral**: `.zip`, `.tar.gz`, `.tar.xz`, `.tar.bz2`,
  `.tgz`, `.txz`. Das Format wird an den Magic Bytes erkannt, nicht an der
  Endung; MIME dient nur als Zweitkriterium.
- **Rack-abhaengige Pack-Pruefung**: Jedes Rack nennt seine Marker
  (`mods`, `libraries`, `tsserver` ...). Ein TeamSpeak-Archiv wird nicht mehr
  gegen `mods/` geprueft und ein Modpack nicht gegen `tsserver`.
- **Update-Dialog filtert nach Rack**: Der passende Tab steht vorn, der
  Archiv-Upload ist immer zusaetzlich da, eine Leiste mit einem einzigen
  Knopf verschwindet.

### Behoben
- **Update-Ergebnis wurde nie angezeigt.** Kein `setState` schrieb ein
  `result`; die Route verwarf das Ergebnis von `start()`. Der Backup-Ort im
  Panel blieb deshalb leer.
- **`repoFromUrl` erkannte die Kurzform `owner/repo` nicht** (z.B.
  `teamspeak/teamspeak6-server`), wodurch GitHub-Racks als unbekannt galten.
- **`compareVersions` normalisierte den `v`-Praefix nicht** und meldete
  Gleichstand als "outdated".
- **`applyRackTabs` wurde im Update-Dialog nie aufgerufen.** Deshalb zeigten
  auch Racks ohne Steam/CurseForge alle vier Tabs.
- **Upload-Endung wurde immer `.zip`**, auch bei Tarballs.
- **Warnhinweis "startet ihn nicht automatisch neu" war falsch** - das Update
  startet den Server nach dem Austausch wieder.

## [0.7.1] - 2026-10-16

### Behoben
- **Update brach ab, bevor ein einziger Eintrag ersetzt wurde** (EACCES).
  Der Install-Helfer entpackte das Pack nach `/tmp/armory-pack-*` und setzte
  nur `o+x` auf der Wurzel (Durchquerung). Der Armory-Prozess laeuft als User
  `armory` und macht `readdir` auf dem Temp - das braucht LESEN (`r`) auf der
  Wurzel UND den Unterordnern, nicht nur Durchquerung. Folge: `EACCES:
  permission denied, scandir`, Abbruch vor der ersten Ersetzung, `mods/` blieb
  leer. Fix im Helfer (`extract-pack`): nach dem Entpacken `chmod -R o+rX`
  (lesen + durchqueren, ohne Schreibrecht; Eigentuemer unveraendert).
- **Instanz-Version wurde nach Updates nicht fortgeschrieben.** Zwei Fehler im
  Version-Pfad des Updaters: (1) `checkNeoforgeVersion()` liefert
  `{ packVersion, installed, changed }` - es wurde aber `needed` gelesen (Feld
  existiert nicht), also war die Version immer `null`; (2) die Pack-Version aus
  dem ZIP-Dateinamen ("ServerFiles-8.3.zip" -> "8.3") wurde auf dem Update-Weg
  nie ermittelt. Folge: Die Anzeige blieb auf dem Stand des Erstinstalls
  ("Keine neue Version ermittelbar"). Fix: Dateiname hat jetzt Vorrang
  (`extractCurseForgeVersion`, dieselbe gepruefte Logik wie beim Erstinstall),
  Feldname korrigiert, Neoforge bleibt letzter Ausweg.

### Hinzugefuegt
- **Install-Helfer versioniert** (`tools/armory-install-helper`). Die Install-
  und Update-Funktionen sind ohne ihn nicht lauffaehig (privilegierte
  Schicht); er wurde bisher nur unter `/usr/local/bin/` gepflegt und ging bei
  einem frischen Klon verloren.

### Wichtig - Kopplung
- Diese Version **verlangt** den mitgelieferten Helfer (u. a. Step `remove-tree`
  fuer den Neoforge-Neuaufbau). Aeltere Helfer-Fassungen brechen mit
  "unbekannter Step" ab. Nach dem Update:
  `install -m 755 tools/armory-install-helper /usr/local/bin/armory-install-helper`

### Geaendert
- **`replacePackContents` ersetzt jetzt ALLES** aus dem Pack ausser den
  Schutzpfaden (`server.properties`, `eula`, `whitelist`, `logs`, `backups`).
  Keine feste Positiv-Liste mehr (`PACK_PATHS` dient nur noch der Doku) - damit
  kann kein Eintrag mehr ausgelassen werden (u. a. die mitgelieferte
  `neoforge-<version>-installer.jar`). `local/` wird nicht mehr geschuetzt und
  ab jetzt ersetzt.
- **`ensureNeoforgePresent()`** (updater.js): ATM-Packs bringen bei jedem Update
  eine neue `startserver.sh` (mit geaenderter `NEOFORGE_VERSION`) UND eine
  vorgepatchte `neoforge-<version>-installer.jar` mit. Der Installer-Block in
  `startserver.sh` greift aber nur bei fehlendem `libraries/` - bei Updates
  laeuft er nie, der Server bricht nach Millisekunden ab
  ("could not open libraries/.../<version>/unix_args.txt"). Der Fix entfernt
  `libraries/` gezielt, damit `startserver.sh` beim Start alles neu aufbaut.
  Gilt fuer **atm10 UND atm11** (identisches Verhalten).

## [0.7.0] - 2026-10-10

### Hinzugefuegt
- **Instanz-Version je Sword** (`installedVersion`): Jede Instanz kennt jetzt
  ihre installierte Version und zeigt sie auf der Karte (Badge neben dem Namen).
  Drei Felder je Sword: `installedVersion` (z.B. `8.1`, `6.0.0-beta13.1`,
  `neoforge 21.1.251`), `installedVersionSource` (woher sie stammt) und
  `installedVersionAt` (wann ermittelt).
- **Automatische Ermittlung** an allen Installationswegen: CurseForge
  (`displayName`/Dateiname, z.B. `ServerFiles-8.1.zip` -> `8.1`), Upload-Dateiname,
  GitHub-Release-Tag (TeamSpeak 6), Neoforge-Version aus `startserver.sh` als
  Fallback sowie Steam-Build.
- **Version nachtragen** (Pflichtfeld-Ergaenzung): Erkennt die Automatik keine
  Version (z.B. Kundenpack mit unbekanntem Dateinamen), traegt der Mensch sie im
  Panel nach - neuer Menuepunkt **"Version eintragen"** mit Modal
  (`PUT /api/swords/:id/version`, Recht `sword.config.write`, Quelle `manual`).
- **Version nach Update**: Der Updater schreibt nach jedem Update die neue
  Version zurueck ins Sword (CurseForge-Datei bzw. Neoforge aus dem frisch
  entpackten Pack).

### Geaendert
- **`installedVersion` ist Pflichtfeld** (`string`, `minLength 1`, kein `null`).
  Der Loader lehnt ein Sword ohne Version mit klarer Anleitung ab, statt es
  stillschweigend zu laden - so wird eine Luecke sichtbar.
- `buildSword` und alle Install-Pfade reichen die Version durch; `KNOWN_FIELDS`
  um die neuen Felder ergaenzt (keine "unbekanntes Feld"-Warnung mehr).

### Behoben
- **Besitz-Erhalt beim Schreiben**: `setInstalledVersion` schreibt atomar
  (tmp + rename) und stellt den urspruenglichen Besitzer wieder her - sonst
  faellt die Sword-Datei auf `root` und `armory` kann sie nicht mehr schreiben.
- **Fehlender Import** `SWORDS_DIR` in `updater.js` (haette beim ersten Update
  einen Laufzeitfehler gegeben).

### Hinweis
- Bestands-Swords wurden nachgeruestet: `7d2d` (`steam build 24994542`),
  `atm10` (`8.1`), `atm11` (`neoforge 26.1.2.109`), `teamspeak6` (`6.0.0-beta13.1`).

## [0.6.0] - 2026-10-04

### Hinzugefuegt
- **E-Mail pro Nutzer in der Oberflaeche**: Feld "E-Mail (optional, fuer Reset)"
  beim Anlegen eines Nutzers und eine editierbare E-Mail-Spalte in der
  Nutzerverwaltung (Speichern bei Fokusverlust/Enter). Neues Recht
  `user.email` (Startbelegung: admin + superuser).
- **Eigene E-Mail im Profil**: jeder eingeloggte Nutzer kann seine Adresse
  selbst pflegen (`POST /api/auth/email`, `requireAuth`) - Voraussetzung,
  damit der Passwort-Reset fuer sich selbst funktioniert.
- **Admin-Route** `POST /api/auth/users/:id/email` (`requirePerm('user.email')`)
  mit Pruefung auf gueltige Adresse (400) und Eindeutigkeit (409).
- **Seed-Version 4**: neue Startbelegung (admin/superuser erhalten `user.email`).

### Behoben
- **Nutzerverwaltung layoutet**: feste Spaltenbreiten, gestyltes E-Mail-Feld,
  Loeschen-Button rot markiert - kein Gequetsche mehr.
- **Toter Import**: `requireRole`/`ROLE_LEVEL` in `server.js` entfernt (seit
  dem Rechte-Umbau unbenutzt).

## [0.5.0] - 2026-10-01

### Hinzugefuegt
- **Rechte-Matrix** (`app/permissions.js`): feines Recht je Rolle statt
  Rang-Leiter. Katalog mit Rechten, `DEFAULT_MATRIX` je Rolle, persistente
  Speicherung, `getMatrix`/`setPermission`.
- **`requirePerm()`** in `auth.js`; Inline-Pruefungen (start/stop/restart,
  Live-Konsole) laufen ueber `roleHasPerm` statt `ROLE_LEVEL`.
- **`GET`/`PUT /api/auth/permissions`** (superuser-Rolle fix, nicht entziehbar).
- **Frontend**: Tab "Rechte" im Profil (Raster Rollen x Rechte), Superuser-
  Spalte sichtbar, aber gesperrt; Tab-Sichtbarkeit ueber `data-need`-Rechte.
- **Rack-Verwaltung** im Panel (Racks anlegen/bearbeiten/loeschen).

## [0.4.1] - 2026-09-30

### Hinzugefuegt
- **Diagnose-Tab** (`GET /api/diagnostics`, Admin): listet im Panel, welche
  Racks (Schablonen) und Swords (Instanzen) geladen wurden - und warum eine
  Datei ggf. NICHT geladen wird. Trennt **Fehler** (Datei wird verworfen,
  z.B. ungueltiger Wert) von **Hinweisen** (Datei laeuft, enthaelt aber
  Ungewoehnliches). Beantwortet "warum fehlt mein Rack/Sword?" ohne SSH.
- **Neustart-Merker**: Wird die Konfiguration eines *laufenden* Servers
  gespeichert, fragt das Panel, ob gleich neu gestartet werden soll. Bei
  "Spaeter" merkt sich das Panel den offenen Neustart und zeigt auf der
  Sword-Karte einen Hinweis mit eigenem "Jetzt neustarten"-Knopf. Der Merker
  verschwindet von selbst bei Start/Stop/Restart und sobald der Server
  gestoppt ist (`POST`/`DELETE /api/swords/:id/pending-restart`).
- **Version im Kopf**: Der Badge zeigt jetzt die echte Git-Version
  (`GET /api/version`, Login-pflichtig) inkl. Commit und Kennzeichnung
  `dirty` fuer ungespeicherte Aenderungen; auf Systemen ohne Git faellt es
  auf die `package.json`-Version zurueck.

### Behoben
- **Config-Speichern meldete jede Datei als geaendert**: `applyXmlProperties`
  / `applyProperties` zaehlten *geschriebene* Felder, nicht *tatsaechlich
  geaenderte Werte*. Folge: Der Toast sagte "N Felder geaendert" auch bei
  identischem Wert, und die Neustart-Frage waere bei jedem Speichern
  erschienen. Neu: `writeConfig` vergleicht den alten Dateistand mit den
  neuen Werten und liefert `reallyChanged`/`reallyChangedFields`. Toast und
  Neustart-Frage haengen jetzt daran - nur echte Aenderungen zaehlen.

## [0.4.0] - 2026-09-29

### Hinzugefuegt
- **SMTP / E-Mail-Versand** (`app/mailer.js`): Betreiber hinterlegen eigene
  Zugangsdaten (Ionos, Brevo, eigener Server). Einstellungen-Tab mit
  Server, Port, STARTTLS/TLS, Benutzer, Passwort, Absender.
- **Testmail-Versand** (`POST /api/settings/test-mail`) mit sanitisierten
  Fehlermeldungen (kein Passwort in der Ausgabe).
- **Passwort vergessen**: Link auf der Login-Seite (nur wenn SMTP aktiv),
  `POST /api/auth/forgot-password` antwortet immer generisch (kein
  Account-Ausspaehen ueber die Antwort).
- **Reset- und Einladungs-Seite** (`public/reset.html`, Route `/reset`):
  neues Passwort setzen fuer Reset-Links und Einladungen.
- **Einladung beim Anlegen eines Nutzers** (`POST /api/auth/accept-invite`),
  wenn eine E-Mail angegeben ist und SMTP bereit ist.
- **E-Mail pro Nutzer**: neue Spalte `users.email`.
- **Token-Verwaltung** (`app/auth.js`): Einmal-Token fuer Reset/Einladung,
  in der DB nur als SHA-256-Hash gespeichert, Gueltigkeit 60 Minuten.

### Behoben
- **Konfigurationswerte wurden faelschlich maskiert**: `getSettingsStatus()`
  wandte `maskSecret` auf ALLE Textwerte an. Folge: `smtp_host`,
  `smtp_enabled`, `smtp_secure` waren im Formular nicht lesbar und der
  Aktiv-Schalter sprang auf den Default zurueck. Jetzt maskiert eine
  explizite Liste (`SECRET_KEYS`) nur echte Geheimnisse; alles andere kommt
  im Klartext.
- **SMTP-Passwort-Schutz**: Ein reines "Einstellungen speichern" (Maske oder
  leeres Feld) ueberschreibt das gespeicherte Passwort nicht mehr.

## [0.3.0] - 2026-09-27

### Hinzugefuegt
- **Rollen-System** mit den Stufen `strangerdanger`, `friend`, `moderator`,
  `admin`, `superuser` (`requireRole`-Middleware, `ROLE_LEVEL`).
- **Nutzerverwaltung** (nur Superuser): anlegen, Rolle aendern, loeschen.
- **Lockout-Schutz**: weder die eigene Rolle noch der letzte Superuser kann
  degradiert werden.
- **Brute-Force-Schutz** auf dem Login mit sperrbaren IPs.
- **EULA-Schritt am Rack** (`eula: 'required' | 'none'`) statt am Spiel -
  der Button erscheint nur, wo er hingehoert.

## [0.2.0] - 2026-09-26

### Hinzugefuegt
- **TeamSpeak-6-Rack** (`installMethod: url`, Tarball direkt aus dem
  GitHub-Release), inkl. `mkdir-statedir` fuer `/var/lib/<id>`.
- **Admin-Schluessel beim Erstinstall** (TS3/TS6): Einmal-Key wird gelesen
  und im Panel als kopierbarer Block angezeigt.
- **Live-Konsole** fuer 7d2d: Rack-Feld `logFile`, Kopie
  `startserver.armory.sh`, Helfer-Schritt `touch-logfile`.

### Behoben
- **Getrennte Log-Dateien** (Unit-Log root, Spiel-Log Server-User) - sonst
  Startabbruch mit `Unable to open log file` (exit 127).
- **x-Bit nach dem Update**: CurseForge-Windows-ZIPs liefern Startskripte
  ohne Ausfuehrungsrecht. `replace-pack` im Helfer setzt es nachtraeglich
  (systemd meldete sonst `203/EXEC`).
- **Rechte im Update-Pfad**: Backup und Pack-Austausch laufen jetzt ueber
  Helfer-Schritte als Instanz-User (`backup-tar`, `replace-pack`).
- **Reihenfolge Stop-vor-Backup**: ein laufender Server schreibt in die Welt,
  ein tar waere nicht konsistent. Fehler beim Stop starten die Instanz wieder.

## [0.1.0] - 2026-09-24

### Hinzugefuegt
- Erstes Grundgeruest: Express-Server, Session-Login, Weboberflaeche.
- **Racks** (Schablonen) und **Swords** (laufende Instanzen) mit JSON-Schema.
- **Installation** ueber CurseForge, SteamCMD, ZIP/URL - ausgelagert in
  Helfer-Schritte mit root-Rechten.
- **Start/Stop/Restart** ueber systemd, Live-Ausgabe im Panel.
