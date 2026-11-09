# Changelog

Alle nennenswerten Aenderungen an der Game-Armory.
Format orientiert an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [1.3.72] - 2026-11-09

### Behoben

- **Die Arsenal-Zeilen waren im hellen Theme unsichtbar.** Das CSS benutzte
  `var(--panel2, ...)` - und `--panel2` gibt es im Theme nicht. Der
  Fallback-Wert war ein fast transparentes Weiss, das auf hellem Grund
  verschwindet. Jetzt `var(--card)` mit `var(--border)`, beides vorhanden.
- **Feste Farbwerte im Arsenal-CSS.** Die Punkte standen auf `#3fb950` u.a.,
  obwohl das Theme `--ok`/`--warn`/`--red`/`--muted` mitliefert und im hellen
  Theme abdunkelt. Feste Werte waeren dort zu blass gewesen.

### Tests

- 2 neue Tests: jede im Arsenal-CSS benutzte Theme-Variable muss existieren,
  und dort darf keine feste Farbe stehen. Gesamt 235.
- Gegenprobe per Mutation: `--panel2` wieder eingesetzt -> genau der neue Test
  wird rot.

## [1.3.71] - 2026-11-09

### Neu

- **Arsenale im Konto-Tab sichtbar.** Der erste Teil, den der Kunde wirklich
  sieht: unter Konto -> Arsenale steht jede gekoppelte Maschine mit Zustand,
  Version und "letztes Lebenszeichen vor X". Ein Knopf "Aktualisieren" holt
  den Stand neu, ohne die Seite zu laden.

### Bewusst so gebaut

- **"Noch nie gemeldet" und "Offline" sind zwei verschiedene Worte.** Ein
  Arsenal, das sich nie gemeldet hat, ist NICHT bewiesen tot. Gleicher Text
  waere eine Behauptung ohne Messung.
- **Ein unbekannter Zustandswert wird nie als "Online" gelesen.** Fail-closed:
  ein Wert, den das Frontend nicht kennt, zeigt "Unbekannt" - nicht gruen.
  Sonst zeigt ein neuer Server-Zustand im Panel einen gesunden Server an.
- **Farbe allein traegt nichts.** Jede Zeile hat einen farbigen Punkt UND den
  Zustand als Wort.
- **Der Schluessel taucht in der Anzeige nie auf** - nur beim Koppeln, einmal.

### Tests

- 11 neue Tests (Zustandstext, Metazeile, Escaping). Gesamt 233.

## [1.3.70] - 2026-11-09

### Neu

- **Kopplung von Arsenalen (Fundament).** Eine Armory kann mehrere Maschinen
  verwalten. Die Kopplung laeuft bewusst umgedreht: das ARSENAL erzeugt den
  Kopplungscode, die ARMORY tippt ihn ein. Dadurch muss am Arsenal kein Port
  nach aussen offen sein - es funktioniert im Heimnetz wie im Internet.

  ```
  POST /api/arsenals/pairing   Code am Arsenal erzeugen (15 min gueltig)
  POST /api/arsenals/pair      Code in der Armory einloesen -> Schluessel
  GET  /api/arsenals           Liste mit Zustand
  POST /api/arsenals/:id/revoke  Arsenal sperren
  POST /api/arsenal/heartbeat  Lebenszeichen (Schluessel im Header)
  ```

### Sicherheit

- **In der DB liegt nur der Hash.** Weder Kopplungscode noch Arsenal-Schluessel
  stehen im Klartext in der Datenbank (SHA-256, wie bei den Reset-Tokens).
  Der Schluessel wird beim Einloesen genau EINMAL ausgegeben.
- **Der Kopplungscode ist einmalig und kurz gueltig** (15 Minuten). Ein neuer
  Code entwertet den alten, damit nie zwei offen sind.
- **Die Pruefung des Lebenszeichens ist nicht anfaellig fuer Praefix-Treffer**
  und vergleicht in konstanter Zeit (`timingSafeEqual`).
- **Ein gesperrtes Arsenal wird abgewiesen**, auch mit richtigem Schluessel.
- **Unbekannter und falscher Code geben dieselbe Antwort**, damit sich mit
  geratenen Codes nicht herausfinden laesst, welche existieren.
- **`arsenal.*`-Rechte sind Startbelegung nur Superuser** (nicht in
  `ADMIN_PERMS`), wie bei `system.logs`. `arsenal.pair` ist eigenstaendig:
  koppeln ist mehr als ein bestehendes Arsenal pflegen.

### Behoben

- **`arsenalState` stufte ein Arsenal an der Grenze als "online" ein.**
  Bei exakt `HEARTBEAT_STALE_MS` Alter stand `age > STALE` noch auf "online".
  Ein Arsenal, das 90 s geschwiegen hat, galt damit einen Moment zu lange als
  lebendig. Jetzt `>=`.
- **`auth.js`: DB-Pfad ueber `ARMORY_DB_PATH` umlenkbar.** Vorher hartkodiert;
  Tests haetten sonst gegen die echte Datenbank laufen muessen.

### Tests

- 47 neue Tests (19 Kopplung/Pruefung, 13 Speicher, 15 Routen). Gesamt 222.
- Jede Schutzfunktion ist per Mutation gegengeprueft: Klartext in der DB,
  fehlende Einmalverwendung, ignorierter Ablauf, fehlendes Rechte-Gate,
  Herzschlag ohne Schluessel - jede Mutation macht genau die zugehoerigen
  Tests rot.

## [1.3.5] - 2026-11-07

### Behoben

- **Der Update-Dialog sagte zwei gegensaetzliche Dinge zum Server-Neustart.**
  Im Hinweis unter dem Upload-Tab stand "gestoppt und danach **nicht**
  automatisch gestartet", in der Warnung darueber und im Preflight aber
  "startet ihn danach wieder". Der Code hat recht: `runUpdate` startet immer
  neu (`app/updater.js:401`, Phase `starting`, `serviceAction(service, 'start')`)
  und wartet auf den Done-Marker. Live belegt am 2026-11-07: atm11 lief nach
  dem Update auf 0.14.0-beta. Der falsche Satz ist ersetzt.
- **Die Karte zeigte nach einem Update den Stand von vorher.** `finishProgress()`
  lud die Sword-Liste nicht neu; `upSword` wird beim Oeffnen des Dialogs
  eingefroren (`app.js:1808`) und blieb stehen, bis die Seite neu geladen wurde.
  Jetzt ruft `finishProgress()` nach einem erfolgreichen Update
  `scheduleSwordsRefresh(200)`.
