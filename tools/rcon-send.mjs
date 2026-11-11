// Game-Armory - RCON-Konsolen-Client
// Sendet EINEN Konsolen-Befehl an einen Minecraft-Server und gibt die Antwort aus.
//
// Aufruf (nur ueber den Helfer armory-rcon-ctl):
//   node rcon-send.mjs --sword <pfad/zur.sword.json> -- "<befehl>"
//
// Das Passwort kommt per STDIN (der Helfer leitet es um). Es steht nie in
// argv und ist damit in `ps` nicht sichtbar.
//
// Grenzen: Dieses Skript prueft NICHTS mehr - die Pruefung (Zeichen,
// Sperrliste, Laenge) liegt im Helfer, weil nur der als root laeuft und nur
// er dem Aufrufer vertrauen darf. Hier wird ausschliesslich verbunden,
// gesendet und die Antwort ausgegeben.

import { Rcon } from 'rcon-client';
import { readFileSync } from 'node:fs';

const TIMEOUT_MS = 15_000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}

// Nach "--" steht der Befehl (alles dahinter, wieder zusammengefuegt).
const sep = process.argv.indexOf('--');
const befehl = sep !== -1 ? process.argv.slice(sep + 1).join(' ') : '';

const swordPath = arg('--sword');
if (!swordPath) {
  console.error('[rcon-send] --sword fehlt.');
  process.exit(1);
}
if (!befehl.trim()) {
  console.error('[rcon-send] Kein Befehl uebergeben.');
  process.exit(1);
}

// Passwort von STDIN lesen (vom Helfer umgeleitet).
function passwortVonStdin() {
  try {
    return readFileSync(0, 'utf8').trim();
  } catch {
    return '';
  }
}

const password = passwortVonStdin();
if (!password) {
  console.error('[rcon-send] Kein Passwort auf stdin.');
  process.exit(1);
}

// Host/Port aus dem Sword - der Helfer hat bereits geprueft, dass rcon existiert.
let host = '127.0.0.1';
let port = 25575;
try {
  const sword = JSON.parse(readFileSync(swordPath, 'utf8'));
  if (sword?.rcon?.host) host = sword.rcon.host;
  const p = Number(sword?.rcon?.port);
  if (Number.isInteger(p) && p > 0 && p < 65536) port = p;
} catch (err) {
  console.error(`[rcon-send] Sword nicht lesbar: ${err.message}`);
  process.exit(1);
}

let rcon;
try {
  rcon = await Rcon.connect({ host, port, password, timeout: TIMEOUT_MS });
} catch (err) {
  console.error(`[rcon-send] Verbindung fehlgeschlagen (${host}:${port}): ${err.message}`);
  process.exit(2);
}

try {
  const antwort = await rcon.send(befehl);
  // Minecraft antwortet mit leerem String bei Befehlen ohne Ausgabe
  // (z.B. save-all liefert "Saved the game", kick liefert "Kicked ...").
  process.stdout.write(`${antwort ?? ''}\n`);
} catch (err) {
  console.error(`[rcon-send] Fehler beim Senden: ${err.message}`);
  await rcon.end().catch(() => {});
  process.exit(3);
}

await rcon.end().catch(() => {});
process.exit(0);
