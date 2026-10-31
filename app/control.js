// Game-Armory - Server Control (systemd-basiert)
// Steuert Gameserver über systemd-Services. Kein Docker, kein Wings.
// Alle Aktionen sind fest definiert (kein freier Shell-Zugriff aus dem Web).
// Die Parameter sind Sword-Instanz-Objekte (swords/*.sword.json).

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';

const execFileAsync = promisify(execFile);

// Whitelist erlaubter systemctl-Aktionen - niemals beliebige Argumente durchreichen
const ALLOWED_ACTIONS = ['start', 'stop', 'restart'];

const SERVICE_RE = /^[a-zA-Z0-9@._-]+\.service$/;

// Privilegierte Helfer (siehe /etc/sudoers.d/armory). Die Armory laeuft als
// unprivilegierter User "armory" und darf NUR diese zwei festen Skripte per
// sudo aufrufen; sie pruefen Aktion, Service-Namen und Whitelist selbst.
const SERVICE_CTL = '/usr/local/bin/armory-service-ctl';

export async function serviceAction(service, action) {
  if (!ALLOWED_ACTIONS.includes(action)) {
    throw new Error(`Unerlaubte Aktion: ${action}`);
  }
  if (!SERVICE_RE.test(service)) {
    throw new Error(`Ungültiger Service-Name: ${service}`);
  }
  try {
    await execFileAsync('sudo', ['-n', SERVICE_CTL, action, service]);
    return { ok: true, action, service };
  } catch (err) {
    return { ok: false, action, service, error: err.message };
  }
}

// Bugfix 2026-10-31: vorher nur `is-active` -> EINE Zeile, und daraus wurde
// running = (state === 'active'). Damit sahen "startet gerade" (activating)
// und "ist aus" (inactive) im Panel gleich aus. Ein 7d2d braucht ~60 s bis
// spielbar, in der Zeit behauptete das Panel "gestoppt".
// Jetzt liefert der Helfer ActiveState + SubState + Zeitstempel, und die
// Anzeige bekommt einen echten Zustand statt eines Bools.
//
// WICHTIG: Die Grundlage ist systemd (stabil). Der Log-Marker des Spiels
// entscheidet NICHT ueber den Zustand - er darf sich mit jedem Spiel-Update
// aendern (live erlebt: "Done (" -> "StartGame done" bei 7d2d). Deshalb hier
// nur systemd-Daten; die Spielbereitschaft kommt getrennt dazu.
export async function serviceStatus(service) {
  if (!SERVICE_RE.test(service)) {
    throw new Error(`Ungültiger Service-Name: ${service}`);
  }
  let activeState = 'inactive';
  let subState = null;
  let changedAt = null;
  try {
    const { stdout } = await execFileAsync('sudo', ['-n', SERVICE_CTL, 'state', service]);
    for (const line of String(stdout).split('\n')) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key === 'ActiveState' && val) activeState = val;
      else if (key === 'SubState' && val) subState = val;
      // systemd liefert mit --timestamp=unix "@1793454969". Date.parse("Sat ... CET")
      // ergibt NaN - deshalb hier die Unix-Sekunden direkt lesen (Bugfix 2026-10-31).
      else if (key === 'StateChangeTimestamp' && val) {
        const m = /^@(\d+)$/.exec(val);
        changedAt = m ? m[1] : val;          // Unix-Sekunden als String, sonst roh
      }
    }
  } catch (err) {
    // Helfer nicht erreichbar / Dienst unbekannt -> als inaktiv melden,
    // aber den Grund mitgeben statt ihn zu verschlucken.
    return { service, state: 'inactive', subState: null, changedAt: null, running: false,
      error: (err.stderr || err.message || '').trim() || undefined };
  }

  // Ein Zustand, den das Frontend direkt anzeigen kann. Absichtlich grob:
  // "failed" ist ein eigener Fall, weil systemd ihn sonst als inaktiv zeigt.
  let state;
  if (activeState === 'active' && subState === 'running') state = 'running';
  else if (activeState === 'activating') state = 'starting';
  else if (activeState === 'deactivating') state = 'stopping';
  else if (activeState === 'failed' || subState === 'failed') state = 'failed';
  else state = 'stopped';

  return {
    service,
    state,                       // running | starting | stopping | stopped | failed
    activeState,                 // roh von systemd, fuer Diagnose
    subState,                    // roh: start | running | stop | ...
    changedAt,                   // seit wann in diesem Zustand
    running: state === 'running',
  };
}