- **Der Abschluss-Toast war irrefuehrend.** Er sagte "Server ggf. neu starten",
  obwohl `runUpdate` das selbst tut. Jetzt meldet er schlicht "Update
  abgeschlossen" - und wenn der Server nicht hochkam, sagt er das statt es zu
  vermuten (`result.started === false`).
- **Sichtbare Texte im Panel benutzten ae/oe/ue statt Umlaute.** Zwei Runden
  waren noetig, weil die einzelnen Stellen von Hand gesucht wurden. Betroffen
  waren unter anderem "Neoforge-Version pruefen", "Server laeuft", "Eintraege",
  "aeltere werden danach geloescht", "Rack loeschen"/"Loeschen",
  "Empfaengeradresse", "Aenderungen", "gueltiges JSON", "Racks
  anlegen/bearbeiten/loeschen", "fuer Faelle" und "beim Oeffnen". Kommentare
  und Bezeichner im Code bleiben bewusst ASCII.

### Absicherung

- **`tests/umlauts.test.mjs` verhindert Rueckfaelle systematisch.** Der Test
  prueft sichtbaren Text (HTML-Textknoten, Attributwerte wie `placeholder` und
  `title`, String-Literale in `app.js`) gegen eine Liste deutscher
  Ersatzschreibweisen - Kommentare und Bezeichner bleiben ASCII und sind
  ausgenommen. Anlass: die Stellen einzeln zu suchen hat zwei Runden gedauert;
  der Test fand danach noch neun weitere in `app.html`, darunter Kommentare
  (ausgenommen) und sichtbare Texte wie "Racks anlegen/bearbeiten/loeschen".
- Zusaetzlich prueft er, dass beide Dateien sauber UTF-8 sind: kein U+FFFD und
  keine doppelt kodierten Umlaute ("Ã¤" statt "ä").

- `tests/updateDialog.test.mjs` haelt beides fest: der Dialog darf nicht
  behaupten, der Server bleibe aus, und `finishProgress()` muss die Karte
  auffrischen. Mutationsgeprueft - den falschen Satz zurueckholen bzw.
  `scheduleSwordsRefresh` entfernen macht genau einen Test rot.

## [1.3.3] - 2026-11-07

### Behoben

- **Sword-Version wurde am Cache vorbei geschrieben.** Nach einem ZIP-Update
  stand in der Sword-Datei die richtige Version, die Panel-Anzeige blieb aber
  auf dem alten Wert, bis der Dienst neu startete. Ursache: `runUpdate` schrieb
  die Datei selbst per `writeFile` und liess den Modul-Cache in `app/swords.js`
  unberuehrt; `getSword()` liest aus diesem Cache. Jetzt geht der Schreibvorgang
  ueber `setInstalledVersion()` - das sperrt zusaetzlich (`withSwordLock`),
  setzt `installedVersionBy` und aktualisiert den Cache.

### Absicherung

- **Testkette fuer die Versions-Ermittlung beim ZIP-Update** (`tests/versionChain.test.mjs`).
  Beim atm11-Update am 2026-10-30 23:25 meldete das Log "Keine neue Version
  ermittelbar", obwohl der Dateiname `0.14.0-beta` enthielt. Ursache war nicht
  der Parser (der erkennt den Namen), sondern dass `runUpdate` nur
  `basename(zipPath)` kannte - und der Upload heisst `upload-<uuid>.zip`. Genau
  diesen Namen weist der Parser bewusst ab (kein Raten). Der Fix `6b37b64`
  (2026-10-31) reicht seither `originalName` durch; die Kette
  `uploads.js -> installRoutes.js -> updateFromZip -> runUpdate` ist jetzt
  durch sieben Tests festgenagelt.
- **Sword-Cache-Tests** (`tests/swordCache.test.mjs`) halten fest, dass im
  Versionsblock kein direktes `writeFile` auf eine `.sword.json` stehen darf.

73 Tests gruen. Beide neuen Tests sind mutationsgeprueft: wer `originalName`
aus dem `runUpdate`-Aufruf entfernt bzw. das direkte `writeFile` zurueckbaut,
bekommt genau einen roten Test.

### Klarstellung

Der in 1.3.3 behobene Cache-Fehler ist **nicht** die Ursache des vom Betreiber
gemeldeten Symptoms ("Version bleibt beim ZIP-Upload stehen"). Dort zeigte der
offene Update-Dialog einen beim Oeffnen eingefrorenen Stand (`upSword`), und
nach einem Reload stimmte die Anzeige. Der Cache-Fehler ist real, war aber
bisher unsichtbar, weil die erkannte Version zufaellig mit der von Hand
eingetragenen uebereinstimmte (atm10: `8.5`).

## [1.3.2] - 2026-11-06

### Behoben

- **ZIP- und Upload-Racks liessen sich nicht anlegen.** Die beiden Methoden
  ohne entfernte Quelle waren in `SOURCE_TYPES` (`app/racks.js`) nicht
  enthalten, obwohl der Installer sie bedient (`installRoutes.js:1048` 'zip'
  -> `source.path`, `:1052` 'upload' -> `source.uploadId`) und
  `INSTALL_TYPE_FOR_METHOD` (`:977`) sie als Zielwert bildet. Jedes Anlegen
  endete mit `source.type ungueltig`.
- **Der Editor bot sie auch nicht an.** Das `source.type`-Dropdown in
  `public/app.html` hatte `zip` und `upload` nicht. Wer eine ZIP-Rack bauen
  wollte, waehlte zwangslaeufig etwas anderes - das Rack wurde gespeichert
  und brach erst bei der Installation mit 400 ab
  ("erwartet: zip, im Rack: local"). Der Fehler kam erst beim Klick.
- **Schema-Enums waren in beide Richtungen falsch.** `game` kannte
  `satisfactory` nicht (der Code schon), `installMethod` erlaubte `url` (vom
  Code am 2026-10-19 ersetzt, weil jeder http(s)-String als GitHub-Repo
  aufgeloest und per root-Helfer entpackt wurde) und verbot `github`, das der
  Code verlangt. Wer nach dem Schema baut, waehlte `url` und wurde abgewiesen;
  wer `github` nutzt, wurde vom Schema abgewiesen. Das ausgelieferte
  `teamspeak6.rack.json` war laut Schema ungueltig, laut Code gueltig.
- **`source.type` hatte im Schema ueberhaupt keine Werteliste.** Jetzt eine,
  mit `zip` und `upload`.

