#!/usr/bin/env node
// Arsenal-Agent - laeuft auf der FREMDEN Maschine.
//
// Ablauf:
//   1. Schluessel + Armory-Adresse aus /etc/armory-arsenal/arsenal.json lesen
//   2. WebSocket zur Armory aufbauen (WIR rufen an - kein Port hier offen)
//   3. Lebenszeichen alle 30 s
//   4. Befehle der Armory gegen die Whitelist pruefen und ausfuehren
//   5. Bei Verbindungsverlust: warten, neu verbinden, Wartezeit verdoppeln
//
// Was dieser Agent NICHT tut:
//   - keine Shell aus Befehlen bauen (fester Befehl, feste Argumente)
//   - keine Benutzerverwaltung, kein Web-Interface
//   - nichts annehmen, was nicht exakt der Whitelist entspricht
//
// Aufruf: node agent/agent.js   (als systemd-Dienst armory-arsenal.service)

import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { erstelleAuftragsliste } from '../app/arsenalJobs.js';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import {
  validateCommand,
  heartbeatMessage,
  shouldReconnect,
  nextBackoff,
  HEARTBEAT_MS,
  validatePull,
} from './logic.js';
import { startePull, nimmStueck, beendePull, brichAb } from './transferRun.js';

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const CONFIG_PATH = process.env.ARMORY_ARSENAL_CONFIG || '/etc/armory-arsenal/arsenal.json';
// Die Version kommt aus package.json, NICHT aus einer Konstante im Code.
// Als Zeichenkette hier festgehalten wurde sie beim Update nicht mitgezogen:
// auf der Test-VM lief nach dem Wechsel tatsaechlich 1.4.1, das Panel bekam
// aber weiter 1.4.0 gemeldet - und ein Aktion, die gegen einen stillen
// Versionsunterschied laeuft, ist genau der Fehler, den das Konzept
// ausgeschlossen hat ("das Arsenal MELDET seine Version").
// Fehlt die Datei, ist die Version unbekannt - nicht geraten.
const AGENT_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unbekannt';
  } catch {
    return 'unbekannt';
  }
})();

// --- Konfiguration ---------------------------------------------------------

function ladeConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    throw new Error(`Konfiguration nicht lesbar: ${CONFIG_PATH} (${err.code})`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new Error(`Konfiguration ist kein JSON: ${CONFIG_PATH}`);
  }
  if (!Number.isInteger(cfg.id) || cfg.id <= 0) throw new Error('Konfiguration: "id" fehlt');
  if (typeof cfg.key !== 'string' || cfg.key.length < 20) throw new Error('Konfiguration: "key" fehlt');
  if (typeof cfg.url !== 'string' || !/^wss?:\/\//.test(cfg.url)) {
    throw new Error('Konfiguration: "url" muss mit ws:// oder wss:// beginnen');
  }
  return cfg;
}

// --- Ausfuehrung eines Befehls ---------------------------------------------
// Es wird NIE eine Shell benutzt: execFile mit fester Aktionsliste und einem
// bereits geprueften Dienstnamen. Die Whitelist steht in agent.js.