// --- Log-Quellen -----------------------------------------------------------
// Sword definiert in `logs`:  { type: "journald", unit }  ODER
//                             { type: "file", path, lines? }
// streamLogs liefert einen ChildProcess-ähnlichen Handle mit .kill()

function streamJournald(sword, onData, { lines = 100 } = {}) {
  const unit = sword.logs?.unit ?? sword.control?.service;
  if (!SERVICE_RE.test(unit)) throw new Error(`Ungültige Unit: ${unit}`);
  // Ueber den Service-Ctl-Helfer (sudoers: nur dieses Skript + journalctl-Sperre).
  // Der Helfer prueft Aktions- und Service-Whitelist selbst.
  const child = spawn('sudo', [
    '-n', SERVICE_CTL, 'logs', unit,
  ]);
  child.stdout.on('data', (c) => onData(c.toString()));
  child.stderr.on('data', (c) => onData(c.toString()));
  return child;
}

function streamFile(sword, onData, { lines = 100 } = {}) {
  const path = sword.logs?.path;
  if (!path) throw new Error('Kein Log-Pfad im Sword definiert');

  // Eigenes Follow statt `tail -F`: `tail -F` beendet sich nie und bleibt
  // deshalb beim Stop einfach stehen. Hier lesen wir ab einem Byte-Offset
  // und melden nur, was wirklich neu dazukommt.
  return new FollowStream(path, onData, { lines });
}