### Neu

- **Tests vergleichen jetzt auch Enum-Werte, nicht nur Feldnamen.** Der
  Abgleich aus 1.3.1 war zu flach: er haette die Enum-Abweichungen nicht
  gefunden. Neu sind sechs Tests, die die Wertelisten gegeneinander halten -
  inklusive der Liste, die `installRoutes.js` bildet.
- **Das Frontend wird gegen das Backend geprueft.** Zwei Tests lesen
  `public/app.html` und stellen sicher, dass jede Quelle und jede
  Install-Methode, die der Server bedient, im Editor waehlbar ist.

### Warum das erst jetzt auffiel

Der Schema-Test aus 1.3.1 prueft nur, ob die richtigen *Felder* existieren.
Ein Rack kann alle Felder haben und trotzdem unbaubar sein. Nachgewiesen mit
sieben absichtlichen Verschlechterungen: jede faerbte genau die Tests rot,
die sie betreffen sollte.

## [1.3.1] - 2026-11-06

### Neu

- **Tests.** Es gab bis jetzt keine. `tests/` enthaelt 52 Tests mit dem in Node
  eingebauten Testlaeufer (`npm test`) - keine devDependencies, kein `npm
  install` noetig. Abgedeckt ist die Rack-Validierung: Pflichtfelder, Enums,
  Typen, Ports, relative Pfade und die Regel, dass `defaultRoot` unter `/opt`
  liegen muss.
- **Der Push-Scanner laesst keine roten Tests durch.** `tools/pre-push-scan.sh`
  faehrt die Tests mit und bricht ab, wenn einer rot ist. Fuer reine
  Doku-Commits gibt es `ARMORY_SKIP_TESTS=1`.
- **`tests/schema.test.mjs` haelt Schema und Code zusammen.** Siehe Behoben.

### Behoben

- **Schema und Code waren auseinandergelaufen.** `racks/rack.schema.json`
  kannte `configTemplate` nicht, obwohl `app/racks.js` das Feld verlangt (bei
  `installMethod "github"` ist es Pflicht). Wer ein Rack gegen das Schema
  prueft, bekam also Fehler, die das Panel nie wirft - und umgekehrt. Feld
  ergaenzt, plus ein Test, der die Abweichung kuenftig meldet.
- **Falsche Abbruchmeldung im Push-Scanner.** Bei roten Tests empfahl das
  Skript "Historie bereinigen" - richtig bei Betreiberdaten, voellig
  daneben bei einem fehlgeschlagenen Test. Jetzt zwei getrennte Meldungen.

### Warum gerade jetzt

Der Grundsatz aus dem Audit vom 2026-10-31: zu jedem Punkt zuerst einen Test,
der **scheitern muss**. Ohne Testgeruest ist das eine Absichtserklaerung. Zum
Gegenbeweis wurden zwei absichtliche Verschlechterungen eingebaut (Sicherheits-
regel fuer `defaultRoot` deaktiviert, `configTemplate` aus dem Schema entfernt) -
jeweils genau ein Test wurde rot, die uebrigen blieben gruen.

## [1.3.0] - 2026-11-06

### Neu

- **Erstinstallation mit einem Befehl.** `sudo tools/armory-install.sh` richtet
  die Armory auf einem frischen Debian/Ubuntu ein: Service-User, Verzeichnisse,
  npm-Abhaengigkeiten, Helfer, sudoers-Regel, systemd-Unit und Start - in dieser
  Reihenfolge, jeder Schritt idempotent. `--check-only` prueft nur und aendert
  nichts. Am Ende steht eine Selbstpruefung mit OK/FEHLER statt eines
  pauschalen "erfolgreich".
- **systemd-Unit kommt aus einer Vorlage im Repo.** Bisher war sie von Hand in
  `/etc/systemd` gepflegt; damit war sie beim Neuaufsetzen verloren. Jetzt liegt
  sie als `templates/systemd/game-armory.service.tmpl` im Git (Platzhalter fuer
  Installationspfad, Service-User, Node-Binary und Game-Roots) und wird daraus
  erzeugt. Eine bestehende Unit wird vorher gesichert.
- **Abschluss nennt den Zugriffsweg.** Das Panel lauscht nur auf
  `127.0.0.1:3000`; das Skript sagt jetzt ausdruecklich, dass von aussen nichts
  erreichbar ist und wie man drankommt (SSH-Tunnel oder Reverse-Proxy).

### Behoben

Die folgenden Punkte fielen erst beim Test auf einer frischen Debian-VM auf -
auf dem Entwicklungsserver waren sie unsichtbar, weil dort alles schon
vorbereitet war:

- **`npm install` brach auf frischem System ab** (`gyp ERR! not found: make`).
  `better-sqlite3` ist ein natives Modul und wird aus Quellcode gebaut; das
  Skript installiert jetzt `build-essential` und `python3`, falls sie fehlen.
- **Dienst startete nicht** (`status=226/NAMESPACE`). Die Unit nennt Game-Roots
  in `ReadWritePaths`; fehlt eines davon, startet systemd den Dienst gar nicht.
  Das Skript legt fehlende Roots jetzt an, bevor es die Unit schreibt.
- **Selbstpruefung meldete falschen Fehler.** Sie fragte `/` ab und erwartete
  200 - die Wurzel leitet ohne Sitzung aber per 302 auf `/login` um. Geprueft
  wird jetzt `/login`, und zwar mit Wartezeit statt Einzelmessung direkt nach
  dem Start.
- **Node-Hinweis ohne Weg.** Statt "bitte installieren" nennt das Skript jetzt
  den konkreten Befehl und bricht ab, bevor es irgendetwas aendert.
- **Veraltete `node_modules` blieben stehen.** Entscheidend ist jetzt der
  Zeitstempel von `package-lock.json`, nicht ob der Ordner existiert.

## [1.2.0] - 2026-10-31

### Neu

- **Log und Fehler in einem Fenster.** Im Konto-Menue findest du unter
  **Logs** jetzt beides zusammen: links die Fehlerliste mit Kennung und Stapel,
  rechts der Panel-Log (`armory.log` bzw. `armory.err`). Bei der Fehlersuche
  braucht man meist beides - hier den Eintrag, dort was unmittelbar davor
  passiert ist. Zeile anklicken zeigt den vollstaendigen Text samt Stapel.
  Sichtbar **nur fuer Superadmins**; die Routen pruefen das zusaetzlich auf dem
  Server, nicht nur in der Oberflaeche. In der Rechte-Tabelle steht dafuer das
  neue Recht `system.logs`.
