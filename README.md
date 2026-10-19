# Game-Armory

Panel zur Verwaltung von Gameservern. Ein **Rack** beschreibt einen Spieltyp
als JSON-Vorlage, ein **Sword** ist eine daraus erzeugte Instanz.

Mitgeliefert: `7d2d`, `atm10`, `atm11`, `teamspeak6`.

## Start

```sh
npm install
node app/server.js
```

<!-- TODO: Node-Mindestversion. Steht aktuell nicht in package.json/engines. -->
<!-- TODO: Standard-Port, Pfad zur Konfiguration, wie der Dienst eingerichtet wird. -->

## Aufbau

```
app/          Server: Routen, Auth, Installer, Versionen, Selbst-Update
public/       Panel und Login-Seiten
racks/        Rack-Vorlagen als JSON
tools/        Install-Helfer, Selbst-Update, Push-Scanner
templates/    Vorlagen für einzelne Spiele
```

## Vor dem Push prüfen

```sh
tools/pre-push-scan.sh
```

Prüft den Stand auf Zugangsdaten und bricht ab, wenn etwas hineingerutscht ist.
Automatisch bei jedem Push:

```sh
git config core.hooksPath tools/git-hooks
```

## Lizenz

AGPL-3.0-only. Vollständiger Text in [LICENSE](LICENSE).
