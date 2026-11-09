# Konzept: mehrere Arsenale, eine Armory

Stand 2026-11-09, **Entwurf**. Nichts gebaut. Ergebnis von zwei Gesprächen
mit Felix (2026-11-08 und 2026-11-09).

Alle Abschnitte sind mit "geklärt" markiert, wo eine Entscheidung gefallen
ist - und mit "Vorschlag", wo ich eine Empfehlung gebe, die noch nicht
abgesegnet ist.

## Namen (geklärt 2026-11-09)

Die Begriffe folgen der Waffenkammer-Analogie und dürfen sich **nicht**
verwechseln lassen:

```
Armory      das Ganze (was ein Kunde hat)      = Zeughaus
Rack        das Regal, eine Schiene             = Rack
Sword       der Server im Regal                 = Sword
Arsenal     eine Maschine, die Racks traegt     = Zeughaus (engl. Bedeutung)
```

**Warum "Arsenal" und nicht "Knoten":** "Knoten" ist Netzwerkdeutsch und passt
nicht zur Analogie. "Waffenschrank" und "Kammer" wurden verworfen - zu nah am
Regal bzw. klingt nach Abstellraum.

**Der Beleg, dass es stimmt:** das deutsche Wort *Zeughaus* heißt auf Englisch
genau *arsenal / armoury / armory*. Armory und Arsenal sind also **dieselbe
Sache in zwei Sprachen** - kein Teil vom Ganzen, sondern die deutsche
Entsprechung. Deshalb passt der Name.

**Eine Falle:** "Zeughaus" wäre damit doppelt belegt (Armory UND Arsenal). Im
Panel und in der Doku bleiben wir deshalb bei **Armory** und **Arsenal** -
zwei Wörter, nie verwechselt, beide anschlussfähig.

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
auf das Arsenal) hat Felix verworfen: er will Verwaltung (Benutzer, Rechte,
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

Felix' Idee: IP-Adresse, Route, Passwort und ein Schlüssel wie bei 2FA.

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

Geklärt am 2026-11-09 (Felix): **eine Armory gehört einem Kunden.** Man hofft
auf mehrere Kunden, aber **die Armorys reden nicht miteinander.**

Folgen, die das vereinfachen:

- Kein kundübergreifender Verbund, keine gemeinsame Datenbank über Kunden
  hinweg. Jeder Verbund ist für sich geschlossen.
- Die Arsenalliste gehört zur Armory, nicht zu einer globalen Verwaltung.
- Ein Arsenal kennt genau **eine** Armory. Kein Multi-Mandant auf
  Arsenal-Ebene — das hält den Agenten klein und prüfbar.

## Installation: Main oder Arsenal

Geklärt am 2026-11-09: der Installer fragt beim Start, **was** installiert
wird:

```
Als Main installieren   (Panel, Benutzer, Racks, Arsenalverwaltung)
Als Arsenal installieren (Agent, nimmt Befehle der Main an)
```

Warum das gut ist: es erfindet nichts Neues. Der bestehende Installer bekommt
einen Schalter, statt dass es einen zweiten Installer gibt. Ein Arsenal hat
zudem **keine** Benutzerverwaltung und **kein** Web-Panel — er ist nur
ausführende Seite.

## Notfall am Arsenal: repair und re-pair

Geklärt am 2026-11-09. Ein Arsenal hat **kein Web-Interface** — aber ein lokales
Kommando, das **ohne die Main** funktioniert. Ein Notausgang, der nach Hause
telefonieren müsste, wäre im Notfall wertlos.

```
armory-node status    Agent laeuft? Swords oben? Letztes Lebenszeichen?
armory-node repair    Neustart, Dienst neu schreiben, Rechte pruefen
armory-node re-pair   Neu mit der Main koppeln (neuer Kopplungscode)
```

**`repair` und `re-pair` sind absichtlich aehnlich** (Felix' Formulierung: der
"re-pair"-Wortwitz) — es sind die zwei Notfaelle, die man in derselben Lage
braucht: das Arsenal ist kaputt, ODER es kennt die Main nicht mehr.

Der Haken: ein Buchstabe Unterschied heisst Vertipper, und dann repariert man,
wo man neu koppeln wollte. Deshalb:

- `re-pair` fragt nach einer Bestaetigung und **zeigt vorher**, welche Main
  gerade eingetragen ist.
- `repair` fasst die Kopplung **nicht** an. Das muss ein eigener Test
  festhalten, nicht nur ein Kommentar.
- Beide koennen nichts, was der Agent nicht auch koennte. Sie sind ein
  Werkzeug, kein zweiter Weg mit eigenen Rechten.

## Rechte: Arsenale im Konto

Geklärt am 2026-11-09 (Felix): die Arsenalverwaltung liegt im **Konto- und
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

Geklärt am 2026-11-09 (Felix): Arsenale müssen **aus der Ferne updatebar** sein.

Warum das nicht optional ist: bei zehn Maschinen fährt niemand regelmäßig per
SSH durch. Ohne Fernupdate bleiben Stände liegen — genau das Problem, das der
Arsenalverbund lösen sollte.

Der Weg ist schon da: `armory-self-update` macht das heute fürs Panel —
Tag prüfen, vorher sichern, wechseln, bei Fehler zurückrollen. Das Arsenal
bekommt dasselbe, ausgelöst durch die Main.

**Die wichtige Bedingung:** der Rollback darf **nicht** von der Main abhängen.
Geht ein Update schief, muss das Arsenal von selbst auf den alten Stand
zurück, sonst steht man mit zehn Arsenalen da, von denen drei nicht mehr
antworten — und ohne Web-Interface kommt man nur per SSH dran. Das Arsenal
sichert sich vor dem Update selbst und prüft nach dem Neustart, ob er
antwortet; wenn nicht, rollt er zurück.

**Version muss nicht gleich sein, aber sichtbar.** Das Arsenal meldet seine
Version im Lebenszeichen. Dann weiß die Main sofort: "dieses Arsenal ist zu
alt für diese Funktion" — statt dass eine Aktion still scheitert. Ein Zwang
auf identische Versionen wäre bei zehn Arsenalen nicht durchhaltbar.

## Offene Fragen

- Namen der Dinge: "Arsenal" und "Armory" sind festgelegt — noch nicht festgelegt.
- Ob die Arsenale dieselbe Version brauchen wie die Main. Wenn ja, muss der
  Agent sich selbst aktualisieren können (`armory-self-update` gibt es schon
  als Muster) — sonst hat man zehn verschiedene Stände.
- Was ein Arsenal **nicht** darf: keine eigene Benutzerverwaltung, keine
  eigenen Racks. Sonst entstehen zwei Wahrheiten.