- **Fehlermeldungen tragen eine Kennung.** Schlaegt im Panel etwas fehl, steht
  in der Meldung eine kurze Kennung (z. B. `k9dc99gj`). Mit ihr findest du den
  Eintrag unter **Logs** wieder - mit Stapel und Zeitpunkt.

### Behoben

- **Steam-Update erkannte einen laufenden Server als Fehlschlag.** Der neue
  7d2d-Build (26237934) schreibt `Done (` nicht mehr ins Server-Log; das Panel
  wartete darauf und meldete nach drei Minuten einen Fehlschlag, obwohl der
  Server lief (StartGame done, EOS registered, GameServer.LogOn successful).
  Es werden jetzt mehrere Marker akzeptiert, `StartGame done` zuerst.
- **Steam-Update laesst sich nach einem Abbruch wieder aufnehmen.** Bricht der
  Download ab (live: 39,36 %), wurde die halbe Datei verworfen und von vorn
  begonnen. Jetzt wird der Teilstand erkannt und fortgesetzt.
- **Symlink-Schutz im Installationshelfer.** `write-config` folgte einem
  vorbereiteten Symlink und schrieb ausserhalb des Zielverzeichnisses.
- **Login: Bremse gegen Durchprobieren.** Fehlversuche werden je Absender
  gezaehlt und gedrosselt; die Passwortpruefung blockiert den Prozess nicht
  mehr (247 ms gemessen).
- **Login verraet nicht mehr, ob es ein Konto gibt.** Unbekannte Namen werden
  mit derselben Rechenzeit behandelt wie bekannte.
- **Uploads: Dateinamen werden gesaeubert.** Vorher konnte ein Name wie
  `a/../../etc/cron.d/evil` aus dem Temp-Ordner ausbrechen.
- **ZIP-Pfad auf den Upload-Ordner begrenzt.** Vorher liess sich mit dem Recht
  `sword.update` jede beliebige Datei als ZIP oeffnen.
- **Kaputte Anfragen brechen das Panel nicht mehr ab.** Grosse Anfragen werden
  abgewiesen (512 KB), Fehler bekommen eine Kennung statt eines leeren
  Fensters.

## [1.1.94] - 2026-10-31

Drei Befunde aus dem ersten echten Update-Durchlauf nach 1.1.93 (atm11,
00:25). Alle drei sind live nachgemessen, nicht aus dem Audit uebernommen -
der Versionsbefund stand in keinem Audit, weil er nur mit einem echten
Update-ZIP auftritt.

### Behoben

- **Steam-Install schreibt `installedVersion: null` (B27).** `swords.js` laedt
  nur Dateien, deren Version ein nicht-leerer String ist - eine per Steam
  installierte Instanz verschwand deshalb beim naechsten Panel-Start aus der
  Liste, obwohl systemd sie weiter betrieb. Die Bewertung "Steam-Racks haben
  keine Version" war zusaetzlich falsch: steamcmd schreibt
  `steamapps/appmanifest_<appId>.acf` mit `"buildid"`. `installFromSteam`
  liest die Build-ID jetzt und traegt `steam <buildid>` ein. Belegt mit der
  laufenden 7d2d-Instanz: `24994542` -> `steam 24994542`, wird von
  `swords.js:64` akzeptiert; alter Wert `null` wird abgewiesen.

- **Update uebernimmt die Version nicht aus dem ZIP-Namen.** Der Upload liegt
  als `upload-<uuid>.zip` auf der Platte (bewusst), der Originalname nur in den
  Metadaten daneben. `runUpdate` gab dem Parser den Plattennamen, der
  korrekt keine Version traegt - Ergebnis: `Keine neue Version ermittelbar`,
  die Sword-Version blieb auf dem Stand des Erstinstalls stehen. Live belegt
  beim atm11-Update: Anzeige blieb `0.12.0-beta` vom 20.10. Der Originalname
  geht jetzt von der Route ueber `updateFromZip` bis in den Parser; der
  Plattenname dient nur noch als Rueckfall. Belegt:
  `All the Mods 11 - ATM11 0.12.0-beta.zip` -> `0.12.0`.

- **`start`/`stop`/`restart` waren nicht abbildbar (B22).** Die drei Aktionen
  standen in `SYSTEMCTL_ACTIONS`, hatten aber keinen Zweig - jeder Klick im
  Panel warf `Aktion nicht ueber Helfer abbildbar`. Sie liefen ausserdem gegen
  den falschen Helfer: `armory-install-helper` schreibt Units und kennt kein
  start/stop; dafuer gibt es `armory-service-ctl` (seit 25.09. vorhanden,
  ungenutzt). Die Aktionen laufen jetzt ueber `SERVICE_HELPER`, der
  zusaetzlich prueft, dass der Service als Sword registriert ist. Belegt:
  `start`/`stop`/`restart` gegen `teamspeak6.service` je `rc=0`, und ueber den
  Code-Weg `systemctl(['restart', ...])` -> `ok=true`, Dienst danach `active`.

## [1.1.93] - 2026-10-31

Die MITTEL- und NIEDRIG-Runde aus dem Audit. 57 MITTEL und 66 NIEDRIG/HINWEIS
wurden gegen den echten Code nachgeprueft (nicht gegen die Zeilennummern aus
dem Audit - die waren nach 1.1.92 um bis zu 90 Zeilen verschoben):

    57 MITTEL        27 echt, 21 widerlegt, 6 abgefangen, 2 erledigt
    66 NIEDRIG/HINWEIS  21 echt, 28 widerlegt, 13 abgefangen, 3 erledigt, 1 unklar

Sieben der echten Befunde sind hier behoben. Zwei weitere kamen dazu, die gar
nicht im Audit standen.

### Behoben

- **`source.url` wird ungeprueft als GitHub-Repo behandelt (Z23).** Die Methode
  hiess `url` und nahm jeden http(s)-String an. Der Code loest ihn aber als
  GitHub-Repo auf (`api.github.com/repos/<url>`) und laedt die
  `browser_download_url` aus der Antwort - ein fremder Host wurde damit als
  Quelle akzeptiert, und dessen Tarball per Helfer als root entpackt. Jetzt:
  `installMethod: "github"` und `source.url` MUSS `https://github.com/<owner>/<repo>`
  sein (oder `owner/repo`). Lookalike-Hosts wie `github.com.evil.example` fallen
  durch. Kein Allowlist, keine Sonderfaelle - die Quelle IST github.com.