async function fuehreAus({ action, service }) {
  // update betrifft das ARSENAL SELBST, nicht eine Unit darauf. Es laeuft
  // darum nicht ueber systemctl, sondern ueber den Update-Ablauf - und der
  // antwortet sofort, weil der Neustart sonst die Antwort mitreisst.
  if (action === 'update') {
    const { starteUpdate } = await import('./updateRun.js');
    // NICHT warten. Live auf der Test-VM gemessen: mit blockierendem await
    // lief das Update durch (1.4.0 -> 1.4.1, Pruefung "ok"), aber das Panel
    // bekam einen Timeout - der Neustart riss die Verbindung weg, bevor die
    // Antwort rausging. Ein erfolgreicher Vorgang, der wie ein Fehler
    // aussieht, ist schlimmer als ein Fehler.
    //
    // Also: anstossen, sofort antworten, Ergebnis kommt als naechstes
    // Lebenszeichen (Version) bzw. als Log. Das "sicher" wird mitgeschickt,
    // weil bis dahin schon gesichert wurde - die Antwort soll nicht "laeuft"
    // sagen, wenn in Wahrheit gleich ein Wechsel passiert.
    starteUpdate({ meldung: (t) => log(t) })
      .then((ergebnis) => log(`Update-Ergebnis: ${JSON.stringify(ergebnis)}`))
      .catch((err) => log(`Update fehlgeschlagen: ${String(err.message ?? err).slice(0, 300)}`));
    return {
      ok: true,
      action,
      service: null,
      output: 'Fernupdate angestoßen - das Arsenal prüft sich nach dem Neustart selbst.',
    };
  }

  // restart OHNE Dienst meint das ARSENAL SELBST: der Agent haengt, starte
  // ihn neu. Nicht "Dienst X auf diesem Rechner".
  //
  // Die Antwort muss VOR dem Neustart raus - dieselbe Lehre wie beim Update:
  // ein erfolgreicher Vorgang, der beim Aufrufer als Timeout ankommt, ist
  // schlimmer als ein Fehler. Darum in eigener Unit, leicht verzoegert, und
  // sofort antworten.
  if (action === 'restart' && !service) {
    const einheit = `arsenal-restart-${Date.now()}`;
    execFileP('/usr/bin/systemd-run', [
      '--unit', einheit, '--collect', '--quiet',
      '--on-active=2',
      '--description', 'Arsenal: Agent neu starten',
      '/usr/bin/systemctl', 'restart', 'armory-arsenal',
    ], { timeout: 15000 }).catch((err) => log(`Neustart nicht angemeldet: ${err.message}`));
    return {
      ok: true,
      action,
      service: null,
      output: 'Neustart angestoßen - der Agent ist in wenigen Sekunden wieder da.',
    };
  }

  // status OHNE Dienst fragt "was laeuft hier" - dafuer braucht systemctl
  // eine Liste statt is-active ohne Argument. is-active ohne Unit faellt mit
  // "Too few arguments" aus, und das ist nicht die Antwort auf die Frage.
  let args;
  if (action === 'status' && !service) {
    args = ['list-units', '--type=service', '--state=running', '--no-pager', '--no-legend', '--plain'];
  } else if (action === 'status') {
    args = ['is-active', service];
  } else {
    args = [action, service];
  }

  try {
    const { stdout } = await execFileP('/usr/bin/systemctl', args, {
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    });
    return { ok: true, action, service, output: stdout.trim() };
  } catch (err) {
    // systemctl liefert bei "inactive" Exit 3. Das ist kein Fehler des
    // Agenten, sondern eine Antwort - der Zustand wird zurueckgemeldet.
    const out = String(err.stdout ?? '').trim();
    const code = typeof err.code === 'number' ? err.code : null;
    return { ok: false, action, service, exitCode: code, output: out || String(err.message).slice(0, 200) };
  }
}

  // --- Dateien ziehen --------------------------------------------------------
  //
  // Das Arsenal ZIEHT. Die Armory sagt in einer JSON-Nachricht "hol diese
  // Datei" (id, Groesse, Pruefsumme, Name). Danach kommen die Stuecke als
  // BINAER-Nachrichten - nicht als JSON, weil base64 ein Drittel mehr Verkehr
  // und dreimal so viel Speicher kostet.
  //
  // Jedes Stueck traegt seinen Offset im Kopf (8 Bytes: offset, laenge).
  // Ohne Offset koennte ein verspaetet ankommendes Stueck an die falsche
  // Stelle geschrieben werden, und die Datei waere still kaputt.

  // Zu jeder pull-Kennung der laufende Auftrag auf DIESEM Arsenal.
  const laufendePulls = new Map();

  async function beginnePull(msg) {
    const p = validatePull(msg);
    if (!p.ok) {
      // Fester Grund zurueckmelden, nie den rohen Inhalt des Befehls.
      log(`pull abgelehnt: ${p.reason}`);
      sende({ type: 'pull-abbruch', id: msg?.id ?? null, grund: p.reason });
      return;
    }

    const name = msg.name;
    try {
      // Der Auftrag entsteht, damit der Fortschritt im Lebenszeichen mitreist
      // und der Takt auf 15 s geht, solange gezogen wird.
      const auftrag = auftraege.anlegen({ art: 'pull', titel: name });
      auftraege.setzeFortschritt(auftrag.id, { prozent: 0, meldung: 'bereit' });

      const lauf = startePull(
        { id: p.id, gesamt: p.gesamt, sha256: p.sha256, ziel: p.ziel },
        { auftraege, auftragId: auftrag.id, meldung: (t) => log(t) },
      );

      // Erst die Datei oeffnen, dann "bereit" sagen. Andersherum schickt die
      // Armory Stuecke an einen Empfaenger, der noch nicht schreiben kann.
      const info = await lauf.oeffne();
      laufendePulls.set(p.id, { lauf, auftragId: auftrag.id, ziel: p.ziel });
      sende({ type: 'bereit', id: p.id, gesamt: info.gesamt });
      log(`pull ${p.id}: Datei geoeffnet (${p.gesamt} Bytes) -> ${p.ziel}`);
      planeHeartbeat(ladeConfig());
    } catch (err) {
      log(`pull ${p.id}: Datei nicht zu oeffnen: ${String(err.message ?? err).slice(0, 200)}`);
      sende({ type: 'pull-abbruch', id: p.id, grund: 'datei' });
    }
  }

  async function nimmDateistueck(puffer) {
    // Kopf: 4 Bytes Offset, 4 Bytes Laenge. Big-Endian, wie im Pruefstand.
    if (puffer.length < 8) {
      log('Stueck zu kurz - verworfen');
      return;
    }
    const offset = puffer.readUInt32BE(0);
    const laenge = puffer.readUInt32BE(4);

    // Der Laengenwert im Kopf muss zum Rest des Puffers passen. Sonst ist der
    // Kopf falsch oder das Stueck unterwegs beschnitten.
    if (laenge <= 0 || 8 + laenge > puffer.length) {
      log(`Stueck mit unmoeglicher Laenge verworfen (${laenge} bei ${puffer.length} Bytes)`);
      return;
    }

    const daten = puffer.subarray(8, 8 + laenge);

    // Welchen Pull betrifft das Stueck? Die Stuecke tragen die Kennung NICHT
    // im Kopf - das waeren 16 Bytes Verwaltung pro 64-KiB-Stueck, bei einem
    // Modpack mit tausenden Stuecken macht das keinen Sinn. Solange genau ein
    // Pull laeuft, ist es eindeutig. Laufen zwei, wird VERWEIGERT statt
    // geraten: ein Stueck im falschen Ziel waere eine still kaputte Datei,
    // und die faellt erst beim Installieren auf.
    if (laufendePulls.size === 0) {
      log('Stueck ohne laufenden pull verworfen');
      return;
    }
    if (laufendePulls.size > 1) {
      log('Stueck verworfen: mehrere pulls gleichzeitig - nicht eindeutig');
      return;
    }
    const [id, eintrag] = [...laufendePulls.entries()][0];

    const r = await nimmStueck(id, { offset, daten });
    if (!r.ok) {
      log(`Stueck abgelehnt (${r.grund}) bei Offset ${offset}`);
      // Ein abgelehntes Stueck heisst: dieser Pull ist nicht mehr zu retten.
      // Nicht weiterspielen, sondern sauber abbrechen und aufraeumen.
      await brichAb(id);
      laufendePulls.delete(id);
      auftraege.beende(eintrag.auftragId, { erfolg: false, fehler: `stueck-${r.grund}` });
      sende({ type: 'pull-abbruch', id, grund: r.grund });
      planeHeartbeat(ladeConfig());
      return;
    }

    // QUITTIEREN: der Armory sagen, dass das Stueck verarbeitet ist.
    //
    // Ohne diese Meldung weiss die Armory nicht, dass ihr Fenster wieder frei
    // ist - und schickt nach 8 Stuecken nichts mehr. Live am 2026-11-09: 6 MB
    // nach oben, 512 KiB angekommen, dann Stillstand. Auf der Sendeseite war
    // das Fenster schuld, hier fehlte die Quittung.
    //
    // Vor schliessePullAb: das Fenster soll auch beim LETZTEN Stueck aufgehen,
    // sonst wartet die Armory auf eine Quittung, die nie kommt.
    sende({ type: 'stand', id, empfangen: r.empfangen });

    // Fertig, sobald alles da ist - NICHT am Verbindungsende. Die Leitung
    // bleibt fuer Befehle offen, ein "close" gibt es hier nicht.
    if (r.empfangen >= r.gesamt) {
      await schliessePullAb(id);
    }
  }

  async function schliessePullAb(id) {
    const eintrag = laufendePulls.get(id);
    if (!eintrag) return;
    laufendePulls.delete(id);

    const r = await beendePull(id);
    if (r.ok) {
      auftraege.setzeFortschritt(eintrag.auftragId, { prozent: 100, meldung: 'gezogen' });
      auftraege.beende(eintrag.auftragId, { erfolg: true, meldung: 'gezogen' });
      log(`pull ${id}: fertig, ${r.groesse} Bytes unter ${r.ziel}`);
      sende({ type: 'pull-fertig', id, ziel: r.ziel, groesse: r.groesse });
    } else {
      auftraege.beende(eintrag.auftragId, { erfolg: false, fehler: String(r.grund) });
      log(`pull ${id}: FEHLGESCHLAGEN (${r.grund}) - Datei wurde entfernt`);
      sende({ type: 'pull-abbruch', id, grund: r.grund });
    }
    planeHeartbeat(ladeConfig());
  }

