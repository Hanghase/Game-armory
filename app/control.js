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
// Docker-Helfer (seit 2026-11-07). Gebunden an EINE Compose-Datei
// (Pfad im Skript), Dienste nur aus fester Whitelist. Grund: Der
// armory-User ist NICHT in der docker-Gruppe - wer den Socket schreiben
// darf, ist de facto root. Deshalb liest der Helfer als root und gibt
// nur die Auswertung zurueck.
const DOCKER_CTL = '/usr/local/bin/armory-docker-ctl';
const DOCKER_SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export async function serviceAction(service, action, deps = {}) {
  const run = deps.run ?? execFileAsync;

  // Unerlaubte Aktion bleibt ein Wurf: der Wert kommt aus einer festen
  // Whitelist im Code, nicht aus der Route. Ein falscher Wert ist ein
  // Programmierfehler und soll beim Entwickeln auffallen.
  if (!ALLOWED_ACTIONS.includes(action)) {
    throw new Error(`Unerlaubte Aktion: ${action}`);
  }

  // Bugfix 2026-11-07: Vorher warf ein fehlender/ungültiger Service-Name
  // (`Ungültiger Service-Name: undefined`). Der Aufrufer im Request-Pfad
  // hatte kein try/catch, und ein docker-Sword hat gar keinen systemd-
  // Service - ein Klick auf Stop bei Nextcloud endete so in einer
  // unbehandelten Ausnahme statt in einer Meldung. Jetzt: Ergebnisobjekt.
  // Rückgabeform wie im catch-Zweig, damit der Aufrufer nur EINE Form kennt.
  const ergebnis = (error) => ({ ok: false, action, service, error });

  // Ein Sword-Objekt statt eines Namens: Steuerart auswerten. Ein docker-
  // Sword hat keinen systemd-Service, und der Docker-Helfer
  // (armory-docker-ctl) kennt bewusst nur status|ps|logs. Start/Stop/Re-
  // start für Docker ist NICHT freigegeben - das muss die Meldung sagen,
  // statt eine systemd-Einheit zu erfinden.
  if (service && typeof service === 'object') {
    const control = service.control ?? {};
    if (control.type === 'docker') {
      return ergebnis('Docker-Steuerung für diesen Sword ist noch nicht freigegeben '
        + '(der Helfer kann nur status, ps und logs)');
    }
    return serviceAction(control.service, action, deps);
  }

  if (typeof service !== 'string' || service.trim() === '') {
    return ergebnis(`Kein Service im Sword definiert (Aktion: ${action})`);
  }
  if (!SERVICE_RE.test(service)) {
    return ergebnis(`Ungültiger Service-Name: ${service}`);
  }
  try {
    await run('sudo', ['-n', SERVICE_CTL, action, service]);
    return { ok: true, action, service };
  } catch (err) {
    // Live-Befund 2026-11-07: execFile liefert bei einem Fehler des Helfers
    // 'Command failed' als message; die eigentliche Begruendung steht in
    // stderr ("Fehler: Einheit ... nicht gefunden"). Vorher ging nur
    // err.message ins Panel - also der nichtssagende Teil. Jetzt stderr
    // zuerst, wie es serviceStatus/dockerLogs schon machen.
    const grund = (err.stderr || err.message || '').toString().trim();
    return { ok: false, action, service, error: grund || 'Steuerung fehlgeschlagen' };
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
//                             { type: "file", path, lines? }  ODER
//                             { type: "docker", service }     (seit 2026-11-07)
// streamLogs liefert einen ChildProcess-ähnlichen Handle mit .kill()
//
// Warum docker dazu kam: streamLogs kannte nur file und journald. Alles andere
// fiel in den journald-Zweig, der `sword.control.service` liest - ein
// Docker-Sword hat den nicht. Live belegt am 2026-11-07:
//   streamLogs({logs:{type:'docker',service:'nc-app'},...})
//   -> Fehler: Ungültige Unit: undefined
// Der Log-Knopf im Panel war fuer NC also tot (wie der Stop-Knopf).

function streamJournald(sword, onData, { lines = 100, spawn: spawnFn = spawn } = {}) {
  const unit = sword.logs?.unit ?? sword.control?.service;
  if (!SERVICE_RE.test(unit)) throw new Error(`Ungültige Unit: ${unit}`);
  // Ueber den Service-Ctl-Helfer (sudoers: nur dieses Skript + journalctl-Sperre).
  // Der Helfer prueft Aktions- und Service-Whitelist selbst.
  const child = spawnFn('sudo', [
    '-n', SERVICE_CTL, 'logs', unit,
  ]);
  child.stdout.on('data', (c) => onData(c.toString()));
  child.stderr.on('data', (c) => onData(c.toString()));
  return child;
}

// Docker-Logs ueber den engen Helfer. Der Dienstname wird hier ZUSAEZTLICH
// gegen DOCKER_SERVICE_RE geprueft, damit bei einem unsinnigen Namen gar kein
// Prozess startet (der Helfer prueft ihn ebenfalls).
function streamDocker(sword, onData, { lines = 100, spawn: spawnFn = spawn } = {}) {
  const service = sword.logs?.service;
  if (typeof service !== 'string' || !DOCKER_SERVICE_RE.test(service)) {
    throw new Error(`Ungültiger Docker-Dienst: ${service}`);
  }
  const child = spawnFn('sudo', ['-n', DOCKER_CTL, 'logs', service, String(lines)]);
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
  if (type === 'docker') return streamDocker(sword, onData, opts);
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
  //
  // Bugfix 2026-11-07: Docker liefert keine Startzeit (dockerStatus() setzt
  // changedAt: null, weil `docker compose ps` keinen systemd-Zeitstempel
  // kennt). Vorher wurde daraus NaN, `NaN < READY_FALLBACK_MS` ist falsch,
  // ageMs fiel auf 0, und `new Date(NaN).toISOString()` warf
  // "RangeError: Invalid time value" - live sichtbar als 'unknown' beim
  // Sword 'nextcloud'. Deshalb: Zeitvergleich NUR bei echter Startzeit
  // (endlich und > 0). Sonst Status unveraendert durchreichen.
  // Begruendung: Ein laufender Container hat keinen "faehrt gerade hoch"-
  // Begriff wie ein 7d2d mit 60-90 s Weltladezeit. Ohne Startzeit gibt es
  // kein Zeitfenster, in dem "starting" richtig waere - also nichts erfinden.
  const changedSec = Number.parseInt(String(status.changedAt ?? ''), 10);
  const startedAt = Number.isFinite(changedSec) && changedSec > 0 ? changedSec * 1000 : NaN;
  if (Number.isFinite(startedAt)) {
    const ageMs = Date.now() - startedAt;
    // Juenger als das Fenster -> noch "startet" (systemd-Verhalten unveraendert).
    if (ageMs < READY_FALLBACK_MS) {
      return { ...status, ready: false, readyMarker: null, readyError: hit.error ?? null,
               state: 'starting',
               startedAt: new Date(startedAt).toISOString(), ageMs };
    }
  } else {
    // Keine echte Startzeit -> Status unveraendert, aber den Marker-Befund
    // (z.B. "keine readyMarkers im Rack") mitgeben.
    return { ...status, ready: false, readyMarker: null, readyError: hit.error ?? null };
  }
  // Rueckfall: laeuft lange genug -> "running", auch ohne Marker.
  return { ...status, ready: false, readyMarker: null, readyError: hit.error ?? null,
           readyByTimeout: true };
}

// ---------------------------------------------------------------------------
// Steuerart auswerten (2026-11-07)
//
// `control.type` steht seit v1.0.0 im Schema (systemd | screen | tmux | docker |
// process), wurde aber NIE gelesen: server.js holte sich blind
// `sword.control.service` und rief den systemd-Helfer. Ein Docker-Stack
// (Nextcloud: /opt/nextcloud/docker-compose.yml) hat keinen systemd-Service -
// dort kam "Ungültiger Service-Name: undefined" heraus statt einer Aussage.
//
// Gelesen wird hier nur. Start/Stop fuer Docker kommt spaeter und braucht einen
// eigenen, engen Helfer (docs/rack-schema.md:179).
// ---------------------------------------------------------------------------

const COMPOSE_RE = /^\/[A-Za-z0-9@._/-]+\.ya?ml$/;

/**
 * Welche Steuerart nutzt dieser Sword?
 * Ohne type -> systemd. Das ist Pflicht, weil alle Bestands-Swords
 * (atm11, atm10, 7d2d, teamspeak) kein type-Feld haben.
 */
export function controlKind(sword) {
  const t = sword?.control?.type;
  if (t === 'docker') return 'docker';
  return 'systemd';
}

/**
 * Zustand eines Docker-Compose-Stacks - ueber den engen Helfer.
 *
 * ERSTE FASSUNG WAR FALSCH (2026-11-07): Sie rief `docker compose ps` direkt
 * auf, in der Annahme "Lesen braucht keine Rechte". Das stimmt beim
 * Docker-Socket nicht - als armory-User kam
 *   permission denied while trying to connect to the Docker daemon socket
 * und zusaetzlich "open /opt/nextcloud/.env: permission denied".
 * Deshalb geht der Weg jetzt ueber `sudo armory-docker-ctl status`:
 * der Helfer liest als root und gibt nur die Auswertung zurueck.
 * Der compose-Pfad geht NICHT als Argument mit, er steht im Helfer.
 *
 * @param {{compose: string, services?: string[]}} control
 * @param {{run?: Function}} [deps]  Injektion fuer Tests
 */
export async function dockerStatus(control, deps = {}) {
  const run = deps.run ?? execFileAsync;
  const compose = control?.compose;
  const leer = { kind: 'docker', state: 'unknown', subState: null, changedAt: null,
    running: false, services: [] };

  if (!compose || !COMPOSE_RE.test(compose)) {
    return { ...leer, error: `Ungültiger compose-Pfad: ${compose ?? '(fehlt)'}` };
  }

  let stdout;
  try {
    // Ueber den Helfer, NICHT direkt: der armory-User darf den Docker-Socket
    // nicht ansprechen (siehe Kopf dieser Funktion).
    ({ stdout } = await run('sudo', ['-n', DOCKER_CTL, 'status']));
  } catch (err) {
    return { ...leer, error: (err.stderr || err.message || '').toString().trim() || 'docker compose ps fehlgeschlagen' };
  }

  // `docker compose ps --format json` liefert je Dienst ein JSON-Objekt,
  // zeilenweise. Aeltere Versionen liefern ein JSON-Array - beides abfangen.
  const texte = String(stdout).trim();
  let roh = [];
  if (texte.startsWith('[')) {
    try { roh = JSON.parse(texte); } catch { roh = []; }
  } else {
    for (const zeile of texte.split('\n')) {
      const z = zeile.trim();
      if (!z) continue;
      try { roh.push(JSON.parse(z)); } catch { /* Muellzeile ignorieren */ }
    }
  }

  const erwartet = Array.isArray(control?.services) && control.services.length
    ? control.services
    : roh.map((r) => r.Service ?? r.Name ?? '?');

  const dienste = erwartet.map((name) => {
    const treffer = roh.find((r) => (r.Service ?? r.Name) === name);
    const zustand = (treffer?.State ?? 'missing').toLowerCase();
    return {
      name,
      state: zustand,
      health: treffer?.Health || null,
      status: treffer?.Status || null,
      up: zustand === 'running',
    };
  });

  const laufen = dienste.filter((d) => d.up).length;
  let state;
  if (laufen === dienste.length && dienste.length > 0) state = 'running';
  else if (laufen === 0) state = 'stopped';
  else state = 'degraded';

  return {
    kind: 'docker',
    state,
    subState: `${laufen}/${dienste.length}`,
    changedAt: null,
    running: state === 'running',
    services: dienste,
  };
}

/**
 * Logs eines Docker-Dienstes ueber den Helfer.
 *
 * Der Dienstname wird hier ZUSAETZLICH geprueft (der Helfer prueft ihn auch) -
 * so startet bei einem offensichtlich falschen Namen gar kein Prozess.
 * Die Ausgabe kommt als Text, nicht als JSON: Logs sind zeilenweise.
 *
 * @param {string} service  Whitelist-Dienst (nc-app | nc-db | nc-redis)
 * @param {number} [lines]  Zeilen, Standard 200
 * @returns {Promise<string>} Log-Text oder eine Fehlermeldung als Text
 */
export async function dockerLogs(service, lines = 200, deps = {}) {
  const run = deps.run ?? execFileAsync;

  if (typeof service !== 'string' || !DOCKER_SERVICE_RE.test(service)) {
    return `Dienst nicht erlaubt: ${service ?? '(fehlt)'}`;
  }
  const n = Number.isFinite(Number(lines)) ? Math.max(1, Math.min(2000, Number(lines))) : 200;

  try {
    const { stdout } = await run('sudo', ['-n', DOCKER_CTL, 'logs', service, String(n)]);
    return String(stdout ?? '');
  } catch (err) {
    const grund = (err.stderr || err.message || '').toString().trim();
    return `Logs nicht abrufbar: ${grund || 'unbekannter Fehler'}`;
  }
}
