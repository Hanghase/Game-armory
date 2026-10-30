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
const port = Number(process.env.RCON_PORT ?? 25575);
const TIMEOUT_MS = 30_000;

if (!password) {
  console.error('[rcon-stop] Kein Passwort uebergeben.');
  process.exit(1);
}

const rcon = await Rcon.connect({ host, port, password, timeout: TIMEOUT_MS }).catch((err) => {
  console.error(`[rcon-stop] Verbindung fehlgeschlagen: ${err.message}`);
  process.exit(0); // kein Fehler fuer systemd - SIGTERM-Fallback greift
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