// --- Verbindung ------------------------------------------------------------

let ws = null;
let letzteNachricht = 0;
let backoff = 0;
let heartbeatTimer = null;
// Auftraege dieses Arsenals (installs, Verschiebungen). Der Takt haengt daran.
const auftraege = erstelleAuftragsliste();
let stillTimer = null;
let beenden = false;

function log(...teile) {
  console.log(new Date().toISOString(), ...teile);
}

function verbinde(cfg) {
  const url = `${cfg.url}?id=${encodeURIComponent(cfg.id)}`;
  // Der Schluessel geht als Header, nicht in der URL: URLs landen in Logs.
  ws = new WebSocket(url, {
    headers: { 'x-arsenal-key': cfg.key },
    handshakeTimeout: 10_000,
  });

  ws.on('open', () => {
    log('verbunden mit der Armory');
    backoff = 0;
    letzteNachricht = Date.now();
    sendeHeartbeat(cfg);
    planeHeartbeat(cfg);
    starteStillpruefung();
  });

  ws.on('message', async (data, istBinaer) => {
    letzteNachricht = Date.now();

    // Binaer = ein Stueck einer Datei, kein JSON. Muss VOR dem JSON-Parse
    // stehen: eine ZIP als JSON zu parsen wirft, und das Stueck waere weg.
    //
    // NUR istBinaer pruefen, NICHT zusaetzlich Buffer.isBuffer.
    //
    // Live auf der VM am 2026-11-09: 'ws' liefert JEDE Nachricht als Buffer,
    // auch JSON. Buffer.isBuffer(data) ist darum immer true, und die Pruefung
    // "istBinaer || Buffer.isBuffer(data)" schluckte jede Steuernachricht als
    // Dateistueck. Der pull-Befehl wurde nie gelesen; der Agent verwarf ihn
    // als "Stueck mit unmoeglicher Laenge". Das Flag ist die einzige
    // verlaessliche Auskunft, ob der Frame binaer war.
    if (istBinaer) {
      await nimmDateistueck(data);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      log('Nachricht ist kein JSON - ignoriert');
      return;
    }

    // pull hat eine eigene Pruefung: hier steht ein PFAD drin.
    if (msg && msg.type === 'pull') {
      await beginnePull(msg);
      return;
    }

    const pruefung = validateCommand(msg);
    if (!pruefung.ok) {
      // Ablehnung zurueckmelden, damit die Armory nicht ins Leere wartet.
      // Der Grund ist ein fester Text, nie der rohe Inhalt.
      sende({ type: 'result', ref: msg?.ref ?? null, ok: false, error: pruefung.reason });
      log(`Befehl abgelehnt: ${pruefung.reason}`);
      return;
    }

    log(`Befehl: ${pruefung.action} ${pruefung.service ?? ''}`);
    const ergebnis = await fuehreAus(pruefung);
    sende({ type: 'result', ref: msg.ref ?? null, ...ergebnis });
  });

  ws.on('close', () => {
    aufraeumen();
    if (beenden) return;
    backoff = nextBackoff(backoff || 1000);
    log(`Verbindung weg - neuer Versuch in ${Math.round(backoff / 1000)} s`);
    setTimeout(() => verbinde(cfg), backoff);
  });

  ws.on('error', (err) => {
    // Kein Stacktrace mit Schluessel: nur die Art des Fehlers.
    log(`Verbindungsfehler: ${err.code ?? err.message}`);
  });
}

