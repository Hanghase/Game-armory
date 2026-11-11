# Changelog

Alle nennenswerten Aenderungen an der Game-Armory.
Format orientiert an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [1.7.1] - 2026-11-11

### Konsolen-Befehle und Spielerzahl im Panel

Zwei kleine Faehigkeiten, die den Server bedienbar machen, ohne sich per
SSH einzuloggen. Beide sind in diesem Stand und werden zusammen ausgeliefert.

### Konsolen-Eingabe

Der Server laesst sich bedienen, ohne sich per SSH einzuloggen.

**Konsolen-Eingabe.** Ein Eingabefeld unter der Live-Konsole. Befehle gehen
ueber RCON in den Server: `op`, `ban`, `whitelist`, `save-all`, `time set`,
`weather` — alles, was Minecraft versteht. Pfeil hoch/runter blaettert durch
die letzten 50. Die Antwort des Servers steht direkt in der Konsole.

Gesperrt bleiben `stop`, `restart` und `end`: die gehoeren dem Stop-Knopf,
weil nur er die Speicher-Wartezeit abwartet (`scripts-stop-atm10.sh`).
Ebenfalls gesperrt: `$ \ ` | ; & > <` — damit aus einem Konsolen-Befehl kein
Systembefehl wird, falls doch irgendwo eine Shell dazwischenkommt.

Recht: `sword.console.write`, nur `admin` und `superuser`. Das RCON-Passwort
liest der Helfer; das Panel sieht es nie.

### Spielerzahl auf der Karte

**Spielerzahl.** Rechts in der Statuszeile der Karte, als nackte Zahl.
Keine Namen auf der Karte — die stehen im Tooltip, sonst wird die Karte breit.
Die Farbe folgt der Auslastung: unter der Haelfte gruen, Haelfte bis fast
voll gelb, voll rot.

Zwei Wege, denn die Spiele unterscheiden sich:

- **Minecraft** ueber RCON (`list`). Liefert Zahl und Maximum.
- **7 Days to Die** ueber Telnet (`lp` = `Total of N in the game`). Das
  Maximum liefert der Befehl NICHT — es kommt aus der Config, die der Server
  wirklich laedt. Die steht im `-configfile=`-Argument der Unit, hier
  `serversettings.xml` statt `serverconfig.xml`. Wer die falsche Datei liest,
  zeigt einen Wert an, mit dem der Server nicht laeuft.

**Drei Zustaende, die nicht zusammenfallen duerfen:** `0/20` heisst gemessen,
`?` heisst Antwort unlesbar, `—` heisst nicht abrufbar. Eine 0, wo "weiss ich
nicht" gilt, waere eine Luege.

**Eine Wahrheit fuer die Anzeige.** Ob eine Karte ueberhaupt eine Zahl zeigt,
entscheidet der Server (`canCountPlayers`) und schickt es als `playerCount`
mit. Vorher entschied das Frontend selbst nach "hat ein workingDir" — das
trifft auch auf TeamSpeak und Nextcloud zu, die dann eine Zahl zeigten, auf
die die Route mit 400 antwortete: ein Strich ohne Bedeutung.

**Sicherheit Telnet.** 7d2d bindet ohne Passwort nur an das Loopback-
Interface. Der Helfer prueft das nach (`ss`) und verweigert, wenn der Port
auf `0.0.0.0` lauscht. Der Befehl steht fest im Client; der Aufrufer uebergibt
nur die Server-ID.

**Gefunden durch Tests, nicht durch Nachdenken:** `Number(null)` ist `0` —
damit haette "unbekannt" die Farbe fuer "0 Spieler" (gruen) bekommen. Jetzt
wird typstrikt geprueft.

## [1.7.0] - 2026-11-10

### Ein bestehender Dienst lässt sich übernehmen

Bisher konnte die Armory nur installieren. Ein Dienst, der schon läuft —
Nextcloud, ein zweiter Spielserver, was auch immer — hatte keinen Platz,
obwohl an ihm dieselbe Arbeit hängt: starten, stoppen, Logs, Update.

**Erkennung.** Zwei Quellen, beide live gelesen, keine geraten:

- **Docker** über `docker ps --format` mit Labels. Die Compose-Datei allein
  genügt nicht: `/root/openclaw/docker-compose.yml` deklariert zwei Dienste,
  es laufen null Container. Wer pro YAML einen Stack annimmt, meldet Geister.
- **systemd** über `systemctl list-units --type=service`. Die Ausgabe trennt
  mit Leerzeichen, nicht mit `|` — der erste Parser lieferte 0 Einheiten und
  hätte jeden Spielserver verschluckt, ohne Fehler.

Auf felsis.de: **12 Kandidaten**. Nextcloud als sicher erkannt, die elf
systemd-Dienste ehrlich als „Dienstart unbekannt“ — die Armory rät nicht.

**Fünf Prüfungen, alle müssen stimmen:** Steuerart, Arbeitsverzeichnis,
Struktur, Port, Log-Quelle. **„Unbekannt“ zählt nicht als bestanden** — drei
Zeichen in der Anzeige (✅ ❔ ❌), nicht zwei. Wer „ich weiß es nicht“ als
„in Ordnung“ darstellt, hat den Unterschied gelöscht.

**Eintragen** mit Lock, tmp+rename und Gegenprobe gegen das echte
`validateSword` — ein geschriebener Sword, den der Leser nicht akzeptiert,
wäre die schlimmere Variante von „nichts geschrieben“.

### Schließen-Kreuz in allen Fenstern

Elf Fenster hatten nur einen Text-Knopf unten. Bei einem langen Formular hieß
das: scrollen, um zu schließen. Jetzt ein ✕ oben rechts, dazu **Escape** und
**Klick auf den dunklen Rand** (aber nicht in ein Feld). Weil der Knopf vor
dem Inhalt steht, landet Tab sofort darauf.

### „Neu bauen“ und „Übernehmen“ unter einem Knopf

Oben rechts war ein Knopf „＋ Neues Sword“, daneben „↪ Übernehmen“ — zwei
Knöpfe, die dasselbe Recht brauchen und Verschiedenes tun. Jetzt ein Menü
mit beiden Wegen, nach demselben Muster wie das Kontomenü.

### Der Docker-Helfer nimmt Stack-Namen, keine Pfade

`armory-docker-ctl <stack> <aktion> [dienst] [zeilen]`. Der Stack muss aus
einer festen Tabelle kommen; der Pfad wird **nie** von der Kommandozeile
genommen. Live geprüft: `nc-redis` neu gestartet, Nextcloud antwortet vorher
und nachher mit 302, alle drei Dienste wieder `running`.

### Zahlen

534 Tests, 16 Mutationen eingebaut und alle gefangen.

## [1.6.3] - 2026-11-09

### `1.6.0` ist im CHANGELOG als nicht lauffaehig markiert

Kein Code. Nur eine ehrliche Zeile an der Stelle, wo jemand nachliest, bevor er
zurueckrollt.

`1.6.0` meldete Erfolg und tat nichts - vier Nahtstellen-Fehler im Aufrufweg,
in [1.6.1] behoben. Ein Stand, der stillschweigend nichts tut, ist schlimmer als
einer, der scheitert: man merkt es erst im Spiel.

Der Tag bleibt, wie er ist (gepusht, Historie nicht umschreiben). Aber wer
`v1.6.0` auscheckt, liest jetzt vorher, dass er das nicht will.

## [1.6.2] - 2026-11-09

### Die Versionsregel wird jetzt geprueft, nicht nur aufgeschrieben

Felix, zum zweiten Mal an einem Tag: *"nein ich will nicht solche risigen
spruenge haben bitte schau das es nicht noch einmal passiert!"*

Er hat recht, und der Grund ist unangenehm: die Regel **stand** schon
geschrieben (`GAME-ARMORY-NOTES.md`, "Release-Nummern"), und ich habe sie
danach trotzdem zweimal gebrochen. `1.6.0` wurde als "fertige Faehigkeit"
getaggt, obwohl sie live nie durchlief; die eigentliche Fertigstellung war
`1.6.1`, und angesagt war sie nicht.

Eine Regel, die mich nicht aufhaelt, ist keine. Also:

**`tests/versionssprung.test.mjs`**

| Sprung | erlaubt? |
|---|---|
| `1.6.0` -> `1.6.1` | ja (eine Korrektur) |
| `1.5.8` -> `1.5.81` | ja (Nachkomma, Felix' Form) |
| `1.5.84` -> `1.6.0` | ja, **nur mit Ansage** im Commit davor |
| `1.6.0` -> `1.6.5` | nein - fuenf Patches |
| `1.5.8` -> `1.6.1` | nein - zwei Stellen in einem Schritt |
| `1.5.84` -> `1.7.0` | nein - zwei Nebenstellen |

Geprueft an **zwei** Stellen, weil die erste Luecke hatte:

1. **Tag-Kette** - was schon ausgeliefert ist.
2. **Arbeitsversion gegen den juengsten Tag** - hier entsteht der Sprung. Ohne
   diese zweite Pruefung blieb `1.6.1` -> `1.6.9` gruen; live nachgemessen.

Der pre-push-Hook ruft `npm test` und bricht damit bei einem Sprung ab.
Nachgemessen mit genau diesem Fehler: Hook sagt *"Push abgebrochen - die Tests
sind rot"*.

Die Altlasten (`1.1.8`->`1.1.92`, `1.3.57`->`1.3.60`, `1.3.60`->`1.3.70`,
`1.5.4`-`1.5.8`, `1.6.0`->`1.6.1`) stehen einzeln **mit Grund** im Test - sie
verschwinden nicht, aber ein neuer Verstoss kann nicht in einer pauschalen
Ausnahme untertauchen.

### Die Reihenfolge, die mich haette aufhalten muessen

1. Erst fertig machen - sie laeuft, **live gesehen**.
2. Dann ansagen: *"das wird X.Y.0, weil ..."*.
3. Dann bumpen und taggen.

Steht jetzt auch in `AGENTS.md`, nicht nur in den Projektnotizen.

Dieser Release ist `1.6.2` - ein Patch, wie es sich gehoert.

## [1.6.1] - 2026-11-09

### Einsetzen lief nicht - vier Fehler, alle erst live gefunden

Nach 1.6.0 antwortete die Route `ok:true`, und **nichts passierte**. Alle 21
Tests waren gruen. Das ist die Sorte Fehler, die kein Quelltext-Test findet:
die einzelnen Bausteine stimmten, die Nahtstellen nicht.

**1. Der Router war nicht abgesichert.** Ein Fehler im Handler gab **kein Byte**
zurueck - kein 500, kein Text, curl stand 20 Sekunden. `installRouter` wird per
`wrapRouter()` geschuetzt, `arsenalRouter` nicht. Express 4 faengt abgelehnte
Promises in async-Handlern nicht ab.

**2. `getSwords` war nicht importiert.** Nach dem Fix kam `500 / getSwords is
not defined`. Die Funktion gibt es, der Import fehlte.

**3. Der Arbeitsordner stand am falschen Ort.** Ich las `schwert.workingDir`;
die Sword-Datei hat `control.workingDir`. Immer `undefined` - jeder Auftrag
endete mit `bad-arbeitsverzeichnis` und sah nach einem Eingabefehler aus.

**4. Die Armory schickte die Felder nicht mit.** `frageArsenal()` baute die
Nachricht fest als `type:'command'` mit nur `action, service, pullId, swordId`.
`quelle`, `teile` und `arbeitsVerzeichnis` fielen unter den Tisch, und weil
`einsetzen` inzwischen in der Agenten-Whitelist steht, lief der Auftrag als
Dienstbefehl ins Leere: Log "Befehl: einsetzen", dann Stille.

Dazu: der Agent meldet unter `einsetzen-fertig` / `einsetzen-abbruch`, die
Armory wartete aber nur auf `type:'result'` - jeder erfolgreiche Lauf waere in
einen Timeout gelaufen und haette "Arsenal antwortet nicht" gezeigt.

Und: `auftraege.starte(id, art)` gibt es nicht. Die Liste hat
`anlegen({ art, titel })`. Der Aufruf warf, der catch verschluckte es.

### Live belegt (Test-VM, echter Weg ueber die Leitung)

```
alt.jar (ALTE-WELT)  ->  ersetzt durch beispiel.jar
Sicherung: backups/vor-einsetzen-....tar.gz
  darin: mods/alt.jar mit "ALTE-WELT", server.properties