- **Tarball-Install rendert zwingend das TeamSpeak-Template (B19).**
  `renderConfigTemplate('teamspeak6.tsserver.yaml')` stand fest im Code. Da
  `github` an kein Spiel gebunden ist, haette ein Rack fuer ein anderes Spiel
  die TS6-Vorlage bekommen. Jetzt nennt das Rack sie (`configTemplate`), Pflicht
  bei `installMethod: "github"`, Format geprueft. Die TS-Erkennung haengt jetzt
  an der Vorlage statt am Dateinamen der Config.

- **Neoforge-Versionen wurden lexikografisch verglichen (D320).**
  `[...versions].sort().pop()` auf `['21.1.100','21.1.99','21.1.209']` ergibt
  `21.1.99` - die AELTERE Version. Betroffen: `detectNeoforgeVersionFromPaths`
  und `detectInstalledNeoforgeVersion`, beide im Update-Weg. Jetzt numerischer
  Vergleich; auf atm10/atm11 live geprueft (21.1.259 bzw. 26.1.2.109).

- **`allowed` wurde per Truthiness gelesen (D129).** `!!ch?.allowed` macht aus
  dem String `"false"` ein `true` - wer per `PUT /api/auth/permissions`
  `{"allowed":"false"}` schickte, um ein Recht zu ENTZIEHEN, vergab es. Jetzt
  muss `allowed` ein echter Boolean sein, alles andere wird mit Fehler
  abgewiesen.

- **Weltschutz prueft den falschen Ordner (C113).** `replacePackContents`
  prueft `isProtectedPath` nur gegen den Pack-Inhalt, nie gegen das Ziel;
  `report.removed` blieb immer leer. Jetzt wird der Zielordner gelesen, und was
  dort geschuetzt ist, wird nicht ersetzt (im Report gefuehrt).

- **Keine Groessenpruefung beim GitHub-Download (B21).** `asset.size` wurde nur
  fuer die Log-Zeile benutzt. Ein abgebrochener Download landete vollstaendig
  auf der Platte und wurde danach als root entpackt. Jetzt: Groessenvergleich,
  Abweichung -> Datei weg, kein Entpacken.

- **Timeout beendet nur `sudo`, nicht den Helfer (C213).** `detached: true` plus
  `process.kill(-pid)` beendet die Prozessgruppe. Gemessen: direkte Kinder des
  Helfers (`git fetch`, `systemctl restart`) sterben, ein per `&` abgenabelter
  Enkel einer Shell ueberlebt. Der echte Pfad ist der erste Fall.

### Nicht geaendert (Befund war falsch)

`A30`, `A31`, `A38`, `B23`, `B24`, `B26`, `C108`, `C115`-`C117`, `C130`-`C132`,
`C210`, `C219`, `C220`, `D117`-`D119`, `D126`, `D127`, `D130`, `D132`, `D222`,
`D229`, `D304`, `D314`, `D316`, `D317`, `D326`, `D328`, `D334` - nachgeprueft
und widerlegt. `D313` und `D315` sind durch die Fixes oben bereits erledigt.

Bemerkenswert: ein Pruefer meldete, `installFromSteam` benutze `startScript`
ohne Deklaration (ReferenceError bei jedem Steam-Install). Nachgemessen: die
Variable wird dort deklariert. Der Befund war falsch.

### Offen (fuer 1.2)

41 echte Befunde, davon 20 MITTEL und 21 NIEDRIG/HINWEIS. Zwei mit Wirkung, die
vor 1.2 rein muessen:

- **B27** - `installFromSteam` schreibt `installedVersion: null`, `swords.js:64`
  lehnt `null` hart ab. Eine 7d2d-Instanz erscheint nach einem Panel-Neustart
  NICHT mehr im Panel, obwohl systemd sie weiter betreibt.
- **B22** - `start`/`stop`/`restart` laufen live in
  "systemctl: Aktion nicht ueber Helfer abbildbar".

## [1.1.92] - 2026-10-30

Die 15 verbliebenen HOCH-Befunde aus dem Audit wurden einzeln nachgeprueft.
Zehn waren echt, fuenf falsch. Dazu drei Fehler, die erst beim Testen der
Fixes aus 1.1.91 auffielen.

### Behoben

- **`query.port` stand auf dem RCON-Port.** Bei atm11 live belegt:
  `rcon.port=25576`, `server-port=25566`, `query.port=25576`. Minecrafts Query
  laeuft ueber UDP, RCON ueber TCP - der Server startet deshalb, aber Query
  antwortet auf dem falschen Port. Der Kommentar daneben behauptete das
  Gegenteil.

- **CurseForge-`projectId` war an zwei Stellen fest `null`.** In der
  Rack-Schablone (`rack.source.projectId`) und im Sword (`update.projectId`).
  Folge: atm10/atm11 meldeten dauerhaft "keine projectId im Rack", die
  Versionspruefung lief nie, und ein Update brach mit "Kein CurseForge-Projekt
  (modId) vorhanden" ab. Die `modId` kennt der Aufrufer - sie wird jetzt
  durchgereicht.

- **`sword.rack` ignorierte die uebergebene `rackId`.** Ein Steam-Install mit
  `rackId='7d2d'` wurde als `rack='<id>'` persistiert und zeigte damit auf ein
  Rack, das es nicht gibt. Das Rack traegt Spiel, Quelle und Java-Version - alles
  Folgende las daran vorbei.

- **`world_nether` und `world_the_end` waren nicht geschuetzt.** Der Kommentar
  dokumentierte seit jeher einen Glob `world*`, der Code prueft aber mit
  `includes()` auf exakte Gleichheit - also traf nur `world`. Ein Pack-Update
  haette die Nether- und End-Welt ueberschrieben.

- **Update-Status war fuer jeden Angemeldeten lesbar.** `GET
  /api/swords/:id/update-status` hing an `requireAuth` statt an
  `requirePerm('sword.update')`.

- **Ein fehlgeschlagener Serverstart wurde als "erfolgreich" gemeldet.** Die
  Statusmeldung sagte "Update erfolgreich abgeschlossen", auch wenn der Start
  scheiterte; der Balken wurde gruen. Der widersprechende Hinweis stand nur im
  Ergebnis-Panel darunter.

- **Pflichtfelder durften `null` sein.** `validateSword` prueft nur auf
  `undefined` - `{"id": null}` und `{"control": null}` kamen durch. Jetzt zaehlt
  auch `null` und ein leerer String als fehlend.

