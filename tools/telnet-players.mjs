// Game-Armory - Spielerzahl ueber die 7DTD-Telnet-Konsole
//
// Aufruf (nur ueber den Helfer armory-telnet-ctl):
//   node telnet-players.mjs --host 127.0.0.1 --port 8081 -- "lp"
//
// Gibt die Server-Antwort auf stdout aus (der Helfer reicht sie durch, das
// Parsen macht app/control.js).
//
// Grenzen: Dieses Skript prueft nichts - die Pruefung (Loopback, Config,
// Passwort) liegt im Helfer, weil nur der als root laeuft. Hier wird
// ausschliesslich verbunden, EIN Befehl gesendet und gewartet.
//
// Warum nicht "einfach nc": 7d2d schickt ein Banner, dann muss man warten,
// bis es fertig ist, sonst landet der Befehl im Nichts. Das braucht echtes
// Lesen mit Timeout, nicht ein Pipe-Einzeiler.

import net from 'node:net';

const TIMEOUT_MS = 10_000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}

const sep = process.argv.indexOf('--');
const befehl = sep !== -1 ? process.argv.slice(sep + 1).join(' ') : '';

if (!befehl.trim()) {
  console.error('[telnet] Kein Befehl uebergeben.');
  process.exit(1);
}
// Nur ein einzelnes Wort, das wie ein Befehl aussieht. Der Helfer schickt
// heute fest "lp"; diese Zeile ist der zweite Riegel, falls sich das aendert.
if (!/^[a-zA-Z]{1,20}$/.test(befehl.trim())) {
  console.error('[telnet] Unerlaubter Befehl.');
  process.exit(1);
}

const host = arg('--host') ?? '127.0.0.1';
const port = Number(arg('--port'));

// Nur Loopback - ein 7d2d-Telnet im Netz ist ein offenes Admin-Interface.
if (host !== '127.0.0.1' && host !== '::1') {
  console.error('[telnet] Nur Loopback erlaubt.');
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('[telnet] Ungueltiger Port.');
  process.exit(1);
}

// Muster der Antwort, die wir brauchen:
//   Total of 0 in the game
// Bei Spielern ergaenzt 7d2d die Liste dahinter; wir warten nur auf die
// Zeile mit der Zahl und brechen dann ab.
const TREFFER = /Total of (\d+) in the game/i;

let buf = '';
let gesendet = false;
let fertig = false;

const sock = net.connect(port, host);
sock.setTimeout(TIMEOUT_MS);
sock.setEncoding('utf8');

function abschluss(ok, text) {
  if (fertig) return;
  fertig = true;
  if (ok) process.stdout.write(text);
  else console.error(text);
  sock.write('exit\r\n');
  setTimeout(() => { sock.destroy(); process.exit(ok ? 0 : 3); }, 150);
}

sock.on('data', (chunk) => {
  buf += chunk;
  // Erst senden, wenn das Banner durch ist. Sonst frisst der Server den
  // Befehl waehrend des Aufbaus und antwortet nie.
  if (!gesendet && /\*\*\* Dedicated server only build/.test(buf)) {
    gesendet = true;
    sock.write(`${befehl}\r\n`);
    return;
  }
  const m = buf.match(TREFFER);
  if (m) abschluss(true, `${m[0]}\n`);
});

sock.on('timeout', () => {
  abschluss(false, '[telnet] Zeitueberschreitung - keine Antwort.');
});

sock.on('error', (err) => {
  abschluss(false, `[telnet] Verbindung fehlgeschlagen (${host}:${port}): ${err.message}`);
});

sock.on('close', () => {
  if (fertig) return;
  const m = buf.match(TREFFER);
  if (m) abschluss(true, `${m[0]}\n`);
  else abschluss(false, '[telnet] Verbindung beendet, aber keine Spielerzahl erhalten.');
});