```

Der Agent loggte: angekommen, Pruefung ok, Sicherung angelegt, eingesetzt.

### Was jetzt pruefbar ist

- **jeder** Router wird gewrappt (nicht nur der, an den man denkt)
- aufgerufene Funktionen in Routern sind importiert
- der Arbeitsordner kommt aus `control.workingDir`
- `frageArsenal` schickt `quelle`, `teile`, `arbeitsVerzeichnis`
- `einsetzen` geht als eigener Nachrichtentyp, nicht als `command`
- `einsetzen-fertig/-abbruch` loesen das Warten auf
- `setzeEin` benutzt `anlegen()` statt eines erfundenen `starte()`

453 Tests, alle gruen.

## [1.6.0] - 2026-11-09

> **Dieser Stand lief nicht.** Die Faehigkeit war gebaut, die Tests gruen, die
> Route antwortete `ok:true` - im Spielverzeichnis passierte nichts. Vier
> Nahtstellen-Fehler machten den Aufrufweg unbrauchbar; sie sind in
> [1.6.1] behoben. Wer auf `v1.6.0` zurueckrollt, rollt auf einen Stand, in dem
> "Einsetzen" **nichts tut, aber Erfolg meldet** - schlimmer als ein Fehler.
>
> Diese Markierung steht hier, weil mir `1.6.0` als "fertig" durchging, bevor
> der Weg je gegangen war. Nicht rueckwirkend umbenannt (der Tag ist gepusht),
> aber ehrlich markiert.

### Einsetzen: aus dem entpackten Pack wird der Sword im Spielverzeichnis

Felix: *"ja bitte"* auf die Frage, ob das Einsetzen gebaut werden soll. Bis
hierher endete der Weg beim Entpacken: das Pack lag unter
`packs/entpackt/armory-pack-XXXX`, der Sword unter `/opt/minecraft/<id>` bekam
davon nichts.

**Reihenfolge ist Teil der Sicherheit, nicht Beiwerk:**

1. **Sicherung** (`backup-tar`) der vorhandenen Ordner nach `backups/`
2. erst dann ersetzen (`replace-pack` je Teil)
3. melden, mit dem Pfad der Sicherung

Scheitert Schritt 1, wird **nicht** kopiert. Lieber kein Update als eine Welt
ohne Rueckweg. Auf der Test-VM belegt: Sicherung auf unschreibbarem `backups/`
-> `ok:false` -> Datei unveraendert ("URALT").

**Was geprueft wird:**

| Feld | Regel |
|---|---|
| Quelle | MUSS unter `packs/entpackt/` liegen, kein `..`-Ausbruch |
| Arbeitsordner | unter `/opt/minecraft`, `/opt/7d2d`, `/opt/teamspeak6`, `/opt/satisfactory` — und **genau eine Ebene** tief (`/opt/minecraft` selbst ist der Elternordner aller Swords) |
| Teile | Eintraege im Pack, nie Pfade; kein `..`, kein `/`, max. 40 |
| Sword | wie beim Install (`[a-z0-9-]`, mind. 2 Zeichen) |

Der Arbeitsordner kommt von der Armory (aus der Sword-Datei), **nicht** aus dem
Request — sonst waere die Route eine Weiterleitung beliebiger Pfade an einen
root-Helfer.

### Zwei Fehler, die nur live zu finden waren

**1. `cfg.swords` gibt es nicht.** Mein erster `setzeEin` las den Arbeitsordner
aus `ladeConfig().swords` — `arsenal.json` hat aber nur `id`, `key`, `url`.
Jeder Auftrag waere mit "unbekannter-sword" abgebrochen. Kein Test wurde rot,
weil er nur den Quelltext las.

**2. Der Helfer lehnte sein eigenes Packverzeichnis ab.** `replace-pack`
erlaubte als Quelle nur `/tmp` — `einsetzen` liest aber bewusst aus
`packages/entpackt/` (der Agent hat `PrivateTmp=yes`, sein `/tmp` verschwindet
mit dem Dienst). Zwei richtige Entscheidungen, die zusammen nicht funktionieren:

```
Quelle muss unter /tmp liegen: /var/lib/armory-arsenal/packs/entpackt/armory-pack-k79c40/mods
```

Der Helfer liegt jetzt **im Repo** (`agent/armory-install-helper`), damit diese
Absprache pruefbar ist. Vorher war er nur installiert — genau deshalb konnte
niemand den Widerspruch sehen.

### Schwache Tests, selbst gefunden

- Ein Test prueft `globalThis.__runQuelle` — nie gesetzt, also gruen ohne zu pruefen.
- Einer prueft nur die **Reihenfolge** im Quelltext, nicht dass ein Sicherungs-
  fehler wirklich abbricht (Mutation "if (!sich.ok)" -> "if (false && !sich.ok)"
  blieb gruen).
- Einer pruefte `'..'` in Teilnamen, aber die uebrigen Regeln schlugen zufaellig
  schon zu; erst ein Name wie `mods..old` deckte die Luecke.
- Ein Arbeitsordner **unter** dem Sword (`/opt/minecraft/atm11/mods`) wurde
  durchgelassen — kein Test schickte so einen Pfad.

### Getestet

**Live auf der Test-VM, echter Weg:** alter Inhalt `ALTE-WELT-DATEI`, Sicherung
angelegt, `replace-pack` ersetzt `mods/` durch `beispiel.jar`, und in der
Sicherung liegt nachweislich `mods/alt.jar` mit `ALTE-WELT-DATEI`. Nicht
ersetzte Dateien (`server.properties`) blieben unberuehrt.

20 neue Tests, 443 gesamt. 13 Mutationen, alle gefangen.

### Panel

Knopf **Einsetzen** in der Arsenal-Zeile, Felder *Quellordner* und *Teile*.
Keine Rueckfrage "wirklich ueberschreiben?" — die Sicherung ist der Rueckweg,
und eine Rueckfrage, die immer mit Ja beantwortet wird, erzieht dazu, sie
wegzuklicken.

## [1.5.84] - 2026-11-09

### Die Sword-Karte zeigt, auf welchem Arsenal der Sword liegt

Felix: *"aktuell sehe ich in der Sword übersicht nicht ob ein Sword auf einem
Arsenal liegt"*. Berechtigt - bis hierher konnte sie es auch nicht: **ein
Sword kannte gar kein Arsenal**. Alle lagen lokal auf der Armory.

Jetzt:

- **Loader** liest `arsenal` aus der Sword-Datei und prueft es: nur eine
  positive ganze Zahl gilt. Alles andere wird mit Hinweis verworfen. Fehlt
  das Feld, bleibt der Sword **lokal** - bewusst ohne `arsenal: 0` und ohne
  `unbekannt`. Beides waere eine Angabe, die niemand gemacht hat.
- **Karte** zeigt neben der Version ein ruhiges blaues Abzeichen
  `Arsenal: Main` (Name) bzw. `Arsenal #6` (Kennung, wenn die Liste nicht
  abrufbar ist). Blau, nicht rot: es ist ein Ort, keine Warnung.
