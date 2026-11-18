// Game-Armory - TeamSpeak-6-ServerQuery-Client
// Sendet EINEN ServerQuery-Befehl an einen TS6-Server (HTTP-WebQuery) und gibt
// die Antwort aus.
//
// Aufruf (nur ueber den Helfer armory-ts6-ctl):
//   node ts6-query.mjs --sword <pfad/zur.sword.json> -- "<befehl>"
//
// Der API-Key kommt per STDIN (der Helfer leitet ihn um). Er steht nie in
// argv und ist damit in `ps` nicht sichtbar.
//
// Grenzen: Dieses Skript prueft NICHTS mehr - die Pruefung (Zeichen,
// Sperrliste, Laenge) liegt im Helfer, weil nur der als root laeuft und nur
// er dem Aufrufer vertrauen darf. Hier wird ausschliesslich verbunden,
// gesendet und die Antwort ausgegeben.
//
// Anders als RCON ist ServerQuery strukturiert: Die Antwort ist JSON mit
// einem body-Array und einem status-Objekt. Wir geben eine lesbare Zeile aus,
// damit die Konsole nicht mit JSON-Rauschen volllaeuft.

import { readFileSync } from 'node:fs';
import http from 'node:http';

// Node's fetch (undici) blockt Ports wie 10080 als "bad port" - das ist eine
// eingebaute Sperrliste fuer angeblich unsichere Ports. TeamSpeaks WebQuery
// lauscht aber genau dort. Deshalb http.request von Hand statt fetch: das
// Modul kennt keine solche Liste.

const TIMEOUT_MS = 15_000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}

// Nach "--" steht der Befehl (alles dahinter, wieder zusammengefuegt).
const sep = process.argv.indexOf('--');
const befehlRoh = sep !== -1 ? process.argv.slice(sep + 1).join(' ') : '';
const befehl = befehlRoh.trim();

const swordPath = arg('--sword');
if (!swordPath) {
  console.error('[ts6-query] --sword fehlt.');
  process.exit(1);
}
if (!befehl) {
  console.error('[ts6-query] Kein Befehl uebergeben.');
  process.exit(1);
}

// API-Key von STDIN lesen (vom Helfer umgeleitet).
function keyVonStdin() {
  try {
    return readFileSync(0, 'utf8').trim();
  } catch {
    return '';
  }
}

const apiKey = keyVonStdin();
if (!apiKey) {
  console.error('[ts6-query] Kein API-Key auf stdin.');
  process.exit(1);
}

// Host/Port/Server-ID aus dem Sword - der Helfer hat bereits geprueft,
// dass eine query-Sektion existiert.
let host = '127.0.0.1';
let port = 10080;
let serverId = '1';
try {
  const sword = JSON.parse(readFileSync(swordPath, 'utf8'));
  const q = sword?.query ?? {};
  if (q.host) host = q.host;
  const p = Number(q.port);
  if (Number.isInteger(p) && p > 0 && p < 65536) port = p;
  if (q.serverId != null && String(q.serverId).trim() !== '') {
    serverId = String(q.serverId).trim();
  }
} catch (err) {
  console.error(`[ts6-query] Sword nicht lesbar: ${err.message}`);
  process.exit(1);
}

// Befehl + Parameter in Pfad und Query zerlegen.
// "clientkick clid=5 reasonmsg=test" -> /1/clientkick?clid=5&reasonmsg=test
const teile = befehl.split(/\s+/);
// TS6-Befehle sind KLEIN geschrieben und case-sensitive: "Clientlist" lehnt der
// Server mit Code 1538 ab, "clientlist" geht. Ein Nutzer tippt aber natuerlich
// mal gross - am 2026-11-12 hat genau das Felix einen "unknown command"
// beschert, obwohl der Befehl richtig gemeint war. Wir normalisieren deshalb
// den Befehlsnamen, so wie es auch die TS6-eigene Konsole tut.
const kommando = teile[0].toLowerCase();
const parameter = teile.slice(1);

