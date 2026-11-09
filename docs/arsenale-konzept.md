# Konzept: mehrere Arsenale, eine Armory

Stand 2026-11-09, **Entwurf**. Nichts gebaut.

Dieses Dokument beschreibt, wie eine Armory auf mehreren Maschinen laufen
kann. Die Abschnitte sind mit **entschieden** markiert, wo eine Richtung
feststeht, und mit **zu klären**, wo Optionen offen sind.

## Namen

Die Begriffe folgen der Waffenkammer-Analogie und dürfen sich **nicht**
verwechseln lassen:

```
Armory      das Ganze (was ein Kunde hat)       = Zeughaus
Rack        das Regal, eine Schiene             = Rack
Sword       der Server im Regal                 = Sword
Arsenal     eine Maschine, die Racks trägt      = Zeughaus (engl. Bedeutung)
```

**Warum "Arsenal" und nicht "Knoten":** "Knoten" ist Netzwerkdeutsch und passt
nicht zur Analogie. "Waffenschrank" und "Kammer" wurden verworfen - zu nah am
Regal bzw. klingt nach Abstellraum.

**Der Beleg, dass es stimmt:** das deutsche Wort *Zeughaus* heißt auf Englisch
genau *arsenal / armoury / armory*. Armory und Arsenal sind also **dieselbe
Sache in zwei Sprachen** - kein Teil vom Ganzen, sondern die deutsche
Entsprechung. Deshalb passt der Name.

**Eine Falle:** "Zeughaus" wäre damit doppelt belegt (Armory UND Arsenal). Im Panel und in der Doku bleibt es deshalb bei **Armory** und **Arsenal**:
zwei Wörter, nie verwechselt.

Konsequenz für Befehle und Bezeichner:

```
arsenal „frankfurt-01"        4 Racks, 7 Swords
arsenal „frankfurt-02"        Lebenszeichen vor 12s
```

## Das Ziel

Ein Kunde hat mehrere Hardware-Server, will aber **eine** Armory bedienen.
Benutzer, Rechte, Racks und Swords sollen zentral verwaltet werden — die
Rechenarbeit passiert auf mehreren Maschinen.

Obergrenze: **10 Arsenale**.

Dazu der Wunsch: ein Sword zwischen Maschinen **verschieben** können, so dass
im Zweifel "mal hier, mal da" und die Adresse für den Spieler trotzdem
anklickbar bleibt.

## Warum ein Arsenal-Agent statt SSH

Die bisher diskutierte Alternative (Panel ruft per SSH den bewährten Helfer
auf das Arsenal) wurde verworfen: gewünscht ist Verwaltung (Benutzer, Rechte,
Racks) zentral, und dafür braucht es einen Agenten, der auch Zustand kennt.

Der Preis ist eine Vertrauensfrage: wer das Haupt-Panel übernimmt, käme an
alle Arsenale. **Deshalb prüft der Agent selbst, was er annimmt** — nicht das
Panel. Gleiche Härte wie bei `armory-docker-ctl`: feste Aktionsliste, keine
freien Kommandos, eigene Prüfung.

## Entscheidung: das Arsenal ruft an, nicht die Armory

Der Schlüssel wird **auf dem Arsenal erzeugt und dort abgelesen**, nicht übers
Netz getauscht. Ablauf beim Koppeln:

1. Am Arsenal: der Agent startet, zeigt einmalig einen Kopplungscode.
2. Dieser Code wird im Haupt-Panel eingetippt.
3. Danach kennt das Arsenal die Armory, nicht umgekehrt.

Das Arsenal hält danach die Verbindung **offen** und die Armory schiebt Befehle
durch. Folgen:

- kein Port nach außen, keine Firewall-Regeln
- funktioniert im Internet und im Heimnetz gleich
- eine öffentliche IP reicht für zehn Arsenale

Der Preis: der Agent läuft dauerhaft, und ein totes Arsenal fällt nur durch
fehlende Lebenszeichen auf. **Deshalb: Lebenszeichen alle 30 Sekunden**, im
Panel sichtbar.