- **Namen** werden vor dem Zeichnen geladen, damit beim ersten Bild nicht
  "Arsenal #6" steht.

### Zwei schwache Tests, beide selbst gefunden

**1. Ein Test war grün ohne zu prüfen.** Er las `public/style.css` - die es
nicht gibt (das CSS steht inline in `app.html`). Wegen `if (!css) return` war
er bei fehlender Datei automatisch bestanden. Jetzt liest er `app.html`.

**2. Ein Test war zu weich.** "Lokaler Sword zeigt kein Abzeichen" suchte nur
irgendein `arsenal` im Ausschnitt. Die Mutation `${sword.arsenal ? ...}` ->
`${true ? ...}` blieb damit grün - und haette an allen 15 lokalen Karten ein
leeres Abzeichen erzeugt. Jetzt prueft der Test die genaue Bedingung.

### Getestet

8 neue Tests, 423 gesamt. 5 Mutationen, 5 gefangen (nach der Haertung).

## [1.5.83] - 2026-11-09

### Fehler: `mktemp` legt keine Elternordner an

Live nach 1.5.82:

```
install atm11: fehlgeschlagen - mktemp: failed to create directory via
template '/var/lib/armory-arsenal/packs/entpackt/armory-pack-XXXXXX':
No such file or directory
```

Kleine Ursache, ehrliche Meldung. Behoben: `extract-pack` legt das feste Ziel
an, wenn es fehlt - **nach** der Rollenpruefung, damit eine Armory den Ordner
nicht anlegt. Angelegt wird nur das feste Verzeichnis, nie ein Pfad aus dem
Befehl.

### Getestet

1 neuer Test, 415 gesamt. Er prueft die REIHENFOLGE: `mkdir` muss nach der
Rollenpruefung stehen. Eine Mutation, die es davor setzt, wird rot.

## [1.5.82] - 2026-11-09

### Fehler: das Pack-Ziel war dem Helfer unbekannt

Nach 1.5.81 live:

```
install atm11: fehlgeschlagen - Ziel ausserhalb der Roots:
/var/lib/armory-arsenal/packs/entpackt
```

Der Helfer prueft korrekt - er kannte das Verzeichnis nur nicht. Der
naheliegende Fix waere gewesen, es in `ALLOWED_ROOTS` einzutragen. **Das waere
falsch:** dann duerften `mkdir-tree`, `chown-tree`, `backup-tar` und
`prune-backups` ploetzlich dort arbeiten - eine Tuer, die niemand braucht.

Statt dessen: eigener Zweig im `extract-pack`, gebunden an
`ARMORY_ROLLE=arsenal`. Auf einer Armory bleibt der Pfad gesperrt.

### Getestet

3 neue Tests, 414 gesamt. Ein Test prueft ausdruecklich, dass das Pack-Ziel
NICHT in `ALLOWED_ROOTS` steht - er faengt genau den naheliegenden falschen
Fix. Eine Mutation, die es dort eintraegt, wird rot.

## [1.5.81] - 2026-11-09

### Fehler: das entpackte Pack lag in einem privaten `/tmp`

Live auf der VM. Der Agent meldete `install atm11: entpackt nach
/tmp/armory-pack-zAiNmD` - und **eine Sekunde spaeter war der Ordner weg**.
Der Benutzer war da, die ZIP war da, der Erfolg stand im Log, das Ergebnis
nicht.

**Ursache:** die Unit hat `PrivateTmp=yes`. Der Agent sieht ein eigenes
`/tmp`, das mit dem Dienst verschwindet. Beim naechsten Neustart waere der
entpackte Sword weg gewesen - ohne Fehlermeldung, ohne Hinweis.

Der Helfer war unschuldig: von Hand aufgerufen lag der Ordner da, gehoerte
`atm11:atm11`, Inhalt vollstaendig.

**Behoben:**

- `extract-pack` nimmt ein Zielverzeichnis als drittes Argument (Vorgabe
  bleibt `/tmp` fuer die Armory). Geprueft wie jede andere Quelle: nur unter
  erlaubten Roots, kein Symlink.
- Der Agent uebergibt `PACK_ORDNER` = `/var/lib/armory-arsenal/packs/entpackt`.
- Das Log sagt jetzt `(bleibt bestehen)`, damit der Unterschied sichtbar ist.

### Warum das so spaet auffiel

Drei Fehldiagnosen hintereinander: ich hielt den Ordner fuer aufgeraeumt, dann
fuer einen `tmpfiles`-Effekt, dann fuer ein Rechteproblem. Erst als ich den
Helfer **von Hand** rief und der Ordner stehenblieb, war klar: der Agent ist
der Unterschied, nicht der Helfer - und der Unterschied ist `PrivateTmp`.

Merksatz fuer spaeter: **Erfolg im Log ohne Ergebnis auf der Platte ist kein
Erfolg.** Nachsehen, nicht der Meldung glauben.

### Getestet