- **Sword-id und Dateiname waren nicht verbunden.** Eine Datei
  `atm11.sword.json` mit `"id":"atm10"` wurde als atm10 geladen; zwei Dateien mit
  derselben id ueberschrieben sich im Cache. Der Dateiname bestimmt jetzt die
  Instanz.

- **`createRack` war nicht serialisiert.** Pruefung und Schreiben lagen durch ein
  `await` getrennt: zwei gleichzeitige Anfragen sahen beide "existiert nicht",
  beide bekamen 201, der zweite `rename` ueberschrieb den ersten. Laeuft jetzt
  unter einem Lock wie `withSwordLock`.

- **`$()` in `ExecStop` (Nachtrag zu 1.1.91).** `rcon-stop.mjs` liest den
  RCON-Port jetzt aus der Sword-Datei (`rcon.port`) statt fest 25575 zu nehmen -
  atm11 laeuft auf 25576. Ein Verbindungsfehler endet mit `exit 2` statt `0`,
  damit im Journal steht, dass der saubere Weg nicht geklappt hat. Die Unit
  `atm11.service` wurde neu geschrieben.

- **Kommentar `"Antwortet IMMER mit 200"`** bei `version-check` widersprach dem
  Code. Jetzt stehen die tatsaechlichen Statuscodes da.

### Behoben (beim Testen von 1.1.91 gefunden)

- **Jede ZIP-Installation brach sofort ab.** `installFromZip` rief
  `extractToTemp(zipPath)` ohne die Instanz-id; das entpackt aber mit den Rechten
  des Server-Users und warf `PackError`.
- **`ensureUser` fehlte vor dem Entpacken.** Sobald die id durchgereicht war,
  scheiterte der `chown` im Helfer mit "invalid user" - der User entsteht erst
  spaeter.
- **Der Aufraeum-Hinweis fehlte genau im haeufigsten Fall.** Bei "Zielordner
  existiert bereits" (dem Zustand nach einem Abbruch) nannte die Meldung weder
  `userdel` noch `rm -rf`.

### Nicht geaendert (Befund war falsch)

`D318`, `A03`, `C201`, `C202`, `D122` - nachgeprueft und widerlegt. Bei `C202`
wurde `rm()` gegen echte Symlinks getestet: es loescht den Link, nicht das Ziel.

## [1.1.91] - 2026-10-30

### Behoben

- **Privilegien-Fehler beim `ExecStop` der Units.** Die Unit-Vorlage schrieb
  `ExecStop=... $(cat /opt/game-armory/data/<id>-rcon.password)` - im
  systemd-Kontext ist `$(...)` eine Leer-Expansion, das Passwort kam also nie an.
  `rcon-stop.mjs` liest jetzt per `--password-file <pfad>`; der alte
  Positionsparameter bleibt als Rueckfall, damit bestehende Units weiter laufen.

- **`eula.txt` konnte bei der Erstinstallation nicht geschrieben werden.** Die
  Datei entstand per direktem `writeFile` im Arbeitsverzeichnis, das dem
  Service-User gehoert (`700`). Die Armory laeuft als `armory` und bekam EACCES -
  und zwar erst NACH dem Schreibversuch, also mitten in der Installation. Der
  Schreibvorgang laeuft jetzt ueber den Install-Helfer (`write-file`), wie es
  `writeRconPassword` schon tat.

- **Loeschpfad in `uploads.js` ungeprueft.** `deleteUpload` reichte `meta.path`
  woertlich an `rm()`. Die Metadaten liegen im selben Verzeichnis wie die
  Uploads; ein `../..` darin haette jede Datei geloescht, die `armory` loeschen
  darf. Jetzt muss der Pfad innerhalb von `UPLOADS_DIR` liegen, sonst bleibt die
  Datei liegen und nur die Metadaten werden entfernt (mit Log-Zeile).

- **`requireRole` war fail-open bei unbekannter Rolle.** `ROLE_LEVEL[user.role]`
  ergab fuer eine Rolle ausserhalb der Liste `undefined`; `undefined < 3` ist
  `false`, die Anfrage ging also DURCH. Eine Rolle aus Altbestand nach einer
  Umbenennung oder eine manipulierte DB-Zeile bekam damit jedes Recht. Jetzt gilt:
  unbekannte Rolle oder unbekannte Mindestrolle -> `403` plus Log-Zeile.

- **Rechte-Matrix wurde nach einem Downgrade still zurueckgebaut.** Stand in der
  DB eine neuere Seed-Version als der Code kennt, lief der Seed erneut und setzte
  die Matrix auf den alten Stand - Betreiber-Aenderungen gingen ohne Warnung
  verloren. Eine neuere DB-Version wird jetzt nicht mehr angefasst; es gibt eine
  Log-Zeile und einen Hinweis, die neuere Version zu verwenden.

### Geaendert

- **Abgebrochene Installationen nennen jetzt die zwei Handgriffe.** Scheitert eine
  Installation, nachdem Service-User und Zielordner angelegt wurden, blieben beide
  liegen und der naechste Versuch brach an "Zielordner existiert bereits" ab. Das
  Panel loescht bewusst nicht selbst (`rm -rf` als root ueber das Panel ist mehr
  Risiko als Nutzen) - es nennt stattdessen `userdel` und `rm -rf` mit den
  konkreten Werten.

- **Einheitliche Umlaute in der Oberflaeche.** `ue`/`ae`/`oe` sind in `app.html`
  und `app.js` durch echte Umlaute ersetzt (Wortliste statt Suchen-und-Ersetzen,
  damit IDs, CSS-Klassen und JS-Schluessel unberuehrt bleiben).

## [1.1.8] - 2026-10-26

### Behoben

- **Steam-Installationen brachen nach dem Download ab.** In
  `installFromSteam` standen drei Zeilen, die `fileVersion` benutzten - eine
  Variable, die es nur in `installFromCurseForge` gibt. Jeder Steam-Install
  lief damit in einen `ReferenceError`, nachdem SteamCMD schon geladen hatte.
  Steam-Racks haben keine CurseForge-Version; die Felder stehen jetzt bewusst
  auf `null` statt geraten.
- **Installationen aus einer URL warfen sofort.** `installRoutes.js` rief
  `downloadGithubAsset` und `installFromTarball` auf, importierte beide aber
  nie. Der Fehler kam als `ReferenceError: downloadGithubAsset is not defined`.
