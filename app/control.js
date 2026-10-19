// Game-Armory - Server Control (systemd-basiert)
// Steuert Gameserver über systemd-Services. Kein Docker, kein Wings.
// Alle Aktionen sind fest definiert (kein freier Shell-Zugriff aus dem Web).
// Die Parameter sind Sword-Instanz-Objekte (swords/*.sword.json).

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';

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

export async function serviceStatus(service) {
  if (!SERVICE_RE.test(service)) {
    throw new Error(`Ungültiger Service-Name: ${service}`);
  }
  try {
    const { stdout } = await execFileAsync('sudo', ['-n', SERVICE_CTL, 'is-active', service]);
    const active = stdout.trim();
    return { service, state: active, running: active === 'active' };
  } catch (err) {
    const state = (err.stdout || 'inactive').trim();
    return { service, state, running: false };
  }
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