2 neue Tests, 411 gesamt. Der Test prueft, dass der Aufruf ein festes
Packverzeichnis uebergibt und nicht die ZIP-Datei.

## [1.5.8] - 2026-11-09

### Fehler: der Benutzer fehlte beim ersten Install

Live gemessen auf der VM, erster echter Durchlauf ueber die Route:

```
Befehl: install
install atm11: fehlgeschlagen - chown: invalid user: 'atm11:atm11'
```

Der Helfer legt **bewusst keinen** Benutzer an (Benutzerverwaltung ist mehr
als entpacken). Die Armory macht das in `installer.js` (Zeile 623) **vor** dem
Entpacken - der Agent tat es gar nicht.

**Das ist die Art Fehler, die man im Log fuer ein Rechteproblem haelt.** Die
Meldung nennt `chown`, nicht "Schritt fehlt".

Behoben: `useradd` laeuft jetzt vor `extract-pack`, ueber denselben Helfer mit
festen Argumenten. Ein bereits vorhandener Benutzer ist **kein** Fehler
(`user exists` -> Exit 0) - sonst liesse sich derselbe Sword nie neu
installieren.

### Getestet

3 neue Tests, 409 gesamt. Der Test prueft die REIHENFOLGE, nicht nur das
Vorhandensein: useradd muss vor extract-pack stehen. Eine Mutation, die die
beiden vertauscht, wird rot.

## [1.5.7] - 2026-11-09

### `install` ist im Panel erreichbar - Knopf, Felder, Route

Bis 1.5.6 konnte der Agent entpacken, aber niemand konnte es ihm sagen: die
`/command`-Route kannte `install` nicht. Der Befehl lief nur, wenn man von
Hand eine Nachricht an die Leitung schrieb.

Jetzt:

- **Route** `POST /api/arsenals/:id/command` kennt `install`, prueft es mit
  derselben Funktion wie der Agent (`validateInstall`) und reicht `pullId` +
  `swordId` weiter. Zwei Seiten, eine Pruefung.
- **Panel** hat einen Knopf "Installieren" je Arsenal plus zwei Felder
  (gezogene Datei, Sword-Name). Ohne pullId sagt es "Keine gezogene Datei -
  erst ziehen, dann installieren" statt einen 400 zu zeigen, der wie ein
  Serverfehler aussieht.
- **`frageArsenal`** schickt `pullId`/`swordId` nur, wenn sie da sind - ein
  undefined kaeme sonst als `null` beim Agenten an.
- **`fuehreAus`** hat einen `install`-Zweig: anstossen, sofort antworten.

### Zwei Fehler, die die Tests nicht gefangen haben

**1. Kommentar INNERHALB eines Arrays.** `ERLAUBTE_AKTIONEN = ['update',
'restart', // Kommentar ... 'install']` - die Tests parsen die Liste als
Text, und der Kommentar wurde zum Element `// Ein gezogenes Pack ... install`.
Zwei Tests wurden rot, obwohl der Code richtig war. Kommentar aus dem Array
gezogen.

**2. Felder im HTML vergessen.** Der Handler liest `arsenalPullId` und
`arsenalSwordId` per `getElementById` - die es nicht gab. Jeder Klick haette
"Keine gezogene Datei" gesagt. **Der Test prueft nur den JS-Quelltext und war
gruen.** Genau die Falle aus AGENTS.md ("Funktion gruen, Aufrufweg tot").
Zwei Tests nachgezogen, die im HTML nachsehen.

### Getestet

406 Tests, 19 Mutationen ueber beide Runden, alle gefangen.

## [1.5.6] - 2026-11-09

### Fehler: `install` baute den Dateipfad selbst

Gefunden, bevor der erste Sword installiert war - beim Aufsetzen des
Live-Tests:

```js
const ziel = `${ZIEL_WURZEL}/${p.pullId}.zip`;
```

Der Pull legt die Datei aber unter dem Namen ab, den die **Armory** schickt
(`atm11-server.zip`). Mit der pullId waere daraus
`/var/lib/armory-arsenal/packs/16d9a6bb....zip` geworden - eine Datei, die es
nie gab. Der Helfer haette `ZIP nicht lesbar` gemeldet, und die Ursache waere
zwei Ebenen tiefer gelegen.

**Ursache:** Der Pull-Eintrag in `laufendePulls` wird bei `beende()` geloescht.
Der `install` kommt aber DANACH. Also gab es keinen Ort, an dem das Ziel stand,
und der Code hat es sich ausgedacht.

**Loesung:** `gezogeneDatei` (Map pullId -> { ziel, groesse }) wird beim
erfolgreichen Abschluss des Pulls gefuellt. `install` schlaegt dort nach. Ein
unbekannter pullId liefert `nicht-gezogen` statt eines geratenen Pfads. Nach
dem Entpacken wird der Eintrag geloescht - ein zweiter install mit derselben
Kennung soll nicht stillschweigend dasselbe entpacken.

### Getestet

4 neue Tests, 393 gesamt. Der Test prueft ausdruecklich, dass der Pfad NICHT
aus der pullId gebaut wird - die Form, in der der Fehler auftrat.

## [1.5.5] - 2026-11-09

### Der Install-Weg ist FREI - mit Rollenschranke

`1.5.4` endete mit "ZIP ausserhalb erlaubter Pfade". Die Ursache war nicht
der Helfer, sondern der Pfad: `/var/lib/armory-arsenal/packs` stand nicht in
seiner Liste, weil er fuer Swords auf der **Armory** gebaut ist.

**Die Loesung oeffnet nichts fuer alle.** Der Arsenal-Pfad ist an
`ARMORY_ROLLE=arsenal` gebunden. Fehlt die Variable, gilt Armory - und der
Pfad bleibt gesperrt. Eine fehlende Kennzeichnung darf keine Tuer oeffnen.

Ausserdem:

- Die Pfadliste stand **zweimal** im Code (`extract-pack`, `extract-tarball`).
  Jetzt eine Funktion `ist_archiv_quelle()` - zwei Kopien derselben Pruefung
  sind eine Falle, wer eine aendert vergisst die andere.
- Der Pack-Ordner darf kein Symlink sein (sonst zeigt der erlaubte Praefix
  auf ein Ziel ausserhalb).
- Vorlage `agent/arsenal-rolle.conf` liegt im Repo; die Unit-Setzung geht
  damit nicht mehr verloren.

### Zweiter Befund: `unzip` fehlt auf dem Arsenal

Die Armory hat es, ein minimales Debian nicht. Statt auf jedem Kundenserver
ein Paket nachzuinstallieren: Rueckfallebene ueber `python3 -m zipfile`.

Nachgelesen im Quelltext (`zipfile.py`, `_extract_member`): `..` und `.`
werden aus jedem Pfadanteil entfernt, **bevor** der Zielpfad zusammengesetzt
wird; danach `os.path.normpath`. Nachgemessen mit einem praeparierten Archiv -
`../../etc/boese.txt` landete als `<ziel>/etc/boese.txt`, nichts brach aus.

Der Wechsel wird **gemeldet**, nicht stillschweigend benutzt:

```
Hinweis: unzip fehlt, entpacke mit python3 -m zipfile
```

Fehlen beide Werkzeuge, bricht es mit eigenem Code 127 ab.

### Live gemessen

| Pruefung | Ergebnis |
|---|---|
| Ohne Rolle auf Arsenal-Pfad | Exit **2** (gesperrt) |
| Mit Rolle auf Arsenal-Pfad | Exit 1 (frei, nur Benutzer fehlte) |
| Mit Rolle auf `/etc/passwd` | Exit **2** (gesperrt) |
| `useradd` | `useradd ok atm11` |
| `extract-pack` | `unzip: command not found` -> python3 noetig geworden |

### Getestet

11 Tests fuer Helfer und Rolle, 389 gesamt. 9 Mutationen, alle 9 gefangen:
Rolle entfernt, Vorgabe auf arsenal gedreht, Symlink-Pruefung weg,
Tarball-Pruefung weg, Pfadliste verdoppelt, unzip-Zweig weg, Meldung weg,
Abbruch ohne Werkzeuge weg, als root statt Instanz-User entpackt.

