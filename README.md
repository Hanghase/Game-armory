# Game-Armory

Panel zur Verwaltung von Gameservern. Ein **Rack** beschreibt einen Spieltyp
als JSON-Vorlage, ein **Sword** ist eine daraus erzeugte Instanz.

Mitgeliefert: `7d2d`, `atm10`, `atm11`, `teamspeak6`.

## Erstinstallation

Auf einem frischen Debian/Ubuntu mit installiertem Node (>= 20):

```sh
sudo tools/armory-install.sh
```

Das Skript richtet alles ein: Service-User, Verzeichnisse, Abhaengigkeiten,
Helfer, sudoers, systemd-Unit und Start. Zweiter Aufruf ist gefahrlos
(idempotent). Nur pruefen, ohne zu aendern:

```sh
sudo tools/armory-install.sh --check-only
```

Am Ende steht eine Selbstpruefung mit OK/FEHLER. Das Panel lauscht nur auf
`127.0.0.1:3000` - von aussen erreicht man es per SSH-Tunnel
(`ssh -L 3000:127.0.0.1:3000 user@server`) oder ueber einen Reverse-Proxy.

## Manueller Start (Entwicklung)

```sh
npm install
node app/server.js
```

Mindestversion Node 20. Standard-Port 3000 (ueber `PORT` aenderbar), Bind nur
auf `127.0.0.1`.

## Aufbau

```
app/          Server: Routen, Auth, Installer, Versionen, Selbst-Update
public/       Panel und Login-Seiten
racks/        Rack-Vorlagen als JSON
tests/        Tests (node:test, keine Abhaengigkeiten)
tools/        Install-Skript, Helfer, Selbst-Update, Push-Scanner
templates/    Vorlagen: systemd-Unit, einzelne Spiele
```

## Tests

```sh
npm test              # alle Tests
npm run test:watch    # bei jeder Aenderung neu
```

Kein Framework, kein `npm install` dafuer: [node:test](https://nodejs.org/api/test.html)
ist in Node eingebaut. Das Projekt hat bewusst keine devDependencies.

Aufbau:

| Datei | Prueft |
|---|---|
| `tests/racks.test.mjs` | Rack-Validierung, inkl. der Pfad-Sicherheitsregel fuer `defaultRoot` |
| `tests/schema.test.mjs` | dass `racks/rack.schema.json` und `app/racks.js` dieselben Felder kennen |

**Grundsatz:** jeder Test muss scheitern *koennen*. Wenn ein Test nach einer
absichtlichen Verschlechterung im Code noch gruen ist, prueft er nichts und
wird entfernt.

Der Scanner (siehe unten) laeuft die Tests mit. Mit `ARMORY_SKIP_TESTS=1`
ueberspringt man sie - sinnvoll nur bei einem reinen Doku-Commit.

## Vor dem Push prüfen

```sh
tools/pre-push-scan.sh
```

Prüft den Stand auf Zugangsdaten und laesst die Tests laufen. Bricht ab, wenn
etwas hineingerutscht ist oder ein Test rot ist.
Automatisch bei jedem Push:

```sh
git config core.hooksPath tools/git-hooks
```

## Lizenz

AGPL-3.0-only. Vollständiger Text in [LICENSE](LICENSE).