// Der Befehl selbst geht in den PFAD, nicht in die Query - sonst koennte ein
// "?" oder "/" im Befehl eine andere Route ansprechen. Der Helfer erlaubt
// diese Zeichen ohnehin nicht; hier ist es die zweite Sicherung.
if (!/^[a-zA-Z0-9_]+$/.test(kommando)) {
  console.error('[ts6-query] Unzulaessiger Befehlsname.');
  process.exit(2);
}

const url = new URL(`http://${host}:${port}/${encodeURIComponent(serverId)}/${kommando}`);
for (const p of parameter) {
  const eq = p.indexOf('=');
  if (eq > 0) {
    url.searchParams.append(p.slice(0, eq), p.slice(eq + 1));
  } else {
    url.searchParams.append(p, '');
  }
}

function anfrage(hostname, portNr, pfad, key) {
  return new Promise((aufloesen, ablehnen) => {
    const req = http.request(
      {
        host: hostname,
        port: portNr,
        path: pfad,
        method: 'POST',
        headers: { 'x-api-key': key },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const stuecke = [];
        res.on('data', (c) => stuecke.push(c));
        res.on('end', () =>
          aufloesen({
            status: res.statusCode,
            text: Buffer.concat(stuecke).toString('utf8'),
          }),
        );
      },
    );
    req.on('timeout', () => {
      req.destroy();
      ablehnen(new Error('zeitueberschreitung'));
    });
    req.on('error', ablehnen);
    req.end();
  });
}

let antwort;
try {
  const r = await anfrage(host, port, `${url.pathname}${url.search}`, apiKey);

  // Auch bei 4xx/5xx liefert TS6 meist JSON mit einer lesbaren Begruendung.
  // Diese Begruendung ist fuer den Nutzer wertvoller als "HTTP 400" - sie sagt
  // z.B. "unknown command" oder "insufficient permissions".
  let fehlerBody = null;
  if (r.status < 200 || r.status >= 300) {
    try {
      fehlerBody = JSON.parse(r.text);
    } catch {
      // kein JSON - dann bleibt der Status
    }
  }
  if (fehlerBody) {
    const c = Number(fehlerBody?.status?.code ?? 0);
    const m = String(fehlerBody?.status?.message ?? '');
    const extra = String(fehlerBody?.status?.extra_message ?? '');
    const teile = [m, extra].filter(Boolean).join(' – ');
    console.error(`[ts6-query] Server lehnt den Befehl ab (Code ${c}): ${teile || r.status}`);
    process.exit(3);
  }
  if (r.status < 200 || r.status >= 300) {
    console.error(`[ts6-query] HTTP ${r.status}`);
    process.exit(2);
  }
  try {
    antwort = JSON.parse(r.text);
  } catch {
    console.error('[ts6-query] Antwort ist kein JSON.');
    process.exit(2);
  }
} catch (err) {
  if (err.message === 'zeitueberschreitung') {
    console.error(`[ts6-query] Zeitüberschreitung (${host}:${port}).`);
    process.exit(2);
  }
  console.error(`[ts6-query] Verbindung fehlgeschlagen (${host}:${port}): ${err.message}`);
  process.exit(2);
}

// Fehlerstatus des Servers ist HTTP 200 mit status.code != 0.
const code = Number(antwort?.status?.code ?? 0);
const message = String(antwort?.status?.message ?? '');

// 1281 = ERROR_database_empty_result: keine Treffer, kein Fehler.
if (code !== 0 && code !== 1281) {
  console.error(`[ts6-query] Server meldet Fehler ${code}: ${message}`);
  process.exit(3);
}

// Lesbare Ausgabe: bei Listen eine Zeile pro Eintrag, sonst die Felder.
const body = antwort?.body;
if (Array.isArray(body)) {
  if (body.length === 0) {
    process.stdout.write('(keine Einträge)\n');
  } else {
    const zeilen = body.map((eintrag) =>
      Object.entries(eintrag ?? {})
        .map(([k, v]) => `${k}=${v ?? ''}`)
        .join(' '),
    );
    process.stdout.write(`${zeilen.join('\n')}\n`);
  }
} else if (body && typeof body === 'object') {
  process.stdout.write(
    `${Object.entries(body).map(([k, v]) => `${k}=${v ?? ''}`).join(' ')}\n`,
  );
} else {
  process.stdout.write(`${message || 'ok'}\n`);
}

process.exit(0);