## [1.5.4] - 2026-11-09

### Neu - der `install`-Befehl (Entpacken), aber noch nicht benutzbar

Der Agent versteht jetzt `{ type:'install', pullId, swordId }` und ruft
`armory-install-helper extract-pack` mit **festen Argumenten** auf - keine
Shell, kein Pfad aus dem Netz, Name gegen `^[a-z0-9][a-z0-9-]{1,31}$`.

**Der Weg ist absichtlich NICHT freigegeben.** Beim Live-Versuch zeigte sich:

```
ZIP ausserhalb erlaubter Pfade
```

Der Helfer akzeptiert nur `/tmp/*` und `/opt/game-armory/data/uploads/*`.
Der Pack-Ordner des Arsenals (`/var/lib/armory-arsenal/packs`) steht nicht
darin - und `/opt/game-armory` gibt es auf einem Arsenal gar nicht. Der
Helfer ist fuer **Swords auf der Armory** gebaut, nicht fuer ein Arsenal.

Haette ich die Pfadliste einfach erweitert, waere eine echte Schranke
gefallen. Darum steht hier die Diagnose statt eines Schnellschusses.

### Was ein Sword auf einem Arsenal braucht

| Schritt | Kann der Helfer es? |
|---|---|
| Systembenutzer anlegen | ja (`useradd`) |
| Ordner anlegen | ja (`mkdir-tree`) |
| ZIP entpacken | ja, **aber** Pfad nicht erlaubt |
| systemd-Unit schreiben | ja (`write-unit`) |
| Rechte setzen | ja (`chown-tree`) |

Was fehlt, ist nicht der Helfer, sondern **die Reihenfolge**. Die macht heute
`app/installer.js` (1727 Zeilen) - und das laeuft auf der Armory, nicht auf
dem Arsenal. Ein Arsenal hat diesen Code nicht.

### Getestet

- 10 neue Tests fuer die Befehlspruefung, 378 gesamt.
- 5 Mutationen, 4 gefangen. Die fuenfte deckte auf, dass eine
  Zusatzpruefung (`includes('/')`) **toter Code** war - die Regex laesst
  weder `/` noch `.` durch. Der Test dazu waere nie rot geworden. Toter Code
  durch einen Hinweis ersetzt, damit niemand ihn fuer eine Schranke haelt.
- Eine zweite Luecke: der Test fuer den Verteiler fehlte ganz. Ohne ihn
  haette `install` hinter `validateCommand` landen koennen - Funktion gruen,
  Aufrufweg tot.

## [1.5.3] - 2026-11-09

### Behoben - dasselbe Stueck wurde zweimal geschickt

Nach 1.5.2 kam der Pull nicht mehr zum Absturz, aber das Arsenal lehnte ab:

```
Stueck abgelehnt (schon-da) bei Offset 589824
```

**Derselbe Fehler wie beim Agenten - nur auf der anderen Seite.**
`sendeWeiter()` ist `async` und wird von `bereit` UND von jeder
`stand`-Quittung aufgerufen. Liefen zwei gleichzeitig, lasen beide
`pull.gesendet`, bevor einer es hochzaehlt - und schickten dasselbe Stueck
nochmal. Der Agent hat richtig abgelehnt und abgebrochen; falsch war der
Sender.

Jetzt haengt auch die Sendeseite an einer **Warteschlange je Pull**
(`senderKette`), und die Kette wird bei Abschluss **und** Abbruch geloescht.

### Die Lehre

Ich habe den Fehler beim Agenten gefunden und behoben - und auf der
Sendeseite **dieselbe Stelle nicht angesehen**. Die Pruefung lautet
"parallel auf denselben Zustand zugreifen" und galt fuer beide Seiten.
Zweimal derselbe Fehler in einer Stunde, weil ich beim Suchen bei der
Fundstelle aufhoere.

2 neue Tests; die zweite Mutation deckte auf, dass ein blosser
Vorkommens-Zaehler (`>= 2`) auch **dieselbe** Funktion zweimal akzeptiert
haette - der Test prueft jetzt jede Aufraeumfunktion einzeln.

368 Tests gesamt gruen.

## [1.5.2] - 2026-11-09

### Behoben - der Agent stuerzte beim Ziehen ab

Nach 1.5.1 kam der Pull weiter, aber der Agent **startete sich selbst neu**:

```
Error [ERR_STREAM_DESTROYED]: Cannot call write after a stream was destroyed
  at nimmStueck (agent/transferRun.js:76:9)
  at nimmDateistueck (agent/run.js:243:21)
  ...
systemd: Scheduled restart job, restart counter is at 2
```

Jedes Mal 589824 Bytes, dann Neustart, dann von vorn - eine Endlosschleife,
die wie ein haengendes Netz aussieht.

**Zwei Ursachen:**

1. **Parallele Schreiber.** `ws` ruft den `message`-Handler fuer JEDE
   Nachricht auf, ohne auf den vorigen zu warten. Zwei Stuecke, die schneller
   kommen als das Schreiben dauert → zwei gleichzeitige `write()` auf
   denselben Strom → `ERR_STREAM_DESTROYED`.
2. **Kein `.catch`.** Ein Fehler im `message`-Handler ist unbehandelt und
   beendet den Prozess. systemd startet neu, der Pull faengt von vorn an.

Jetzt laeuft jedes Stueck durch eine **Warteschlange** (Promise-Kette), und
jeder Fehler wird abgefangen und geloggt statt den Dienst zu toeten.

### Warum das kein Test fand

Die Tests prueften `nimmStueck` einzeln - nie zwei Aufrufe gleichzeitig. Und
das ist genau das Muster, das `ws` im Betrieb erzeugt. Drei neue Tests lesen
den Quelltext des Agenten:

- die Stuecke laufen ueber `stueckKette`
- der Binaer-Zweig benutzt die Kette, nicht direkt `nimmDateistueck`
- an der Kette haengt ein `.catch`

2 Mutationen, alle gefangen.

## [1.5.1] - 2026-11-09

### Behoben - der Pull blieb nach 8 Stuecken stehen

**Live mit einer echten 6-MB-ZIP zum Arsenal:** 512 KiB kamen an, dann nichts
mehr. Auf der VM lag `atm11-server.zip.teil` mit 524288 von 6001888 Bytes.

Zwei Ursachen, die zusammen gehoeren:

1. **Der Agent quittierte nie.** Die Armory hat ein Fenster von 8 Stuecken -
   ohne Quittung weiss sie nicht, dass wieder Platz ist.
2. **Die Armory rief `quittiere()` nie auf.** Die Funktion war gebaut und
   getestet, aber der `stand`-Zweig im Verteiler fehlte.

Beides ist derselbe Fehlertyp wie `withReadiness`/`dockerStatus`:
**die Funktion ist gruen, der Aufrufer existiert nicht.** Der sechste Fall in
diesem Projekt, und diesmal habe ich ihn mir selbst gebaut, weil ich beim
Testen nur die Funktion angesehen habe.

Jetzt:
- Agent schickt `{ type:'stand', id, empfangen }` nach JEDEM Stueck -
  **vor** dem Abschluss, damit beim letzten Stueck nichts haengt.
- Armory oeffnet bei `stand` das Fenster und sendet weiter.

### Tests, die den AUFRUFER pruefen

Vier neue Tests lesen den Quelltext beider Seiten:

- die Armory hat einen `stand`-Zweig mit `quittiere(msg.id)`
- nach dem Quittieren wird `sendeWeiter(msg.id)` aufgerufen
- der Agent schickt ueberhaupt ein `stand`
- die Quittung steht **vor** `schliessePullAb`

4 Mutationen, alle gefangen - auch "Quittung nach dem Abschluss verschoben".

## [1.5.0] - 2026-11-09

### Neu - die Sendeseite der Uebertragung

Bisher konnte das Arsenal ziehen, aber niemand schickte. Jetzt die Armory:
die ZIP liegt als Upload im Panel, das Arsenal zieht sie ueber die offene
Leitung.

```
POST /api/arsenals/:id/pull   { uploadId }
  -> { pullId, gesamt, name }
```

Drei Dateien, drei Aufgaben:

