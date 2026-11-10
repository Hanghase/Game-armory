# Release-Ansagen

Hier steht vor jedem Nebenstelle-Sprung, was fertig ist.
## 1.7.0 - 2026-11-10

**Fertig:** Ein bestehender Dienst laesst sich uebernehmen.

Der Weg ist live gegangen: die Erkennung findet 12 laufende Dienste auf felsis.de,
Nextcloud ist als sicher erkannt, die elf systemd-Dienste ehrlich als "Dienstart
unbekannt". Die fuenf Pruefungen (Steuerart, Arbeitsverzeichnis, Struktur, Port,
Log-Quelle) muessen alle stimmen. "Unbekannt" zaehlt NICHT als bestanden.
Eingetragen wird mit Lock, tmp+rename und Gegenprobe gegen validateSword.

Mit drin, weil im selben Zug entstanden:

- Schliessen-Kreuz fuer alle elf Fenster, dazu Escape und Klick auf den Rand
- "Neu bauen" und "Bestehenden uebernehmen" unter einem Knopf zusammengefasst
- Der Docker-Helfer nimmt Stack-Namen statt Pfade (feste Tabelle, ALLOWED_ROOT)

**Warum die zweite Stelle und nicht ein Patch:** das ist eine Faehigkeit,
die es vorher nicht gab - nicht eine Korrektur an einer bestehenden.