- **Backups scheiterten an `EACCES`.** `createBackup` legte
  `<workingDir>/backups` mit einem direkten `mkdir` an. Unter einem
  Instanz-Verzeichnis gehoert der Baum dem Instanz-User, `armory` darf dort
  nicht anlegen. Das Anlegen laeuft jetzt ueber den Helfer (`mkdir-tree`), der
  in einem Schritt auch den Eigentuemer setzt.

### Sicherheit

- **Servernamen mit Steuerzeichen werden abgewiesen.** Der Name landet in der
  systemd-Unit (`Description=` und die Kommentarzeile davor). Ein
  Zeilenumbruch haette dort echte Direktiven angelegt, etwa
  `ExecStartPre=/bin/sh -c ...`. `validateInstallInput` prueft jetzt den
  Zeichenbereich `\x00-\x1f` und `\x7f`; Umlaute und normale Sonderzeichen
  bleiben zulaessig.

### Hintergrund

Alle vier Fehler stammen aus einem Code-Audit (drei Modelle, drei Linsen,
Zitatpflicht: 84 Befunde, davon 13 als KRITISCH gemeldet). Nur fuenf hielten
der Pruefung am Code stand - die uebrigen waren geratene Zeilennummern oder
Annahmen ueber Dateien ausserhalb des Pruefumfangs.

## [1.1.7] - 2026-10-25

### Behoben

- **Das Selbst-Update starb am Neustart des eigenen Dienstes und meldete
  deshalb nichts.** Der Helfer laeuft als Kind des Panels in dessen cgroup;
  die Unit hat `KillMode=control-group` (systemd-Standard), also trifft
  `systemctl restart game-armory` per SIGTERM die ganze Prozessgruppe - den
  Helfer mit. Das Update lief durch, das Panel antwortete, aber
  `last-result.json` behielt den Stand des Trockenlaufs davor und der
  Browser zeigte 502.
  Der Neustart laeuft jetzt in einer transienten Unit (`systemd-run`,
  eigene cgroup); der Rollback nutzt denselben Weg.

## [1.1.6] - 2026-10-25

### Behoben

- **"Trockenlauf pruefen" hat ein echtes Update gefahren.** Das Panel rief
  den Helfer mit `DRY_RUN=1` in der Umgebung auf; `sudo` laeuft mit
  `env_reset` und reicht die Variable nicht durch. Der Helfer las
  `dry_run=0` und startete den Dienst neu. Trockenlauf ist jetzt ein eigener
  Schritt (`dry-run <tag>`), dessen Argument sudo ueberlebt.
- **Trockenlauf legte eine Sicherung an.** 788 KB pro Klick, die beim
  naechsten Update ohnehin ueberschrieben wurden. Entfaellt jetzt; das
  `backup`-Feld bleibt leer statt auf eine nicht existierende Datei zu zeigen.
- **Das Aufraeumen loeschte das Lauf-Protokoll.** `rm -rf <verzeichnis>/*`
  nahm auch `last-run.log` und `last-result.json` mit - die Logzeilen bis
  dahin waren weg. Es werden nur noch `before-*.tar` entfernt.

### Hinzugefuegt

- Der Helfer schreibt jede Logzeile zusaetzlich nach
  `.self-update-backup/last-run.log`. Beim Selbst-Update stirbt die
  Verbindung des Panel-Prozesses, seine Ausgabe ist danach nicht mehr
  auffindbar - bei der Fehlersuche fehlte deshalb jede Spur.

## [1.1.5] - 2026-10-25

### Behoben

- **Erfolgsmeldung des Selbst-Updates ging beim Aufraeumen verloren.**
  Das Update lief durch, aber es entstand keine Ergebnisdatei. Ursache:
  im Erfolgszweig stand `rm -rf` vor dem Melden; greift das Glob ins Leere,
  gibt `rm` Status 1 zurueck und `set -e` beendet den Helfer vorher.
  Melden und Besitz-Rueckgabe laufen jetzt vor dem Aufraeumen.
- **Sicherung des Vorzustands bleibt 24 h liegen.** Vorher wurde sie sofort
  nach dem Neustart geloescht - eine Woche spaeter war sie nicht mehr da.
  Die neueste Sicherung wird nie automatisch entfernt.

## [1.1.4] - 2026-10-25

### Behoben

- **Selbst-Update meldete nach dem Neustart einen Fehler, obwohl es lief.**
  Der Helfer startet den Dienst neu, die HTTP-Verbindung stirbt und der
  Browser zeigte 502. Das Ergebnis liegt jetzt zusaetzlich als JSON vor
  (`.self-update-backup/last-result.json`) und wird beim Oeffnen des
  Update-Tabs angezeigt - auch fuer die Fehlerfaelle Rueckrollung,
  fehlgeschlagene Rueckrollung und Trockenlauf.

### Geaendert

- Die privilegierten Helfer liegen im Repo unter `tools/`.
  `tools/install-helpers.sh` kopiert sie nach `/usr/local/bin`
  (bewusst Kopie statt Symlink, damit sich der laufende Helfer waehrend
  eines Updates nicht selbst unter den Fuessen wegzieht).

## [1.1.3] - 2026-10-25

Bugfix-Release.

### Behoben

- **Frische Installation war unbrauchbar:** `users.email` fehlte im Schema,
  `auth_tokens` wurde nirgends angelegt. Bestandsdatenbanken liefen nur, weil
  beides historisch vorhanden war. Migration jetzt generisch.
- **Eigenes Passwort aendern liess fremde Sitzungen gueltig** - der Wechsel war
  damit wirkungslos gegen eine gestohlene Sitzung. Die eigene bleibt bestehen.
- **Eigene E-Mail im Konto-Tab unsichtbar:** `getSessionUser`/`verifyLogin`
  gaben das Feld nicht weiter.
- **Moderatoren/Admins konnten einen gestoppten Server nicht starten**
  (Stoppen und Neustart waren erlaubt). Seed-Version 5.
- **Sword-Diagnose meldete "keine Fehler" bei unlesbarem Verzeichnis.**
- **Verlorene Aenderungen bei gleichzeitigen Sword-Schreibzugriffen:**
  die vier Setter laufen jetzt unter einer Sperre.
- **Rack mit abweichender id im Inhalt:** `loadRacks` prueft jetzt gegen den
  Dateinamen.
- **Verwaistes Upload-Archiv** bei fehlgeschlagenen Metadaten wird mitgeloescht.
- **`setTargetVersion`/`setSwordProjectId` gaben `undefined` zurueck** und
  warfen im Panel `Cannot read properties of undefined`.