| Datei | Was |
|---|---|
| `app/arsenalTransferRun.js` | Entscheidungen: welches Stueck, wann bremsen, wann haengt es |
| `app/arsenalTransferSend.js` | Platte und Leitung: lesen, senden, aufraeumen |
| `app/arsenalSocket.js` | Verteiler: `bereit`, `pull-fertig`, `pull-abbruch` |

### Warum die Route ein Upload ist und kein Pfad

Die Kennung wird ueber `readUpload()` nachgeschlagen - **ein Pfad aus dem
Request geht nie an das Dateisystem**. Sonst waere `/api/arsenals/:id/pull`
mit einem `pfad: /etc/passwd` ein Lesegerät fuer jede Datei.

### Verhalten, das bewusst so ist

- **Ohne "bereit" geht nichts raus.** Kein Stueck wird gesendet, bevor das
  Arsenal nicht selbst angefragt hat. Wer die Armory uebernimmt, kann einem
  Arsenal nichts hinschieben.
- **Die Pruefsumme wird VOR dem Senden geprueft.** Eine falsche Summe erst am
  Arsenal zu merken heisst: 2 GB umsonst uebertragen, und der Fehler sieht
  nach Netz aus statt nach Platte.
- **Fenster von 8 Stuecken.** Ohne Deckel schreibt die Schleife die ganze
  Datei in den Sendepuffer - bei 2 GB ein Speicher-Abschuss auf beiden Seiten.
- **Ein Sender rechnet mit Offset, nicht mit Stuecknummer.** Bei einer
  Wiederholung nach Abbruch waere ein Zaehler falsch.
- **Die Datei bleibt offen**, solange der Pull laeuft. Tausende Stuecke
  einzeln zu oeffnen ist der Unterschied zwischen 2 Sekunden und 2 Minuten.
- **Wird die Datei kuerzer**, bricht der Pull ab - statt dass das Arsenal ewig
  auf Bytes wartet, die nicht mehr kommen.

### Getestet

- 16 neue Tests, 359 gesamt.
- 9 Mutationen, alle gefangen - nach zwei Testfehlern:
  1. Der Ausschnitt endete am ersten `});` mitten in der Route
     (`indexOf('});')` statt bis zum naechsten Routen-Anfang).
  2. Der 404-Test akzeptierte `if (false) return res.status(404)` - er prueft
     jetzt, dass der 404 an `!upload` haengt, nicht nur dass er vorkommt.

## [1.4.25] - 2026-11-09

### Behoben - ein Fehler, den nur der Live-Lauf zeigte

**Der Agent verwarf jeden `pull`-Befehl.** Die Leitung sagte "hol diese
Datei", der Agent antwortete im Log:

```
Stueck mit unmoeglicher Laenge verworfen (1885676090 bei 192 Bytes)
```

Die Pruefung im Verteiler lautete:

```js
if (istBinaer || Buffer.isBuffer(data)) { ... }
```

**`ws` liefert JEDE Nachricht als Buffer - auch JSON.** `Buffer.isBuffer(data)`
ist damit immer `true`, und der Zweig fuer Dateistuecke schluckte jede
Steuernachricht. Der `pull`-Befehl wurde nie gelesen, sondern als Stueck
interpretiert; die ersten vier Bytes des JSON-Textes (`{"ty`) ergaben als
Zahl eine Laenge von 1885676090.

Jetzt wird **nur** `istBinaer` geprueft. Das Flag ist die einzige
verlaessliche Auskunft darueber, ob der Frame binaer war.

### Warum kein Test das gefunden hat

Die Tests prueften die Hilfsfunktionen, nicht den Verteiler - genau die Luecke
zwischen beidem, wie beim Fall `withReadiness`/`dockerStatus`. Jetzt drei
Tests, die den **Quelltext des Verteilers** lesen:

- der Stueck-Zweig prueft **nur** `istBinaer` (faengt die Rueckkehr des Fehlers)
- `pull` wird **vor** `validateCommand` behandelt
- der Binaer-Zweig steht **vor** dem JSON-Parse

### Getestet

- 16 Tests in dieser Datei, 343 gesamt.
- 2 weitere Mutationen, beide gefangen: die alte Pruefung
  `istBinaer || Buffer.isBuffer(data)` wieder eingesetzt, und `pull` hinter
  `validateCommand` verschoben.

## [1.4.24] - 2026-11-09

### Behoben

- **1.4.23 hat den pull-Code NICHT enthalten.** Die Dateien lagen im
  Arbeitsverzeichnis, waren aber nicht im Commit: `agent/logic.js` (die
  Pruefung), `agent/run.js` (der Verteiler) und der zugehoerige Test kamen
  erst NACH dem `git add -A`. Ein Tag ohne den Code, den er ankuendigt.
  Jetzt vollstaendig drin und nachgewiesen:
  `git show v1.4.24:agent/run.js | grep -c beginnePull` ist nicht 0.

### Neu