## Authentifizierung je Arsenal

Vorgesehen: IP-Adresse, Route, Passwort und ein Schlüssel wie bei 2FA.

Einwände, die in die Umsetzung gehören:

- **Die IP ist kein Beweis.** Wer im selben Netz sitzt, kann sie fälschen. Sie
  taugt als zusätzliche Sperre, nicht als Identität. Identität ist der
  Arsenal-Schlüssel, den nur dieses Arsenal kennt.
- **Der Kopplungscode ist einmalig und kurz gültig** (wie ein Setup-Code),
  nicht dauerhaft gültig.

## Swords verschieben

Machbar: Welt sichern, auf den Zielknoten kopieren, dort starten, hier
stoppen. Die Backup-Funktion deckt die halbe Strecke ab.

**"Gleiche IP" ist der schwierige Teil**, offen kommuniziert:

- Ein Server auf Maschine B unter der Adresse von A braucht eine
  Weiterleitung (Proxy auf A) oder einen Adress-Umschalter.
- Bei Minecraft geht das, weil alles über einen Port läuft. Bei Spielen mit
  mehreren Ports wird es fummelig.

**Nicht versprochen: echtes Load-Balancing.** Spieler auf zwei Servern mit
derselben Welt ist keine Lastverteilung, das ist eine geteilte Welt — und die
geht kaputt. Gemeint ist: der Server liegt mal hier, mal da, die Adresse
bleibt.

## Vorschlag zur Reihenfolge

1. Kopplung + Lebenszeichen (das Fundament, ohne das nichts prüfbar ist)
2. Zustand je Arsenal (was läuft dort)
3. Swords verschieben, erst ohne "gleiche IP"
4. "Gleiche IP" als eigener Schritt — der beißt später

## Datenmodell: eine Armory = ein Kunde

**Entschieden:** eine Armory gehört einem Kunden. Man hofft
auf mehrere Kunden, aber **die Armorys reden nicht miteinander.**

Folgen, die das vereinfachen:

- Kein kundübergreifender Verbund, keine gemeinsame Datenbank über Kunden
  hinweg. Jeder Verbund ist für sich geschlossen.
- Die Arsenalliste gehört zur Armory, nicht zu einer globalen Verwaltung.
- Ein Arsenal kennt genau **eine** Armory. Kein Multi-Mandant auf
  Arsenal-Ebene — das hält den Agenten klein und prüfbar.

## Installation: Armory oder Arsenal

Der Installer fragt beim Start, **was** installiert wird:

```
Als Armory installieren  (Panel, Benutzer, Racks, Arsenalverwaltung)
Als Arsenal installieren (Agent, nimmt Befehle der Armory an)
```

Es gibt weiterhin nur einen Installer; er bekommt einen Schalter statt einer
zweiten Variante. Ein Arsenal hat **keine** Benutzerverwaltung und **kein**
Web-Panel — es ist nur die ausführende Seite.

## Notfall am Arsenal: repair und re-pair

Ein Arsenal hat **kein Web-Interface**, aber ein lokales Kommando, das **ohne
die Armory** funktioniert. Ein Notausgang, der nach Hause telefonieren müsste,
wäre im Notfall wertlos.

```
arsenal status     Agent läuft? Swords oben? Letztes Lebenszeichen?
arsenal repair     Neustart, Dienst neu schreiben, Rechte prüfen
arsenal re-pair    Neu mit der Armory koppeln (neuer Kopplungscode)
```

**`repair` und `re-pair` sind absichtlich ähnlich.** Es sind die zwei Notfälle
derselben Lage: das Arsenal ist kaputt, oder es kennt die Armory nicht mehr.

Der Haken: ein Buchstabe Unterschied heißt Vertipper, und dann repariert man,
wo man neu koppeln wollte. Deshalb:

- `re-pair` fragt nach einer Bestätigung und **zeigt vorher**, welche Armory
  gerade eingetragen ist.