function sende(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Der Takt des Lebenszeichens haengt am ZUSTAND DER ARBEIT (Felix,
// 2026-11-09): "im Idle oder normalem Tagesgeschaeft 30 Sekunden, bei
// installs oder server verschieben alle 15 Sekunden bis fertig".
//
// Darum KEIN setInterval: das haelt eine feste Zeit fest und muesste bei
// jeder Aenderung neu gesetzt werden. Die Kette entscheidet nach jedem
// Senden neu - kostet nichts und kann nicht auseinanderlaufen.
function planeHeartbeat(cfg) {
  clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    if (beenden || !ws || ws.readyState !== 1) return;
    sendeHeartbeat(cfg);
    planeHeartbeat(cfg);
  }, auftraege.taktMs());
  // Nicht den Prozess am Leben halten, nur weil ein Timer laeuft.
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

function sendeHeartbeat(cfg) {
  const offen = auftraege.fuerHerzschlag();
  sende(heartbeatMessage({
    id: cfg.id,
    version: AGENT_VERSION,
    hostname: os.hostname(),
    // Ohne Auftraege faellt das Feld weg - ein Herzschlag mit leerer Liste
    // waere nur Rauschen (siehe arsenalJobs.fuerHerzschlag()).
    ...(offen.length > 0 ? { jobs: offen } : {}),
  }));
  letzteNachricht = Date.now();
}

// Ohne das merkt der Agent einen stillen Abbruch nie: eine tote
// TCP-Verbindung kann bestehen bleiben, ohne dass 'close' kommt.
function starteStillpruefung() {
  clearInterval(stillTimer);
  stillTimer = setInterval(() => {
    if (shouldReconnect({ now: Date.now(), lastMessageAt: letzteNachricht })) {
      log('Leitung still - baue neu auf');
      try { ws?.terminate(); } catch { /* egal */ }
    }
  }, 15_000);
}

function aufraeumen() {
  clearTimeout(heartbeatTimer);
  clearInterval(stillTimer);
  heartbeatTimer = null;
  stillTimer = null;
}

// --- Start -----------------------------------------------------------------

function main() {
  let cfg;
  try {
    cfg = ladeConfig();
  } catch (err) {
    // Kein Schluessel im Log - nur der Grund.
    console.error(`[arsenal] ${err.message}`);
    process.exit(1);
  }

  log(`Arsenal-Agent ${AGENT_VERSION} startet (ID ${cfg.id})`);
  verbinde(cfg);

  const beende = (signal) => {
    beenden = true;
    log(`${signal} - beende`);
    aufraeumen();
    try { ws?.close(); } catch { /* egal */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => beende('SIGTERM'));
  process.on('SIGINT', () => beende('SIGINT'));
}

main();