- **Der Befehl `pull`.** Die Armory sagt "hol diese Datei" (Kennung, Groesse,
  Pruefsumme, Name), das Arsenal zieht. Danach kommen die Stuecke binaer.
  Kein base64: das waere ein Drittel mehr Verkehr und dreimal so viel
  Speicher.

  Was am Befehl geprueft wird - und jeder Punkt hat einen Test, der bei
  Lockerung rot wird:

  | Feld | Regel |
  |---|---|
  | Kennung | Hex, 8-64 Zeichen |
  | Groesse | ganze Zahl, 1 Byte bis 4 GiB |
  | Pruefsumme | sha256, 64 Hexzeichen |
  | Name | **kein** `/`, `\`, `..`, kein Punkt am Anfang, keine Steuerzeichen |
  | Ziel | **kommt nie aus dem Befehl** |

  Der letzte Punkt ist der wichtigste: ein mitgeschicktes `ziel` wird
  ignoriert, der Ordner ist fest. Sonst waere die ganze Namenspruefung
  umgehbar.

### Verhalten, das bewusst so ist

- **Stuecke tragen keine Kennung im Kopf.** 16 Bytes Verwaltung pro 64 KiB
  Stueck waeren bei tausenden Stuecken Unsinn. Solange genau ein Pull laeuft,
  ist es eindeutig. Laufen zwei, wird **verweigert statt geraten** - ein
  Stueck im falschen Ziel ist eine still kaputte Datei.
- **Ein abgelehntes Stueck bricht den Pull ab**, statt "irgendwie
  weiterzumachen".
- **Fertig wird an der Vollstaendigkeit erkannt**, nicht am Verbindungsende.
  Die Leitung bleibt fuer Befehle offen, ein `close` gibt es hier nicht.

### Getestet

- 13 neue Tests fuer die Befehlspruefung, 340 gesamt.
- 6 Mutationen, alle gefangen: Namenspruefung gelockert, mitgeschicktes Ziel
  uebernommen, Pruefsumme nicht geprueft, Groesse nicht begrenzt, Kennung
  nicht geprueft, Steuerzeichen erlaubt.

## [1.4.23] - 2026-11-09

### Neu

- **Das Arsenal ZIEHT Dateien.** Die Empfangsseite der Uebertragung steht:
  Stuecke annehmen, schreiben, Pruefsumme, umbenennen. Nicht die Armory
  schiebt - wer zieht, bestimmt das Tempo, und am Arsenal bleibt kein Port
  offen.

  ```
  agent/transfer.js       Entscheidungen: welches Stueck passt, wann fertig,
                          stimmt die Pruefsumme (15 Tests)
  agent/transferRun.js    Platte und Strom: schreiben, pruefen, aufraeumen
  ```

- **Geschrieben wird in eine .teil-Datei**, umbenannt erst nach der
  Pruefsumme. Eine halb geschriebene ZIP unter dem echten Namen sieht wie
  eine fertige aus - und wird irgendwann installiert.

### Verhalten, das bewusst so ist

- **Ein Stueck an falscher Stelle wird abgelehnt, nicht geschrieben.** Sonst
  legt ein verspaetetes Stueck Muell mitten in eine Datei, die schon fast
  fertig war.
- **Ein doppeltes Stueck wird erkannt**, nicht doppelt gezaehlt. Bei einer
  wackeligen Leitung kommt eines schon mal zweimal.
- **99 % ist nicht fertig.** Exakt am Ende, sonst nichts.
- **Falsche Pruefsumme loescht die Datei** - sie bleibt nicht als Einladung
  liegen.
- **Ein Abbruch raeumt die .teil-Datei weg.** Sonst sammeln sich halbe
  Downloads auf der Platte.

### Getestet

- 15 neue Tests. 327 gesamt.
- 11 Mutationen, alle gefangen: Luecke erlauben, doppelt zaehlen, fertig ab
  99 %, Pruefsumme immer akzeptieren, ueber das Ende lesen, fehlende Datei
  als gueltig, kaputte Datei liegen lassen, Pruefsumme nicht pruefen, kein
  Aufraeumen, falsches Stueck schreiben, unvollstaendig durchwinken.
- **Live ueber eine echte WebSocket-Leitung** (Pruefstand, 2 MB in 32
  Stuecken): 100 % uebertragen, Pruefsumme stimmt, Datei Byte fuer Byte
  identisch mit dem Original.

### Zwei Fehler, die nur der echte Durchlauf zeigte

Beide im Pruefstand, nicht im Produktivcode - aber sie haetten den
Produktivcode stumm gemacht:

1. **Deadlock nach dem ersten Stueck.** Der Sender schickte eines und wartete
   auf eine Quittung; die Quittung kam erst ab 512 KiB. Bei kleinen Dateien
   waere das NIE aufgefallen. Jetzt wird jedes Stueck quittiert.
2. **Die Datei wurde nie umbenannt.** 2 MB kamen an, Inhalt Byte fuer Byte
   identisch, aber der Abschluss hing an einem `close`-Ereignis, das nie kam.
   Eine perfekte .teil-Datei liegt jetzt nicht mehr herum: der Abschluss
   haengt an der Vollstaendigkeit, nicht am Verbindungsende.

## [1.4.22] - 2026-11-09

### Neu

- **Auftraege statt langer Befehle.** Ein Befehl darf 30 s dauern; ein Install
  dauert Minuten. Also: Auftrag anlegen, sofort antworten, Ergebnis kommt mit
  dem naechsten Lebenszeichen. Kein neuer Kanal - der Herzschlag, der
  sowieso geht, traegt es (Felix: "so verhindern wir dumme sperrzeiten").

  ```
  app/arsenalJobs.js       Auftragsliste, Zustaende, Takt
  app/arsenalTransfer.js   Stueckelung, Pruefsumme, Vollstaendigkeit
  ```

- **Der Takt haengt an der Arbeit** (Felix woertlich): "im Idle oder normalem
  Tagesgeschaeft 30 Sekunden, bei installs oder server verschieben alle 15
  Sekunden bis fertig". Umgesetzt als Kette statt `setInterval` - die
  entscheidet nach jedem Senden neu und kann nicht auseinanderlaufen.

  | Zustand | Takt |
  |---|---|
  | kein Auftrag | 30 s |
  | Auftrag offen/laeuft | 15 s |
  | fertig/fehlgeschlagen | 30 s |

  Der Takt faellt NICHT mit der Zahl der Auftraege: fuenf Auftraege fragen
  nicht alle 3 s.

### Verhalten, das bewusst so ist

- **Ein Fehlschlag ist ein eigener Zustand, nicht "fertig".** Beide bei 100 %,
  aber `fehlgeschlagen` traegt den Grund.
- **Ein Ergebnis kommt genau EINMAL.** Sonst blinkt im Panel jede Minute
  dieselbe Erfolgsmeldung.
- **Ein fertiger Auftrag springt nie zurueck**, auch nicht auf 10 % - ein
  Nachzuegler-Fortschritt darf den Balken nicht zuruecksetzen.
- **Ein Lebenszeichen ohne Auftraege traegt kein `jobs`-Feld** - nur Rauschen.

### Getestet

- 22 neue Tests. 312 gesamt.
- Mutationen, jede faengt genau die zugehoerigen Tests:
  Takt immer 30 s / immer 15 s / faellt mit der Zahl der Auftraege /
  Fehlschlag zaehlt als Arbeit (je ein Test).
  Fehler als "fertig" gemeldet, Ergebnis bei jedem Herzschlag neu,
  Liste unbegrenzt, Deckel bei 100 % weg.
  Agent wieder auf setInterval -> der "wird benutzt"-Test.
- **Live auf der VM gemessen** (nicht angenommen): Abstaende der
  Lebenszeichen im Leerlauf `[30, 30]` Sekunden. Mit Auftrag: `taktMs()`
  15000, `fuerHerzschlag()` traegt den Auftrag mit 50 %, nach `beende()`
  wieder 30000, nach `bestaetige()` leere Liste.

### Eigene Testfehler dabei

- Mutation "fertiger Auftrag wird wieder offen" blieb gruen: der Test prueft
  nur den Zustand, nicht Prozent und Meldung. Ein Nachzuegler haette den
  Balken zurueckgesetzt, ohne den Zustand zu aendern.
- Mutation "Pruefsumme nur erster Block" blieb gruen: die Testdateien waren
  kleiner als ein Block. Jetzt zwei 200-KiB-Dateien, die sich nur in der
  letzten Zeile unterscheiden.
- Mutation "setInterval" blieb gruen: der Test schnitt zu eng
  (`heartbeatTimer = setInterval`), die Mutation traf die Kette selbst.

## [1.4.21] - 2026-11-09

### Neu

- **Neustart-Knopf am Arsenal.** (Felix: "den restart button fand ich
  eigentlich echt gut".) Er meint NICHT das Neustarten von Diensten auf dem
  Arsenal - das bleibt Swords-Sache. Er meint: der Agent haengt, ich will ihn
  von hier aus wecken, ohne SSH.

  Die Aktion heisst weiter `restart`, ihre BEDEUTUNG hat sich geaendert:
  ohne Dienstnamen = das Arsenal selbst, mit Dienstnamen = Unit darauf.
  Der Grund steht im Code, damit die naechste Person nicht raten muss.

  Der Agent antwortet VOR dem Neustart und meldet ihn 2 s spaeter in eigener
  systemd-Unit an - sonst reisst der Neustart die Antwort weg (dieselbe Lehre
  wie beim Fernupdate eine Stunde vorher).

### Geaendert

- Route bietet jetzt `update` und `restart` an; `start`/`stop` bleiben draussen.
- `restart` ohne Dienstnamen ist in der Agent-Whitelist erlaubt. Ein `restart`
  MIT unbrauchbarem Dienstnamen bleibt abgelehnt.

### Getestet

- 3 neue Tests, 2 alte auf die neue Bedeutung gezogen. 288 gesamt.
- Mutationen: restart verlangt wieder einen Dienst -> Whitelist-Test rot.
  Neustart-Knopf entfernt -> zwei Tests rot. `start` statt `restart`
  angeboten -> Start/Stop-Verbots-Test rot.
- **Live auf der VM:** `restart` -> Antwort sofort, Agent nach 12 s wieder da.
  Im Log belegt: Befehl, SIGTERM, neue PID 2172 statt 2138, "startet (ID 6)",
  verbunden. Danach `update` -> `{"gestartet":false,"grund":"schon-aktuell"}`,
  kein sinnloser Neustart.

## [1.4.2] - 2026-11-09

### Neu

- **Fernupdate fuer Arsenale.** Ein Knopf je Zeile. Das Arsenal holt sich neue
  Tags, sichert den laufenden Stand als tar, wechselt, startet neu - und
  PRUEFT SICH DANACH SELBST. Kommt es nicht hoch oder meldet es noch die alte
  Version, rollt es sich selbst zurueck.

  ```
  agent/update.js       die Entscheidungen (ohne Netz, ohne Prozesse)
  agent/updateRun.js    der Ablauf (git, tar, systemctl)
  agent/updateCheck.js  die Pruefung nach dem Neustart
  ```

  Die Pruefung laeuft via `systemd-run` in einer eigenen Unit. Liefe sie im
  Dienst, wuerde der Neustart genau den Code beenden, der ihn pruefen soll.

- **Start/Stop/Neustart sind aus dem Arsenal-Tab wieder RAUS.** Ein Sword
  laeuft auf dem Arsenal und wird ueber die Racks bewegt; das Arsenal ist die
  Maschine, die Racks traegt - kein Fernsteuerungszugang zu allem, was darauf
  laeuft. Die Route bietet nur noch `update` an. Der Agent KANN die drei
  weiterhin (eigene Whitelist), die Armory bietet sie nicht mehr an.

### Sicherheit

- **Das Rollback haengt an KEINER Netzverbindung.** `entscheideNachNeustart()`
  kennt die Armory nicht als Eingabe - wer sie hineinreicht, baut einen
  Rollback, der bei Netzproblemen ausfaellt, und merkt es erst, wenn er
  gebraucht wird. Per Test und per Mutation festgehalten.
- **Ein Rueckschritt ist kein Update.** Wer "verfuegbar < aktuell" als Update
  liest, macht aus einem falschen Tag einen Rueckbau der Maschine.
- **Kaputte Versionsangaben loesen nichts aus** (im Zweifel nichts tun).
- **Der veraltete Stand wird gesichert, bevor gewechselt wird** - ohne
  Sicherung gibt es kein Zurueck.

### Behoben (beides live auf der Test-VM gefunden)

- **Das Update lief durch, das Panel sah einen Timeout.** Der Agent wartete
  blockierend auf den Ablauf; der Neustart riss die Verbindung weg, bevor die
  Antwort rausging. Ein erfolgreicher Vorgang, der wie ein Fehler aussieht,
  ist schlimmer als ein Fehler. Jetzt: anstossen, sofort antworten.
- **Der Agent meldete die FALSCHE Version.** Die Version stand als
  Zeichenkette im Code (`const AGENT_VERSION = '1.4.0'`); beim Wechsel wurde
  `package.json` getauscht, die Konstante nicht. Auf der VM lief 1.4.1, das
  Panel bekam 1.4.0. Jetzt wird sie aus `package.json` gelesen.

### Getestet

- 13 neue Tests (Entscheidungen, Rollback-Regel, Versionsvergleich,
  Fruehantwort). 285 gesamt.
- Mutationen, jede faengt genau die zugehoerigen Tests:
  Rollback an die Armory gehaengt -> der Netzunabhaengigkeits-Test.
  Vergleich alphabetisch -> der 1.10-vs-1.9-Test.
  Dienst aktiv genuegt -> der Altversion-Test.
  Rueckschritt als Update -> der Aelter-Test.
  Version wieder als Konstante -> der Versions-Test.
  Blockierendes await -> der Fruehantwort-Test.
- **Live auf der Test-VM, drei Laeufe:**
  1.4.0 -> 1.4.2: HEAD und package.json auf 1.4.2, NEU.txt vorhanden,
  Pruefung `{"zustand":"ok"}`, Panel zeigt v1.4.2.
  Dann ein absichtlich kaputter Tag 1.4.3 (Code, der beim Start stirbt):
  **`{"zustand":"zurueckgerollt","grund":"dienst-nicht-aktiv","auf":"v1.4.2"}`** -
  das Arsenal rollte sich selbst zurueck und lief danach.

## [1.4.1] - 2026-11-09

### Neu

- **Die Arsenale im Panel kann man jetzt bedienen.** Bisher stand da eine
  Zeile mit Name und Zustand - eine Anzeige, keine Verwaltung. Jetzt stehen
  Status, Start, Stop und Neustart in der Zeile. Start/Stop/Neustart fragen
  nach dem Dienstnamen und zeigen das Ergebnis IN der Zeile, nicht in einem
  Dialog, der den Zusammenhang verliert.

- **Offline-Arsenale bieten nur Status an.** Gegen eine schlafende Maschine
  zu klicken und in einen Timeout zu laufen ist genau die Sorte stiller
  Fehler, die niemand erklaeren kann. Der Knopf ist dann abgeschaltet, nicht
  versteckt - man sieht, dass es ihn gibt.

### Getestet

- 4 neue Tests. 271 gesamt.
- **Mutationen, jede faengt genau ein Test:** Zuhoerer entfernt -> der
  Verdrahtungs-Test wird rot. Start/Stop auch offline klickbar -> der
  Zustands-Test. Knopf-Aktion "reboot" statt "restart" -> der
  Deckungs-Test (Knopf und Route sind sich uneinig).
- Ein Test prueft, dass die angebotenen Aktionen genau die sind, die die
  Route durchlaesst - ein Knopf, den der Server mit 400 abweist, ist eine Falle.

## [1.4.0] - 2026-11-09

### Neu

- **Der Arsenal-Agent.** Ein Programm, das auf der FREMDEN Maschine laeuft,
  sich bei der Armory meldet und Befehle ueber dieselbe Leitung annimmt. Damit
  ist die Kopplung kein Versprechen mehr, sondern laeuft.

  ```
  agent/run.js     das Programm (Verbindung, Herzschlag, Ausfuehrung)
  agent/logic.js   Pruefung und Entscheidungen (ohne Netz, ohne Prozesse)
  ```

  Die Trennung ist Absicht: die Sicherheitspruefung muss ohne WebSocket und
  ohne systemctl testbar sein.

- **Die Armory nimmt die Verbindung an** (`app/arsenalSocket.js`) und schickt
  Befehle durch: `POST /api/arsenals/:id/command` mit `status|start|stop|restart`.

### Sicherheit

- **Zwei Seiten pruefen, nicht eine.** Die Route prueft die Aktion, der Agent
  prueft sie nochmal gegen seine eigene Whitelist. Wer die Armory uebernimmt,
  kommt so nicht automatisch an alle Arsenale.
- **Keine Shell.** `execFile` mit fester Aktionsliste und geprueftem
  Dienstnamen. Der Dienstname muss `^[a-zA-Z0-9][a-zA-Z0-9@._-]*$` erfuellen;
  zusaetzlich wird `/` und `..` abgelehnt.
- **Der Schluessel geht als Header, nicht in der URL** - URLs landen in Logs.
- **Verbindung ueber den Schluessel, nicht ueber die IP.** Unbekannte ID und
  falscher Schluessel antworten identisch, damit geratene IDs nichts verraten.
- **Neuverbindung mit wachsender Wartezeit** (1s, 2s, 4s ... max 60s): ein
  Agent, der im Sekundentakt verbindet, legt die Armory lahm.
- **Stille Leitung wird erkannt.** Ohne Nachricht nach 75 s wird neu verbunden;
  eine tote TCP-Verbindung kann bestehen bleiben, ohne dass `close` kommt.

### Behoben

- **Zwei WebSocket-Pfade am selben Server gingen nicht.** Mit
  `new WebSocketServer({ server, path })` zweimal nimmt der erste JEDER
  Upgrade-Request an, der zweite antwortet nie - live gemessen: `/ws/logs`
  101, `/ws/arsenal` 400. Jetzt `noServer` plus ein Verteiler nach Pfad.
- **`status` ohne Dienstname fragte `systemctl is-active` ohne Argument** und
  bekam "Too few arguments". Jetzt `list-units --state=running`.

### Getestet

- 32 neue Tests (18 Agent-Logik, 14 Socket). Gesamt 267.
- Jede Schutzfunktion per Mutation gegengeprueft: Whitelist geoeffnet,
  Dienst-Regex aufgeweicht, `type`-Pruefung entfernt, Schluessel nicht
  geprueft, alte Leitung nicht geschlossen, Befehl an irgendeine Leitung
  statt an die richtige - jede macht genau die zugehoerigen Tests rot.
- **Live auf der Test-VM (Debian 13, QEMU):** Agent als systemd-Dienst
  installiert, verbunden, Lebenszeichen alle 30 s. Nach einem Neustart des
  Panels hat sich der Agent selbst wieder verbunden (2 s Wartezeit).
  `status` -> `inactive` -> `start` -> `active` -> `stop` -> `inactive`,
  alles durch die Leitung. Zwei Injection-Versuche
  (`ssh; touch /tmp/PWNED` und `$(id)`) wurden vom Agenten mit `bad-service`
  abgelehnt; `/tmp/PWNED` existiert nicht.

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