- `repair` fasst die Kopplung **nicht** an. Das muss ein eigener Test
  festhalten, nicht nur ein Kommentar.
- Beide können nichts, was der Agent nicht auch könnte. Sie sind ein
  Werkzeug, kein zweiter Weg mit eigenen Rechten.

## Rechte: Arsenale im Konto

**Entschieden:** die Arsenalverwaltung liegt im **Konto- und
Verwaltungs-Interface** der Armory. Standardmäßig **nur Superuser**.

Umgesetzt wird das als **Recht**, nicht als fest verdrahteter Rang — sonst
könnte man später nicht sagen "dieser Administrator darf auch Arsenale
verwalten". Vorbild ist `system.logs` (Stand 2026-10-31): eigenes Recht, nicht
in `ADMIN_PERMS`, also von Haus aus nur Superuser.

Vorgeschlagene Rechte in `app/permissions.js`, Gruppe "Arsenale":

```js
{ perm: 'arsenal.read',    label: 'Arsenale lesen',      group: 'Arsenale' },
{ perm: 'arsenal.create',  label: 'Arsenal hinzufügen',  group: 'Arsenale' },
{ perm: 'arsenal.update',  label: 'Arsenal aktualisieren', group: 'Arsenale' },
{ perm: 'arsenal.delete',  label: 'Arsenal entfernen',   group: 'Arsenale' },
{ perm: 'arsenal.pair',    label: 'Arsenal koppeln',     group: 'Arsenale' },
```

Alle fünf stehen **nicht** in `ADMIN_PERMS` → Startbelegung nur Superuser.
`arsenal.pair` ist absichtlich getrennt: koppeln heißt, einen fremden Rechner
in die Armory aufnehmen — das ist mehr als ein bestehendes Arsenal zu
aktualisieren.

**Was ein Arsenal NICHT darf:** Benutzer anlegen, Rollen ändern, Rechte
vergeben. Das bleibt bei der Armory. Sonst könnte ein kompromittiertes Arsenal
sich selbst Rechte geben.

## Version und Fernupdate

**Entschieden:** Arsenale müssen aus der Ferne updatebar sein.

Bei zehn Maschinen fährt niemand regelmäßig per SSH durch. Ohne Fernupdate
bleiben Stände liegen.

Der Weg ist schon da: `armory-self-update` macht das heute fürs Panel —
Tag prüfen, vorher sichern, wechseln, bei Fehler zurückrollen. Das Arsenal
bekommt dasselbe, ausgelöst durch die Armory.

**Die wichtige Bedingung:** der Rollback darf **nicht** von der Armory abhängen.
Geht ein Update schief, muss das Arsenal von selbst auf den alten Stand
zurück, sonst steht man mit zehn Arsenalen da, von denen drei nicht mehr
antworten — und ohne Web-Interface kommt man nur per SSH dran. Das Arsenal
sichert sich vor dem Update selbst und prüft nach dem Neustart, ob es
antwortet; wenn nicht, rollt es zurück.

**Version muss nicht gleich sein, aber sichtbar.** Das Arsenal meldet seine
Version im Lebenszeichen. Dann weiß die Armory sofort: "dieses Arsenal ist zu
alt für diese Funktion" — statt dass eine Aktion still scheitert. Ein Zwang
auf identische Versionen wäre bei zehn Arsenalen nicht durchhaltbar.

## Offene Fragen

- Was ein Arsenal anzeigen darf. Werkzeuge und Zustand sind unbestritten;
  strittig ist, ob Benutzer- und Rechteverwaltung dort sichtbar sein sollen.
- Ob Arsenale dieselbe Version brauchen wie die Armory. Wenn ja, muss der Agent
  sich selbst aktualisieren können — sonst hat man zehn verschiedene Stände.
  (Ein Muster dafür existiert bereits: `armory-self-update`.)
- Ob Racks auf einem Arsenal angelegt werden dürfen. Wenn ja, entstehen zwei
  Wahrheiten, die abgeglichen werden müssen.