### Hinweise

- Die Standard-Rechte sind nur die Startbelegung; Aenderungen aus dem Panel
  bleiben unangetastet.

## [1.1.1] - 2026-10-23

Sicherheits-Release. Zwei offene Punkte aus 1.1.0 abgeschlossen.

### Added

- **Pruefung neuer Passwoerter gegen bekannte Datenleaks** (Have I Been Pwned,
  k-anonymity-API). Es werden nur die ersten 5 Zeichen des SHA-1-Hashes
  uebertragen, das Passwort verlaesst den Server nie. Timeout 4 s,
  `Add-Padding: true`. Bei Netzfehler oder Zeitueberschreitung wird das
  Passwort durchgelassen und der Vorfall geloggt (**fail-open**), damit ein
  HIBP-Ausfall niemanden aussperrt.
  Neues Setting `hibp_enabled` (Standard: an, nur superuser aenderbar),
  Schalter im Panel unter Einstellungen > Passwort-Pruefung.
  Pruefreihenfolge: Laenge -> Blockliste -> Form -> Benutzername -> HIBP.
- `validatePassword()` ist jetzt `async`; `createUser`, `changeOwnPassword`
  und `setUserPassword` sowie die betroffenen sechs Route-Handler in
  `authRoutes.js` wurden entsprechend umgestellt.

### Security

- **CSP ohne `unsafe-inline` fuer Skripte.** `script-src` ist jetzt `'self'`.
  Dafuer wurden die drei Inline-Skriptbloecke in eigene Dateien ausgelagert:
  `app.html` -> `public/app.js`, `login.html` -> `public/login.js`,
  `reset.html` -> `public/reset.js`. `style-src` behaelt
  `'unsafe-inline'`, weil das Panel 56 `style="..."`-Attribute und einen
  `<style>`-Block nutzt. Damit ist der Code-Ausfuehrungspfad fuer injizierte
  `<script>`-Bloecke und `onclick`-Attribute geschlossen.
- Statische JS-Dateien werden wie HTML mit `Cache-Control: no-cache,
  must-revalidate` ausgeliefert, damit nach einem Deploy nicht altes Skript
  auf neues HTML trifft.

### Notes

- Der frueher in `server.js` behauptete Grund fuer `unsafe-inline`
  ("Panel nutzt Inline-Event-Handler") war falsch: das Panel verdrahtet alle
  Events per `addEventListener`. Die eigentliche Ursache waren die
  Inline-`<script>`-Bloecke selbst.
- `reset.html` und `login.html` sind eigene Seiten mit eigenem Skript - sie
  laden `app.js` nie. Bei CSP-Aenderungen immer alle ausgelieferten
  HTML-Dateien pruefen.

## [1.1.0] - 2026-10-22

Security-Release nach einem vollstaendigen Code-Audit (Login/Auth, SQL,
Command-Injection, Path Traversal, Uploads, XSS, Header, Abhaengigkeiten).
Kernbefund: keine SQL-Injection, keine Command-Injection, keine hartcodierten
Secrets; `npm audit` ohne Treffer. Die folgenden Punkte waren die echten Luecken.

### Sicherheit
- **Passwort-Richtlinie eingefuehrt.** Vorher wurde nur die Laenge (min. 8)
  geprueft - `12345678` war damit zulaessig. Jetzt: mindestens 10 Zeichen,
  mindestens 3 von 4 Zeichengruppen (klein/gross/Ziffern/Sonderzeichen), keine
  Ein-Zeichen-Wiederholung, Blockliste gaengiger Passwoerter, nicht der
  Benutzername. Gilt an allen fuenf Stellen (Anlegen, eigenes Aendern, Admin-Reset,
  Reset-Link, Einladung). Das Panel zeigt die Kriterien unter jedem Passwortfeld
  und faerbt sie beim Tippen gruen/rot.
- **Sicherheits-Header ueber `helmet`.** Vorher gab es keine. Neu: CSP,
  X-Content-Type-Options, X-Frame-Options, Referrer-Policy, HSTS,
  X-DNS-Prefetch-Control, X-Permitted-Cross-Domain-Policies.
- **`PUT /api/settings` schuetzt Geheimnisse.** Schluessel aus `SECRET_KEYS`
  (CurseForge-Key, Steam-Passwort, SMTP-Zugang) darf nur noch der Superuser
  setzen; normale Einstellungen bleiben bei `settings.write`. `smtp_user` wird
  jetzt ebenfalls maskiert.
- **Passwort-Reset wirft bestehende Sitzungen raus.** `setUserPassword` loeschte
  die Sessions des Nutzers nicht - eine bereits bestehende (ggf. gestohlene)
  Sitzung blieb nach einem Reset weiter gueltig.
- **Neues Recht `rack.edit`.** `PUT /api/racks/:id` hing am Anlegen-Recht
  (`rack.create`), wodurch jeder mit Anlege-Recht bestehende Racks umbiegen
  konnte (inkl. `root` und `startScript`). Bearbeiten ist jetzt getrennt.
- **Gespeichertes XSS in der Benutzerliste behoben.** `${u.username}` wurde
  unescaped in `innerHTML` eingesetzt.

### Behoben
- Ueberlange oder ungueltige Passwoerter liefern jetzt die konkrete Regel als
  Fehlermeldung statt nur "zu kurz".

### Hinweis
- Die Blockliste der Passwoerter steht doppelt: in `app/auth.js` (Server,
  verbindlich) und in `public/app.html` (nur Anzeige). Beide Stellen muessen
  gemeinsam gepflegt werden; ein Kommentar im Code weist darauf hin.
- Die CSP erlaubt `'unsafe-inline'` fuer Skripte, weil das Panel Inline-Handler
  nutzt. Das schuetzt gegen externe Skripte, nicht gegen Inline-Injection;
  sauber wird es erst mit einem Umbau auf `addEventListener`.

## [1.0.2] - 2026-10-20

### Behoben
- **Der Tag-Abgleich in `apply` lief noch ueber SSH.** `fetch_tags` war bereits
  auf HTTPS umgestellt, die Pruefung "Tag ist nicht im Remote-Repo" rief
  `ls-remote` aber weiter mit `$GIT_REMOTE` (SSH-Form) auf. Im Dienst scheiterte
  das an `ProtectHome=yes` mit "Host key verification failed"; das Update brach
  mit 502 ab. Jetzt traegt die Variable die umgeschriebene HTTPS-URL.

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
