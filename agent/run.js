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
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import {
  validateCommand,
  heartbeatMessage,
  shouldReconnect,
  nextBackoff,
  HEARTBEAT_MS,
} from './logic.js';

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

// --- Verbindung ------------------------------------------------------------

let ws = null;
let letzteNachricht = 0;
let backoff = 0;
let heartbeatTimer = null;
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
    heartbeatTimer = setInterval(() => sendeHeartbeat(cfg), HEARTBEAT_MS);
    starteStillpruefung();
  });

  ws.on('message', async (data) => {
    letzteNachricht = Date.now();
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      log('Nachricht ist kein JSON - ignoriert');
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

function sendeHeartbeat(cfg) {
  sende(heartbeatMessage({ id: cfg.id, version: AGENT_VERSION, hostname: os.hostname() }));
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
  clearInterval(heartbeatTimer);
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