// FollowStream ist ein ChildProcess-aehnlicher Handle mit .kill().
class FollowStream extends EventEmitter {
  constructor(path, onData, { lines = 100, pollMs = 500 } = {}) {
    super();
    this.path = path;
    this.onData = onData;
    this.pollMs = pollMs;
    this.offset = 0;
    this.stopped = false;

    // Startpunkt: die letzten `lines` Zeilen zuerst senden.
    try {
      const { size } = statSync(path);
      this.offset = Math.max(0, size - 64 * 1024);
      const tail = this.readRange(this.offset, size);
      const parts = tail.split('\n');
      if (parts.length > lines) {
        this.emitData(parts.slice(-lines - 1).join('\n'));
      } else {
        this.emitData(tail);
      }
      this.offset = size;
    } catch {
      this.offset = 0;
    }

    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  readRange(from, to) {
    if (to <= from) return '';
    const fd = openSync(this.path, 'r');
    try {
      const len = to - from;
      const buf = Buffer.allocUnsafe(len);
      const read = readSync(fd, buf, 0, len, from);
      return buf.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
  }

  emitData(chunk) {
    if (!this.stopped && chunk) this.onData(chunk);
  }

  tick() {
    if (this.stopped) return;
    let size;
    try {
      size = statSync(this.path).size;
    } catch {
      return; // Datei (noch) nicht da - warten
    }
    if (size < this.offset) {
      this.offset = 0; // Datei rotiert/geleert -> neu einsteigen
    }
    if (size > this.offset) {
      this.emitData(this.readRange(this.offset, size));
      this.offset = size;
    }
  }

  kill() {
    this.stopped = true;
    clearInterval(this.timer);
    this.emit('exit', 0);
    return true;
  }
}

export function streamLogs(sword, onData, opts = {}) {
  const type = sword.logs?.type ?? 'journald';
  if (type === 'file') return streamFile(sword, onData, opts);
  return streamJournald(sword, onData, opts);
}


// --- Spielbereitschaft: "startet" vs "laeuft" -------------------------------
// Warum getrennt von systemd: systemd setzt `active`, sobald der Prozess
// geforkt ist (Type=simple). Ein 7d2d braucht danach noch ~60 s bis die Welt
// geladen ist. Live gemessen am 31.10.: `activating` war nach <1 s vorbei,
// `active/running` schon da, spielbar erst eine Minute spaeter.
//
// Grundlage bleibt systemd (state aus serviceStatus). Der Log-Marker ist nur
// die Verfeinerung: steht er im Log, ist der Server bereit -> "running".
// Steht er nicht und der Prozess laeuft juenger als READY_FALLBACK_MS, ist es
// "starting". Danach faellt es auf "running" zurueck - die Anzeige behauptet
// also NIE faelschlich "gestoppt", wenn ein Spiel seinen Log-Text aendert.
//
// Die Marker stehen im Rack (readyMarkers), nicht im Code: ein neuer
// Spiel-Build mit neuem Log-Format ist ein Rack-Eintrag, kein Deploy.
export const READY_FALLBACK_MS = 90_000;

/**
 * Liest die letzten Bytes eines Logs und prueft auf die Ready-Marker.
 * @returns {Promise<{ready: boolean, matched: string|null}>}
 */
async function logHasReadyMarker(sword, markers) {
  if (!Array.isArray(markers) || markers.length === 0) {
    return { ready: false, matched: null, error: 'keine readyMarkers im Rack' };
  }
  const src = sword?.logs;
  if (!src) {
    // Kein Log im Sword -> die Bereitschaft ist NICHT pruefbar. Das darf nicht
    // stillschweigend als "kein Marker" durchgehen (live: getSword() war leer,
    // weil der Sword-Cache nicht geladen war - die Anzeige blieb ratlos auf
    // "startet", ohne dass irgendwo stand warum).
    return { ready: false, matched: null, error: 'kein log im sword definiert' };
  }
  let text = '';
  try {
    if (src?.type === 'file' && src.path) {
      const fh = await fsp.open(src.path, 'r');
      try {
        const { size } = await fh.stat();
        const TAIL = 256 * 1024;               // nur das Ende interessant
        const from = Math.max(0, size - TAIL);
        const buf = Buffer.alloc(Math.min(TAIL, size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, from);
        text = buf.subarray(0, bytesRead).toString('utf8');
      } finally {
        await fh.close();
      }
    } else if (src?.type === 'journald') {
      const unit = src.unit ?? sword?.control?.service;
      if (unit && SERVICE_RE.test(unit)) {
        const { stdout } = await execFileAsync('sudo', ['-n', SERVICE_CTL, 'logs', unit]);
        text = String(stdout);
      }
    }
  } catch (err) {
    // Log (noch) nicht lesbar - Grund mitgeben, nicht verschlucken.
    return { ready: false, matched: null, error: `log nicht lesbar: ${err.code || err.message}` };
  }
  for (const m of markers) {
    if (m && text.includes(m)) return { ready: true, matched: m, error: null };
  }
  return { ready: false, matched: null, error: null };
}

/**
 * Verfeinert den systemd-Zustand um die Spielbereitschaft.
 * "running" -> "starting", solange der Prozess laeuft, kein Marker im Log
 * steht und er juenger als READY_FALLBACK_MS ist.
 */
export async function withReadiness(sword, status, markers) {
  if (!status || status.state !== 'running') return status;
  const hit = await logHasReadyMarker(sword, markers);
  if (hit.ready) return { ...status, ready: true, readyMarker: hit.matched, readyError: null };

  // changedAt kommt jetzt als Unix-Sekunden-String vom Helfer (@<epoch>).
  // Kein Date.parse mehr - das scheiterte am "CET"-Format (live belegt NaN).
  const changedSec = Number.parseInt(String(status.changedAt ?? ''), 10);
  const startedAt = Number.isFinite(changedSec) ? changedSec * 1000 : NaN;
  // Unbekannte Startzeit -> NICHT sofort "laeuft" behaupten, sondern das
  // Zeitfenster als laufend behandeln: "startet" ist die vorsichtigere Aussage.
  const ageMs = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
  if (ageMs < READY_FALLBACK_MS) {
    return { ...status, ready: false, readyMarker: null, readyError: hit.error ?? null,
             state: 'starting',
             startedAt: new Date(startedAt).toISOString(), ageMs };
  }
  // Rueckfall: laeuft lange genug -> "running", auch ohne Marker.
  return { ...status, ready: false, readyMarker: null, readyError: hit.error ?? null,
           readyByTimeout: true };
}
