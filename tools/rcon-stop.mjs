// Game-Armory - RCON-Stop-Tool
// Sendet den Konsolen-Befehl "stop" an den Minecraft-Server via RCON.
// Dadurch fuehrt Minecraft seinen vollstaendigen Shutdown aus:
//   "Stopping server" -> "Saving worlds" -> "Saving players" -> sauberer Exit.
// Aufruf (aus systemd ExecStop): node rcon-stop.mjs --password-file <pfad>
// ODER (aeltere Units): node rcon-stop.mjs <passwort>
//
// Warum die Datei-Variante (Audit-Fix 2026-10-30, Befund B05):
// Die Unit enthielt `ExecStop=... $(cat /opt/...password)`. systemd fuehrt
// KEINE Shell-Substitution aus - das Argument kam woertlich als "$(cat" an,
// der RCON-Stop schlug fehl und der Server wurde nur per SIGTERM beendet
// (Welt nicht gespeichert). Die Unit uebergibt jetzt den DATEIPFAD, und das
// Passwort wird hier gelesen - kein Shell-Trick, keine Passwort-Angabe in der Unit.

import { Rcon } from 'rcon-client';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

function resolvePassword(argv) {
  const idx = argv.indexOf('--password-file');
  if (idx !== -1) {
    const file = argv[idx + 1];
    if (!file) {
      console.error('[rcon-stop] --password-file ohne Pfad.');
      process.exit(1);
    }
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (err) {
      console.error(`[rcon-stop] Passwortdatei nicht lesbar (${file}): ${err.message}`);
      process.exit(1);
    }
  }
  return argv[2] ?? null;
}

const password = resolvePassword(process.argv);
const host = process.env.RCON_HOST ?? '127.0.0.1';
const TIMEOUT_MS = 30_000;

// Port (Audit-Fix 2026-10-30, Nachtrag zu B05):
// Die Unit setzt kein RCON_PORT. Der Rueckfall 25575 passt fuer Minecraft -
// aber atm11 laeuft auf 25576 (rcon.port in swords/atm11.sword.json), und die
// Ports werden je Instanz vergeben. Deshalb liest das Skript den Port aus der
// Sword-Datei des Servers. Reihenfolge: RCON_PORT (Umgebung) > Sword > 25575.
function resolvePort() {
  if (process.env.RCON_PORT) return Number(process.env.RCON_PORT);

  // Sword-Datei ueber das Passwort-Verzeichnis finden: data/<id>-rcon.password
  const idx = process.argv.indexOf('--password-file');
  const pwFile = idx !== -1 ? process.argv[idx + 1] : null;
  if (pwFile) {
    const id = String(pwFile).match(/\/([^/]+)-rcon\.password$/)?.[1];
    if (id) {
      const swordPath = join(dirname(dirname(pwFile)), 'swords', `${id}.sword.json`);
      try {
        const sword = JSON.parse(readFileSync(swordPath, 'utf8'));
        const p = Number(sword?.rcon?.port);
        if (Number.isInteger(p) && p > 0 && p < 65536) {
          if (sword?.rcon?.host) return { host: sword.rcon.host, port: p };
          return { port: p };
        }
      } catch {
        // Kein / unlesbares Sword: Rueckfall unten, mit Warnung.
        console.error(`[rcon-stop] Sword nicht lesbar (${swordPath}) - nutze Rueckfall-Port.`);
      }
    }
  }
  return { port: 25575 };
}

const fromSword = resolvePort();
const host2 = typeof fromSword === 'object' && fromSword.host ? fromSword.host : host;
const port = typeof fromSword === 'object' ? fromSword.port : Number(fromSword);

if (!password) {
  console.error('[rcon-stop] Kein Passwort uebergeben.');
  process.exit(1);
}

const rcon = await Rcon.connect({ host: host2, port, password, timeout: TIMEOUT_MS }).catch((err) => {
  console.error(`[rcon-stop] Verbindung fehlgeschlagen (${host2}:${port}): ${err.message}`);
  // exit 2 statt 0 (Audit-Fix 2026-10-30): systemd bricht den Stop deswegen NICHT
  // ab - SIGTERM greift weiter als Rueckfall. Aber der Betrieber sieht im Journal,
  // dass der SAUBERE Weg (save-all + stop) nicht geklappt hat. Vorher war ein
  // falsches Passwort von "Server laeuft nicht" nicht zu unterscheiden; bei atm11
  // lief das 36 Tage unbemerkt, die Welt wurde nur per SIGTERM beendet.
  process.exit(2);
});

try {
  console.log('[rcon-stop] Sende "stop" an den Server ...');
  const res = await rcon.send('stop');
  console.log(`[rcon-stop] Server-Antwort: ${res || '(ok)'}`);
} catch (err) {
  console.error(`[rcon-stop] Fehler beim Senden: ${err.message}`);
  await rcon.end().catch(() => {});
  process.exit(3);
}

// Die Verbindung bricht ab, sobald der Server herunterfaehrt - das ist erwartet.
await rcon.end().catch(() => {});
console.log('[rcon-stop] Stop-Kommando abgesetzt.');
process.exit(0);
