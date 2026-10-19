// Game-Armory - Installer
// Legt einen neuen Gameserver an: Zielordner, ZIP entpacken, RCON-Passwort,
// server.properties (RCON), Rack-SCHABLONE + Sword-INSTANZ und systemd-Unit.
//
// SICHERHEIT / RECHTE:
//   * Es gibt KEINE freien Shell-Aufrufe aus Nutzereingaben. Alle externen
//     Kommandos laufen ueber runCmd() (execFile, ohne Shell) mit festen
//     Argumenten.
//   * Alle systemd-Eingriffe laufen ueber die klar umgrenzten Helper
//     systemWriteService() / systemctl(), damit man spaeter sauber auf
//     sudo-Regeln umstellen kann (nur diese beiden Funktionen brauchen root).
//   * eula.txt wird NIE automatisch angefasst (Compliance) - der Betreiber
//     muss die EULA bewusst selbst akzeptieren. Der Installer meldet das
//     im Ergebnis.
//   * Validierung: id ^[a-z0-9][a-z0-9-]{1,30}$, Port 1024-65535, Name <= 60.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdir, writeFile, readFile, rm, chmod, stat, access,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { extractToTemp, extractTarballToTemp, replacePackContents, validatePackZip, PackError, listTarball } from './pack.js';
import { getRack, getRacks, loadRacks } from './racks.js';
import { getMod, getFiles, getDownloadUrl, downloadFile } from './curseforge.js';

const execFileAsync = promisify(execFile);

export const MINECRAFT_ROOT = '/opt/minecraft';
export const ARMORY_ROOT = '/opt/game-armory';
export const RACKS_DIR = join(ARMORY_ROOT, 'racks');      // Schablonen (*.rack.json)
export const SWORDS_DIR = join(ARMORY_ROOT, 'swords');    // Instanzen (*.sword.json)
export const DATA_DIR = join(ARMORY_ROOT, 'data');
export const SYSTEMD_DIR = '/etc/systemd/system';
// Privilegierter Install-Helfer (siehe /etc/sudoers.d/armory). Die Armory laeuft
// unprivilegiert; alle root-pflichtigen Install-Schritte gehen ueber dieses Skript.
export const INSTALL_HELPER = '/usr/local/bin/armory-install-helper';
// Privilegierter Steam-Helfer: SteamCMD-Setup + App-Installationen.
// Zugangsdaten gehen ausschliesslich per STDIN (nie als Argument -> kein ps-Leak).
export const STEAM_HELPER = '/usr/local/bin/armory-steam-helper';
export const SERVICE_CTL = '/usr/local/bin/armory-service-ctl';
const GAME_ROOTS = { minecraft: '/opt/minecraft', '7d2d': '/opt/7d2d', teamspeak6: '/opt/teamspeak6' };
const ARMORY_SCRIPT = join(ARMORY_ROOT, 'tools', 'rcon-stop.mjs');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const SERVICE_RE = /^[a-zA-Z0-9@._-]+\.service$/;
const SYSTEMCTL_ACTIONS = ['daemon-reload', 'enable', 'disable', 'start', 'stop', 'restart'];

export class InstallerError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'InstallerError';
    this.status = status;
  }
}

// --- Validierung -----------------------------------------------------------

export function validateInstallInput({ id, name, port }) {
  if (!id || !ID_RE.test(id)) {
    throw new InstallerError(
      'Ungueltige ID: nur a-z, 0-9 und "-"; 2-31 Zeichen; muss mit Buchstabe/Zahl beginnen.',
    );
  }
  if (!name || String(name).trim().length === 0) {
    throw new InstallerError('Name fehlt.');
  }
  if (String(name).length > 60) {
    throw new InstallerError('Name zu lang (max. 60 Zeichen).');
  }
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    throw new InstallerError('Ungueltiger Port (1024-65535).');
  }
  return { id, name: String(name).trim(), port: p };
}

// --- System-Helper (brauchen root) -----------------------------------------

// Feste, argumentbasierte Kommandos - nie aus Nutzereingaben zusammengesetzt.
async function runCmd(cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args);
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '', error: err.message };
  }
}

// Wie runCmd, aber schiebt `input` auf STDIN (fuer den Unit-Inhalt beim Helfer).
async function runCmdWithInput(cmd, args, input, { onLine = null } = {}) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    // Zeilenweise Auswertung: SteamCMD schreibt Fortschritt auf STDOUT.
    // Der Helper leitet per `tee` live weiter - hier darf also nicht
    // gepuffert werden, sonst ist der Fortschritt erst nach dem Ende da.
    let stdoutTail = '';
    const handleChunk = (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!onLine) return;
      stdoutTail += text;
      let nl;
      while ((nl = stdoutTail.indexOf('\n')) >= 0) {
        const line = stdoutTail.slice(0, nl);
        stdoutTail = stdoutTail.slice(nl + 1);
        if (line.trim()) { try { onLine(line); } catch { /* Callback-Fehler ignorieren */ } }
      }
    };
    child.stdout.on('data', handleChunk);
    // SteamCMD schreibt Fortschritt teils auf STDERR -> auch dort auswerten.
    child.stderr.on('data', (c) => {
      const text = c.toString();
      stderr += text;
      if (onLine && text.trim()) {
        for (const line of text.split('\n')) {
          if (line.trim()) { try { onLine(line); } catch { /* ignorieren */ } }
        }
      }
    });
    child.on('error', (err) => resolve({ ok: false, stdout, stderr, error: err.message }));
    child.on('close', (code) => resolve({
      ok: code === 0, stdout, stderr, error: code === 0 ? undefined : `exit ${code}`,
    }));
    if (input !== undefined && input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

// --- SteamCMD-Fortschritt ----------------------------------------------------
// SteamCMD schreibt Zeilen wie:
//   Update state (0x61) downloading, progress: 43.21 (7612345678 / 17607545324)
//   Update state (0x81) verifying update, progress: 12.01 (...)
//   Update state (0x101) committing, progress: 90.26 (...)
//   Success! App '294420' fully installed.
// Die 0x-Prefix sind Bitmasken, keine festen Werte (0x61 = running|download|active).
// Daher auf die enthaltenen Bits pruefen, nicht auf exakte Zahlen.
const STEAM_PHASES = [
  { bit: 0x20, label: 'Download', verb: 'Lade herunter' },
  { bit: 0x80, label: 'Verifizierung', verb: 'Pruefe Dateien' },
  { bit: 0x100, label: 'Installation', verb: 'Installiere Dateien' },
  { bit: 0x200, label: 'Update', verb: 'Schliesse Update ab' },
];

// Parst eine SteamCMD-Zeile. Gibt { phase, percent } oder null zurueck.
export function parseSteamProgress(line) {
  if (!line) return null;
  const success = /Success!\s+App\s+'?\d+'?\s+fully installed/i.test(line);
  if (success) return { phase: 'Installation', percent: 100, done: true };

  const m = line.match(/Update state \((0x[0-9a-fA-F]+)\)\s*([a-z ]*?),\s*progress:\s*([0-9.]+)/i);
  if (!m) return null;
  const state = parseInt(m[1], 16);
  const percent = Math.max(0, Math.min(100, Number(m[3])));
  // Reihenfolge zaehlt: commit (0x100) vor download (0x20) pruefen, sonst
  // wuerde eine Kombination falsch als Download gedeutet.
  const ordered = [...STEAM_PHASES].reverse();
  for (const p of ordered) {
    if (state & p.bit) return { phase: p.label, percent, done: false };
  }
  // 0x0 = unknown -> nur ein Abschluss-Marker, kein Fortschritt.
  if (state === 0) return { phase: 'Installation', percent: null, done: true };
  return null;
}

// systemctl mit Whitelist - der einzige Ort, der systemctl aufruft.
// Aufrufformen: ['daemon-reload'] ODER ['enable', 'atm11.service'] etc.
// Die Aktion ist das ERSTE Argument; ein folgender Service-Name ist optional.
export async function systemctl(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new InstallerError('systemctl: leere Argumentliste');
  }
  const action = args[0];
  const target = args.length > 1 ? args[1] : null;
  if (!SYSTEMCTL_ACTIONS.includes(action)) {
    throw new InstallerError(`systemctl: unerlaubte Aktion ${action}`);
  }
  if (target !== null && !SERVICE_RE.test(target)) {
    throw new InstallerError(`systemctl: ungueltiger Service-Name ${target}`);
  }
  // Ueber den Install-Helfer (sudo), da die Armory unprivilegiert laeuft.
  if (action === 'daemon-reload') {
    return runCmd('sudo', ['-n', INSTALL_HELPER, 'daemon-reload']);
  }
  if (action === 'enable' && target !== null) {
    return runCmd('sudo', ['-n', INSTALL_HELPER, 'enable', target]);
  }
  throw new InstallerError(`systemctl: Aktion nicht ueber Helfer abbildbar: ${action}`);
}

// Schreibt eine systemd-Unit nach /etc/systemd/system/<name>.service.
// Der Inhalt darf mit Kommentarzeilen (#) beginnen; entscheidend ist, dass eine
// [Unit]-Sektion vorhanden ist (sonst ist die Unit unbrauchbar).
async function systemWriteService(name, content) {
  if (!SERVICE_RE.test(name)) throw new InstallerError(`Ungueltiger Unit-Name: ${name}`);
  if (typeof content !== 'string' || !content.split('\n').some((l) => l.trim() === '[Unit]')) {
    throw new InstallerError('Ungueltiger Unit-Inhalt (keine [Unit]-Sektion gefunden)');
  }
  // Schreiben nach /etc/systemd/system braucht root -> ueber den Install-Helfer.
  // Der Inhalt geht per STDIN, damit nie ein Dateipfad von aussen kommt.
  const res = await runCmdWithInput('sudo', ['-n', INSTALL_HELPER, 'write-unit', name], content);
  if (!res.ok) throw new InstallerError(`Unit schreiben fehlgeschlagen: ${res.stderr || res.error}`);
  return join(SYSTEMD_DIR, name);
}

async function pathExists(p) {
  try { await access(p); return true; } catch { return false; }
}

// --- RCON & server.properties ----------------------------------------------

function randomPassword(len = 32) {
  // URL-safe ohne Sonderzeichen, damit es gefahrlos in Properties-Datei passt.
  return randomBytes(len).toString('base64').replace(/[+/=]/g, '').slice(0, len);
}

async function writeRconPassword(id, serviceUser) {
  const path = join(DATA_DIR, `${id}-rcon.password`);
  await mkdir(DATA_DIR, { recursive: true });
  const pw = randomPassword(32);
  // Schreiben UND Eigentuemer setzen in EINEM Schritt ueber den Helfer.
  // Grund: Nach dem ersten Install gehoert die Datei dem Service-User (600);
  // armory kann sie dann nicht mehr selbst ueberschreiben.
  const res = await runCmdWithInput('sudo', ['-n', INSTALL_HELPER, 'write-file', serviceUser, path], pw);
  if (!res.ok) {
    throw new InstallerError(`RCON-Passwort konnte nicht geschrieben werden: ${res.stderr || res.error}`);
  }
  return { path, password: pw };
}

// Numerische uid/gid eines Users ermitteln ('id -u' / 'id -g').
// Hinweis: Nach der Umstellung auf den Install-Helfer werden uid/gid nicht mehr
// gebraucht (chown laeuft ueber den Helfer und arbeitet mit Usernamen). Funktion
// bleibt als kleine Lesehilfe erhalten, ist aber derzeit ungenutzt.
// eslint-disable-next-line no-unused-vars
async function userIds(username) {
  const [{ stdout: u }, { stdout: g }] = await Promise.all([
    runCmd('id', ['-u', username]),
    runCmd('id', ['-g', username]),
  ]);
  const uid = Number(String(u).trim());
  const gid = Number(String(g).trim());
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new InstallerError(`Konnte uid/gid fuer ${username} nicht ermitteln`);
  }
  return { uid, gid };
}

// Setzt/ergaenzt RCON- UND Spielport-Zeilen in server.properties. Fuer den
// Neu-Install wird die Datei IMMER geschrieben (es gibt noch keine User-Datei).
// Bei vorhandener Datei wird nur ergaenzt, was fehlt (bestehende Werte bleiben).
//
// WICHTIG: server-port wird ebenfalls gesetzt. Ohne das behaelt jedes Pack
// seinen Standardport (25565) aus dem Modpack, und jeder weitere Server auf
// demselben Host kollidiert beim Start mit "Address already in use".
export async function ensureRconProperties(propertiesPath, { port, password, serverPort = null }) {
  let content = '';
  let existed = false;
  try {
    content = await readFile(propertiesPath, 'utf8');
    existed = true;
  } catch { /* neu anlegen */ }

  const want = {
    'enable-rcon': 'true',
    'rcon.password': password,
    'rcon.port': String(port),
    'enable-query': 'true',
    'query.port': String(port),
  };
  // Spielport nur setzen, wenn ausdruecklich uebergeben. Ohne Angabe bleibt
  // das Pack-Verhalten erhalten (Rueckwaertskompatibilitaet fuer Aufrufer,
  // die nur RCON pflegen wollen).
  if (serverPort !== null && serverPort !== undefined) {
    want['server-port'] = String(serverPort);
    // Query lauscht standardmaessig auf dem Spielport; RCON bleibt separat.
    want['query.port'] = String(port);
  }

  const seen = new Set();
  const lines = content.split(/\r?\n/).map((line) => {
    const m = line.match(/^\s*([^#=]+?)\s*=/);
    if (m) {
      const key = m[1].trim();
      if (key in want && !seen.has(key)) {
        seen.add(key);
        return `${key}=${want[key]}`;
      }
    }
    return line;
  });

  for (const [key, val] of Object.entries(want)) {
    if (!seen.has(key)) lines.push(`${key}=${val}`);
  }

  await writeFile(propertiesPath, lines.filter((l, i, a) => !(i === a.length - 1 && l === '')).join('\n') + '\n');
  return { existed, updated: [...Object.keys(want)] };
}

// --- systemd-Unit ----------------------------------------------------------

// Optionales Environment=-Feld fuer die Java-Version des Servers. Muster:
//   Environment=<ID_UPPER>_JAVA=/pfad/zu/java
// Wird beim Install NICHT gesetzt (der Pack startet ueber PATH-java), aber beim
// Lesen eines BESTEHENDEN Racks beruecksichtigt (siehe detectRequiredJavaVersion
// bzw. resolveInstalledJavaVersion), damit auch Server mit eigener JVM korrekt
// geprueft werden.
function buildUnit({ id, name, user, workingDir, startScript }) {
  return `# Game-Armory: automatisch erzeugte Unit fuer ${name}
[Unit]
Description=${name} Minecraft Server (Game-Armory)
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${workingDir}
ExecStart=/bin/bash ${join(workingDir, startScript)}

# Sauberer Stop via RCON (Welt speichern), danach SIGTERM als Fallback.
ExecStop=/usr/bin/node ${ARMORY_SCRIPT} $(cat /opt/game-armory/data/${id}-rcon.password)

Restart=on-abnormal
RestartSec=10
StandardOutput=append:/var/log/${id}/${id}.log
StandardError=append:/var/log/${id}/${id}.err

TimeoutStopSec=180
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
`;
}

// --- Rack-Schablone + Sword-Instanz ----------------------------------------

// Rack-SCHABLONE (Spieltyp-Adapter): id, name, tier, game + Loader/Quelle/Java.
// KEIN port/control/logs/rcon - das ist Sache der Sword-Instanz.
function buildRackTemplate({ id, name, javaVersion = null }) {
  return {
    $schema: './rack.schema.json',
    id,
    name,
    description: `Von Game-Armory installiert (${new Date().toISOString()})`,
    icon: 'minecraft',
    game: 'minecraft',
    loader: 'neoforge',
    tier: 'free',
    licenseRequired: false,
    source: {
      type: 'curseforge',
      projectId: null,
    },
    // Vom Pack verlangte Java-Hauptversion (aus startserver.sh/-.bat); null = unbekannt.
    javaRequired: javaVersion,
  };
}

// Sword-INSTANZ: konkreter laufender Server (Port, Service, RCON, Welt-Pfad, User).
// Hinweis: game steht NICHT mehr hier - es wird beim Laden aus dem Rack abgeleitet
// (siehe swords.js). Das Rack ist die einzige Quelle fuer das Spiel.
function buildSword({ id, name, port, user, workingDir, startScript, rconPort, javaVersion = null, javaInstalled = null, javaWarning = null, installedVersion = null, installedVersionSource = null }) {
  return {
    $schema: './sword.schema.json',
    id,
    rack: id,
    name,
    port: Number(port),
    protocol: 'tcp',
    control: {
      type: 'systemd',
      service: `${id}.service`,
      user,
      workingDir,
      startScript,
    },
    logs: {
      type: 'file',
      path: `/var/log/${id}/${id}.log`,
    },
    rcon: {
      host: '127.0.0.1',
      port: rconPort,
      passwordFile: `/opt/game-armory/data/${id}-rcon.password`,
    },
    update: {
      source: 'curseforge',
      projectId: null,
      enabled: true,
      keep: ['world', 'server.properties', 'ops.json', 'whitelist.json', 'banned-ips.json', 'banned-players.json', 'eula.txt'],
      backupBeforeUpdate: true,
      keepGenerations: 2,
    },
    tier: 'free',
    // Java-Stand beim Install persistieren (Spec 2026-09-24):
    // javaRequired = vom Pack verlangte Hauptversion, javaInstalled = erkannte
    // installierte Hauptversion, javaWarning = Klartext-Warnung oder null.
    javaRequired: javaVersion,
    javaInstalled,
    javaWarning,
    // Version der installierten Instanz (Spec 2026-10-10): ATM-Pack-Version aus
    // dem ServerFiles-Dateinamen, GitHub-Release-Tag (TS6) oder Neoforge-Fallback.
    // installedVersionSource = woher sie stammt, installedVersionAt = wann.
    installedVersion,
    installedVersionSource,
    installedVersionAt: installedVersion ? Date.now() : null,
  };
}
// --- Java-Versionspruefung -------------------------------------------------

// Liest die im startserver.sh/-.bat GENANNTE Java-Mindestversion.
// Real vorkommendes Muster (ATM-Packs):
//   JAVA_VERSION=$(... -fullversion ... | ... | cut -d'.' -f1)
//   if [ ! "$JAVA_VERSION" -ge 21 ]; then
//       echo "Minecraft 26.1.2 requires Java 25 - found Java $JAVA_VERSION"
// Es gibt also ZWEI Zahlen: die im -ge-Vergleich getestete Minimalzahl (21) und
// die im Echo-Text genannte tatsaechlich geforderte Version (25). Fuer die
// Warnung zaehlt die im Text genannte Zahl; Fallback ist die Vergleichszahl.
// Wird nichts gefunden, gibt die Funktion null zurueck (kein Raten!).
export async function detectRequiredJavaVersion(startScriptPath) {
  let content;
  try {
    content = await readFile(startScriptPath, 'utf8');
  } catch {
    return null;
  }

  // 1) Bevorzugt: "requires Java N" aus dem Echo-Text.
  const echo = content.match(/requires\s+Java\s+(\d+)/i);
  if (echo) return Number(echo[1]);

  // 2) Fallback: die im -ge-Vergleich getestete Zahl.
  const ge = content.match(/-ge\s+(\d+)/);
  if (ge) return Number(ge[1]);

  return null;
}

// Liest die NEOFORGE_VERSION aus einem startserver.sh (ATM-Packs).
//   NEOFORGE_VERSION=21.1.251   ->   "21.1.251"
// Dient als Versions-Fallback, wenn keine Pack-Version (Dateiname/CurseForge)
// bekannt ist. Rueckgabe: Version-String oder null (kein Raten).
export async function detectRequiredNeoforgeVersion(startScriptPath) {
  let content;
  try {
    content = await readFile(startScriptPath, 'utf8');
  } catch {
    return null;
  }
  const m = content.match(/NEOFORGE_VERSION=\s*([0-9][^\s"']*)/);
  return m ? m[1] : null;
}

// Ermittelt die installierte Java-Hauptversion. Reihenfolge:
//   (a) Environment=<ID_UPPER>_JAVA=/pfad/zu/java in der systemd-Unit des Racks
//       (der Pack bevorzugt diese JVM via ${ID_JAVA:-java}),
//   (b) sonst das java auf dem PATH (`java -fullversion` / `java -version`).
// Rueckgabe: { version, source, javaPath } oder null, wenn nichts lesbar ist.
export async function resolveInstalledJavaVersion(rack = null, { log = () => {} } = {}) {
  // (a) Eigene JVM aus der Unit? Environment=<ID_UPPER>_JAVA=/pfad/zu/java
  if (rack?.id && rack?.control?.service) {
    const unitPath = join(SYSTEMD_DIR, rack.control.service);
    let unitContent = '';
    try {
      unitContent = await readFile(unitPath, 'utf8');
    } catch { /* Unit evtl. nicht lesbar */ }
    if (unitContent) {
      const envKey = `${String(rack.id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_JAVA`;
      const m = unitContent.match(new RegExp(`Environment\\s*=\\s*${envKey}\\s*=\\s*(\\S+)`));
      const envJava = m ? m[1] : null;
      if (envJava) {
        const v = await readJavaMajorVersion(envJava);
        if (v !== null) return { version: v, source: 'unit-environment', javaPath: envJava };
        log(`[java] ${envKey}=${envJava} gesetzt, aber Version nicht lesbar - Fallback auf PATH`);
      }
    }
  }

  // (b) java auf dem PATH.
  const v = await readJavaMajorVersion('java');
  if (v !== null) return { version: v, source: 'path', javaPath: 'java' };
  return null;
}

// Liest die Java-Hauptversion eines ausfuehrbaren java-Binaries.
// "openjdk version \"25.0.4.1\"" bzw. full version "25.0.4.1+1" -> 25.
// "1.8.0_401" -> 8 (altes Schema).
async function readJavaMajorVersion(javaPath) {
  // -fullversion zuerst (eine Zeile), sonst -version (stderr).
  let out = await runCmd(javaPath, ['-fullversion']);
  if (!out.ok || !out.stdout) {
    const alt = await runCmd(javaPath, ['-version']);
    out = { ok: alt.ok, stdout: `${alt.stdout}\n${alt.stderr}` };
  }
  if (!out.ok || !out.stdout) return null;
  const m = out.stdout.match(/version\s+"([0-9][^"]*)"/);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts[0] === '1' && parts[1]) return Number(parts[1]); // 1.8 -> 8
  return Number(parts[0]);
}

// Vergleicht geforderte und installierte Java-Hauptversion.
// Rueckgabe: { javaVersion, javaInstalled, javaSource, javaPath, javaWarning }.
// javaWarning ist null, wenn alles passt ODER keine Anforderung erkannt wurde.
export async function checkJavaVersion({ startScriptPath, rack = null, id = null, log = () => {} }) {
  const javaVersion = await detectRequiredJavaVersion(startScriptPath);
  if (javaVersion === null) {
    return { javaVersion: null, javaInstalled: null, javaSource: null, javaPath: null, javaWarning: null };
  }

  const installed = await resolveInstalledJavaVersion(rack, { log });
  const prefix = id ? `[install:${id}]` : '[java]';
  if (!installed) {
    const javaWarning = `Pack verlangt Java ${javaVersion}, installierte Java-Version konnte nicht ermittelt werden`;
    log(`${prefix} WARN ${javaWarning}`);
    return { javaVersion, javaInstalled: null, javaSource: null, javaPath: null, javaWarning };
  }

  if (installed.version < javaVersion) {
    const javaWarning = `Pack verlangt Java ${javaVersion}, installiert ist Java ${installed.version}`;
    log(`${prefix} WARN ${javaWarning} (Quelle: ${installed.source} ${installed.javaPath})`);
    return { javaVersion, javaInstalled: installed.version, javaSource: installed.source, javaPath: installed.javaPath, javaWarning };
  }

  log(`${prefix} Java ok: verlangt ${javaVersion}, installiert ${installed.version} (${installed.source})`);
  return { javaVersion, javaInstalled: installed.version, javaSource: installed.source, javaPath: installed.javaPath, javaWarning: null };
}

// --- Gemeinsamer Kern ------------------------------------------------------

export async function ensureUser(id, { workingDir = null } = {}) {
  // Service-User anlegen, falls nicht vorhanden (idempotent, kein Shell).
  // ueber den Install-Helfer, da useradd root braucht.
  const check = await runCmd('id', ['-u', id]);
  if (check.ok) return;
  const add = await runCmd('sudo', ['-n', INSTALL_HELPER, 'useradd', id, ...(workingDir ? [workingDir] : [])]);
  if (!add.ok && !/already exists/.test(add.stderr)) {
    throw new InstallerError(`Service-User ${id} konnte nicht angelegt werden: ${add.stderr || add.error}`);
  }
}

async function installFromSource({ id, name, port, sourceDir, workDir, log, acceptEula = false, acceptedBy = null, packVersion = null, packVersionSource = null }) {
  const service = `${id}.service`;
  const serviceUser = id;
  const rconPort = Number(port) + 10; // Standard: RCON = Spielport + 10
  const startScript = 'startserver.sh';

  // Version der Instanz ermitteln (Spec 2026-10-10): bevorzugt die vom Aufrufer
  // uebergebene Pack-Version (z.B. ATM "8.1" aus ServerFiles-8.1.zip bzw. aus der
  // CurseForge-Datei). Fehlt sie, faellt sie auf die Neoforge-Version aus
  // startserver.sh zurueck - so steht IMMER etwas in der Anzeige.
  let installedVersion = packVersion || null;
  let installedVersionSource = packVersion ? (packVersionSource || 'filename') : null;
  if (!installedVersion) {
    try {
      const nf = await detectRequiredNeoforgeVersion(join(workDir, startScript));
      if (nf) {
        installedVersion = `neoforge ${nf}`;
        installedVersionSource = 'neoforge-startscript';
      }
    } catch { /* kein startserver.sh oder kein NEOFORGE_VERSION -> bleibt null */ }
  }

  log(`[install] Ziel: ${workDir} (User ${serviceUser})`);

  await ensureUser(serviceUser);
  // Workdir anlegen UND dem Service-User geben - ueber den Helfer, weil armory
  // im Game-Root nicht selbst mkdir darf (Owner ist der Service-User).
  {
    const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'mkdir-tree', serviceUser, workDir]);
    if (!res.ok) {
      throw new InstallerError(`Arbeitsverzeichnis ${workDir} konnte nicht angelegt werden: ${res.stderr || res.error}`);
    }
  }

  // Pack-Inhalte kopieren (alles aus dem Pack ausser geschuetzten Pfaden;
  // keepConfigs=false -> auch config wird aus dem Pack uebernommen).
  await replacePackContents(sourceDir, workDir, { id: serviceUser, keepConfigs: false, log });

  // RCON-Passwort + server.properties (nur ergaenzen, nie ueberschreiben).
  const { path: pwPath, password } = await writeRconPassword(id, serviceUser);
  log(`[install] RCON-Passwort geschrieben: ${pwPath}`);
  await ensureRconProperties(join(workDir, 'server.properties'), { port: rconPort, password, serverPort: port });

  // eula.txt: wird NUR auf ausdrueckliche Zustimmung (acceptEula === true) gesetzt.
  // Ohne Zustimmung bleibt die Datei unangetastet (Compliance).
  const eulaPath = join(workDir, 'eula.txt');
  let eulaAccepted = false;
  if (acceptEula === true) {
    const stamp = new Date().toISOString();
    const agreedBy = acceptedBy ? ` (${acceptedBy})` : '';
    await writeFile(
      eulaPath,
      `# Minecraft EULA akzeptiert via Game-Armory am ${stamp}${agreedBy}\n`
        + `# Quelle: https://aka.ms/MinecraftEULA\n`
        + `eula=true\n`,
      'utf8',
    );
    eulaAccepted = true;
    log('[install] eula.txt auf eula=true gesetzt (Betreiber-Zustimmung liegt vor)');
  } else {
    eulaAccepted = await pathExists(eulaPath);
  }

  // Rechte auf den Service-User uebertragen (rekursiv) - ueber den Helfer.
  // Fehler hier ist fatal: sonst kann der Server seine Dateien nicht schreiben.
  {
    const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'chown-tree', serviceUser, workDir]);
    if (!res.ok) throw new InstallerError(`Rechte auf ${workDir} konnten nicht gesetzt werden: ${res.stderr || res.error}`);
  }
  try { await chmod(join(workDir, startScript), 0o755); } catch { /* Script evtl. nicht vorhanden */ }

  // Java-Mindestversion pruefen (aus startserver.sh/-.bat) BEVOR das Rack-JSON
  // geschrieben wird. Pack kann eine eigene JVM in der Unit nutzen; beim Erst-
  // Install gibt es noch keine Unit, daher wird das PATH-java geprueft.
  const javaCheck = await checkJavaVersion({
    startScriptPath: join(workDir, startScript),
    rack: { id, control: { service, workingDir: workDir } },
    id,
    log,
  });

  // Log-Verzeichnis anlegen + Eigentuemer setzen - ueber den Helfer (ein Schritt, der beide erledigt).
  {
    const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'mkdir-logdir', id]);
    if (!res.ok) throw new InstallerError(`Log-Verzeichnis /var/log/${id} konnte nicht angelegt werden: ${res.stderr || res.error}`);
  }

  // Rack-SCHABLONE (nur falls noch nicht vorhanden) + Sword-INSTANZ.
  const rackTemplate = buildRackTemplate({
    id, name, javaVersion: javaCheck.javaVersion,
  });
  await mkdir(RACKS_DIR, { recursive: true });
  const rackPath = join(RACKS_DIR, `${id}.rack.json`);
  if (await pathExists(rackPath)) {
    log(`[install] Rack-Schablone existiert bereits: ${id}.rack.json (unveraendert)`);
  } else {
    await writeFile(rackPath, JSON.stringify(rackTemplate, null, 2) + '\n');
    log(`[install] Rack-Schablone geschrieben: ${id}.rack.json`);
  }

  // Spiel der Instanz kommt vom Rack (Pflichtfeld 'game'), damit ein
  // Sword nicht versehentlich als anderes Spiel gefuehrt wird.
  if (getRacks().length === 0) await loadRacks();
  const parentRack = getRack(id);
  const sword = buildSword({
    id, name, port, user: serviceUser, workingDir: workDir, startScript, rconPort,
    javaVersion: javaCheck.javaVersion,
    javaInstalled: javaCheck.javaInstalled,
    javaWarning: javaCheck.javaWarning,
    installedVersion: packVersion,
    installedVersionSource: packVersionSource,
  });
  await mkdir(SWORDS_DIR, { recursive: true });
  const swordPath = join(SWORDS_DIR, `${id}.sword.json`);
  await writeFile(swordPath, JSON.stringify(sword, null, 2) + '\n');
  log(`[install] Sword-Instanz geschrieben: ${id}.sword.json`);

  // systemd-Unit.
  const unit = buildUnit({ id, name, user: serviceUser, workingDir: workDir, startScript });
  const unitPath = await systemWriteService(service, unit);
  log(`[install] systemd-Unit geschrieben: ${unitPath}`);

  // Aktivieren (kein Start - der Betreiber entscheidet bzw. muss EULA akzeptieren).
  const reload = await systemctl(['daemon-reload']);
  if (!reload.ok) log(`[install] WARN daemon-reload: ${reload.stderr || reload.error}`);
  const enable = await systemctl(['enable', service]);
  if (!enable.ok) log(`[install] WARN enable: ${enable.stderr || enable.error}`);

  return {
    id,
    service,
    workingDir: workDir,
    rconPort,
    rconPasswordFile: pwPath,
    rackPath,
    swordPath,
    unitPath,
    eulaAccepted,
    javaVersion: javaCheck.javaVersion,
    javaInstalled: javaCheck.javaInstalled,
    javaWarning: javaCheck.javaWarning,
    warnings: [
      eulaAccepted
        ? 'EULA wurde auf Zustimmung des Betreibers gesetzt (eula=true).'
        : 'eula.txt wurde NICHT automatisch akzeptiert - EULA bewusst setzen (eula=true) bevor der Server startet.',
      'Service wurde enabled, aber NICHT gestartet.',
      ...(javaCheck.javaWarning ? [javaCheck.javaWarning] : []),
    ],
  };
}

// Akzeptiert die Minecraft-EULA fuer einen BESTEHENDEN Server nachtraeglich.
// Wird nur auf ausdrueckliche Zustimmung des Betreibers aufgerufen (Route).
// Schreibt <workingDir>/eula.txt mit eula=true, setzt Besitz auf den Service-
// User und gibt den Pfad zurueck. Der Aufrufer verantwortet die Zustimmung.
export async function acceptEulaForRack(rack, { acceptedBy = null, log = () => {} } = {}) {
  const id = rack?.id;
  const workingDir = rack?.control?.workingDir;
  const serviceUser = rack?.control?.user ?? id;
  if (!id || !workingDir) throw new InstallerError('Rack ohne id/control.workingDir');

  const eulaPath = join(workingDir, 'eula.txt');
  const stamp = new Date().toISOString();
  const agreedBy = acceptedBy ? ` (${acceptedBy})` : '';
  await writeFile(
    eulaPath,
    `# Minecraft EULA akzeptiert via Game-Armory am ${stamp}${agreedBy}\n`
      + `# Quelle: https://aka.ms/MinecraftEULA\n`
      + `eula=true\n`,
    'utf8',
  );

  const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'chown-file', serviceUser, eulaPath]);
  if (!res.ok) log(`[eula] chown ${eulaPath} fehlgeschlagen: ${res.stderr || res.error}`);
  log(`[eula] eula.txt gesetzt: ${eulaPath}`);
  return { eulaPath, acceptedAt: stamp };
}

// --- Oeffentliche API ------------------------------------------------------

export async function installFromZip({ id, name, port, zipPath, acceptEula = false, acceptedBy = null, packVersion = null, packVersionSource = null }, { log = () => {} } = {}) {
  const v = validateInstallInput({ id, name, port });
  if (!zipPath || !(await pathExists(zipPath))) {
    throw new InstallerError(`ZIP nicht gefunden: ${zipPath}`);
  }
  const check = await validatePackZip(zipPath);
  if (!check.ok) throw new InstallerError('ZIP sieht nicht wie ein Serverpack aus (keine mods/libraries/startserver).');
  log(`[install] ZIP ok: ${check.entryCount} Eintraege`);

  const workDir = join(MINECRAFT_ROOT, v.id);
  if (await pathExists(workDir)) {
    throw new InstallerError(`Zielordner existiert bereits: ${workDir}`);
  }

  const { tmpRoot, sourceDir } = await extractToTemp(zipPath);
  try {
    return await installFromSource({ ...v, sourceDir, workDir, log, acceptEula, acceptedBy, packVersion, packVersionSource });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

// --- GitHub-Release (url-Racks, z.B. TeamSpeak 6) ---------------------------
// Laedt das AKTUELLE Release-Asset eines GitHub-Repos nach /tmp (der einzige
// Pfad, den der Install-Helfer fuer Tarballs akzeptiert). Die Aufloesung
// "latest" ist wichtig: ein Kunde soll nie eine fest eingetragene Altversion
// bekommen. Fehlt ein Asset mit dem Muster, bricht es mit klarer Meldung ab.
export async function downloadGithubAsset({ repo, assetPattern, log = () => {} }) {
  if (!repo || !assetPattern) throw new InstallerError('repo und assetPattern erforderlich');
  const api = `https://api.github.com/repos/${repo}/releases/latest`;
  log(`[url] frage Release ab: ${api}`);
  let rel;
  try {
    const res = await fetch(api, {
      headers: { 'User-Agent': 'game-armory/0.1', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rel = await res.json();
  } catch (err) {
    throw new InstallerError(`GitHub-Release nicht abrufbar (${repo}): ${err.message}`);
  }
  const asset = (rel.assets ?? []).find((a) => a.name === assetPattern)
    ?? (rel.assets ?? []).find((a) => a.name.endsWith(assetPattern));
  if (!asset) {
    throw new InstallerError(
      `Asset "${assetPattern}" nicht im Release ${rel.tag_name} gefunden. `
      + `Vorhanden: ${(rel.assets ?? []).map((a) => a.name).join(', ')}`,
    );
  }
  const dest = join('/tmp', `armory-${Date.now()}-${asset.name}`);
  log(`[url] Release ${rel.tag_name}: lade ${asset.name} (${Math.round(asset.size / 1024 / 1024)} MB)`);
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const { Readable } = await import('node:stream');
  try {
    const res = await fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'game-armory/0.1' },
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  } catch (err) {
    throw new InstallerError(`Download fehlgeschlagen (${asset.name}): ${err.message}`);
  }
  log(`[url] gespeichert: ${dest}`);
  return { path: dest, url: asset.browser_download_url, tag: rel.tag_name, asset: asset.name };
}

// --- Admin-Schluessel aus dem Log (TeamSpeak 3/6) ---------------------------
// TS3 und TS6 loggen beim ersten Start denselben Einmal-Schluessel:
//   "ServerAdmin privilege key created, please use the line below"
//   "token=XXXXXXXXXXXXXXXXXXXX"
// Der Key ist nur EINMAL gueltig und verschwindet nach der Nutzung. Wir lesen
// ihn ueber den Service-Ctl-Helfer (journalctl) aus der Unit. Mehrfach-Versuche,
// weil der Server ein paar Sekunden braucht. Kein Key gefunden = kein Fehler.
export async function waitForPrivilegeKey({ id, attempts = 15, delayMs = 2000, log = () => {} }) {
  const unit = `${id}.service`;
  const TOKEN_RE = /token=([A-Za-z0-9+/=_-]{10,})/;
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((r) => setTimeout(r, delayMs));
    const res = await runCmd('sudo', ['-n', SERVICE_CTL, 'logs', unit]);
    const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    const m = text.match(TOKEN_RE);
    if (m) {
      log('[install] Admin-Schluessel erkannt (nur einmal sichtbar).');
      return m[1];
    }
  }
  log('[install] Kein Admin-Schluessel im Log gefunden (evtl. nicht der Erststart).');
  return null;
}

// --- Konfigurations-Vorlagen (url-Racks) ------------------------------------
// Vorlagen liegen unter <armory>/templates/<game>.<datei> und enthalten
// {platzhalter}. Sie werden aus einer ECHTEN, vom Hersteller-Binary erzeugten
// Config abgeleitet - nicht von Hand geraten (Lehre 2026-09-27).
export const TEMPLATES_DIR = join(ARMORY_ROOT, 'templates');

export async function renderConfigTemplate(templateName, vars) {
  const path = join(TEMPLATES_DIR, templateName);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new InstallerError(`Konfigurations-Vorlage nicht gefunden: ${path} (${err.message})`);
  }
  return raw.replace(/\{(\w+)\}/g, (m, key) => {
    if (!(key in vars)) throw new InstallerError(`Platzhalter {${key}} in Vorlage ${templateName} hat keinen Wert.`);
    return String(vars[key]);
  });
}

// --- Tarball (fuer url-Racks, z.B. TeamSpeak 6) -----------------------------
// Anders als ZIP/CurseForge/SteamCMD: ein Release-Tarball hat keine Modpack-,
// keine RCON- und keine eula-Struktur. Er enthaelt ein Binary, geteilte Libs
// und SQL-Schemata. Deshalb ein eigener, schlanker Pfad statt installFromSource.
//
// Wichtig (Betreiber-Entscheidung 2026-09-27): existiert das Zielverzeichnis
// bereits, wird ABGEBROCHEN - es wird nie ueberschrieben. Damit ist eine von
// Hand installierte Instanz im selben Pfad geschuetzt.
export async function installFromTarball(
  { id, name, port, tarballPath, workDir, configFile = 'tsserver.yaml', log = () => {}, installedVersion = null, installedVersionSource = null },
  { log: log2 = () => {} } = {},
) {
  const logFn = (m) => { log(m); log2(m); };
  const v = validateInstallInput({ id, name, port });

  if (!workDir) throw new InstallerError('workDir erforderlich (Zielpfad der Instanz).');
  if (!tarballPath || !(await pathExists(tarballPath))) {
    throw new InstallerError(`Tarball nicht gefunden: ${tarballPath}`);
  }
  // Option a: NIE ein vorhandenes Zielverzeichnis ueberschreiben.
  if (await pathExists(workDir)) {
    throw new InstallerError(
      `Zielordner existiert bereits: ${workDir}. Ein bestehendes Verzeichnis wird nie ueberschrieben - `
      + 'bitte vorher entfernen oder einen anderen Pfad waehlen.',
    );
  }

  // Vorabpruefung des Tarballs, BEVOR irgendetwas am System geaendert wird.
  // Grund (live gefunden 2026-09-27): der Pfad-Check im Helfer laeuft erst beim
  // Entpacken - also NACH ensureUser und mkdir-tree. Bei einem ungueltigen Pfad
  // blieben ein angelegter User und ein leerer Zielordner zurueck. Diese Pruefung
  // ist billig (kein root, nur lesen) und stellt die Fehlerreihenfolge richtig:
  // erst validieren, dann anfassen.
  // Zwei Bedingungen, beide VOR jeder Systemaenderung:
  // a) Der Helfer akzeptiert nur Tarballs unter /tmp oder im Upload-Ordner.
  //    Diese Regel muss hier gespiegelt werden - sonst laeuft die Pruefung ins
  //    Leere und der Abbruch kommt erst nach ensureUser/mkdir-tree.
  const TARBALL_ALLOWED = [/^\/tmp\//, /^\/opt\/game-armory\/data\/uploads\//];
  if (!TARBALL_ALLOWED.some((re) => re.test(tarballPath))) {
    throw new InstallerError(
      `Tarball-Pfad nicht erlaubt: ${tarballPath} (nur /tmp/... oder der Upload-Ordner).`,
    );
  }
  // b) Lesbarkeit/Struktur (kein root noetig).
  try {
    await listTarball(tarballPath);
  } catch (err) {
    throw new InstallerError(`Tarball nicht lesbar: ${tarballPath} (${err.message})`);
  }

  const service = `${v.id}.service`;
  const serviceUser = v.id;
  logFn(`[install] Ziel: ${workDir} (User ${serviceUser})`);

  // 1) Service-User (idempotent).
  await ensureUser(serviceUser);

  // 2) Zielordner anlegen UND dem Service-User geben (armory darf im Game-Root
  //    nicht selbst mkdir - Owner ist der Service-User).
  {
    const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'mkdir-tree', serviceUser, workDir]);
    if (!res.ok) throw new InstallerError(`Arbeitsverzeichnis ${workDir} konnte nicht angelegt werden: ${res.stderr || res.error}`);
  }

  // 3) Tarball in ein Temp entpacken, das dem Service-User gehoert.
  //    Sicherheit (Tar-Slip, Links) laeuft in extractTarballToTemp.
  const { tmpRoot, sourceDir } = await extractTarballToTemp(tarballPath, { id: serviceUser, log: logFn });

  let result;
  try {
    // 4) Inhalte kopieren (Ganzes Verzeichnis, flache Archivstruktur).
    {
      const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'replace-tree', serviceUser, workDir, sourceDir]);
      if (!res.ok) throw new InstallerError(`Tarball-Inhalt konnte nicht kopiert werden: ${res.stderr || res.error}`);
    }
    logFn('[install] Tarball-Inhalt kopiert.');

    // 5) Konfiguration aus der RACK-VORLAGE rendern - nicht erfinden.
    //    Lehre vom 2026-09-27: selbst geratene Keys (acceptLicense, port) liessen
    //    den Server nicht starten. Die Schluessel stammen jetzt aus dem echten
    //    tsserver --write-config-file (templates/teamspeak6.tsserver.yaml).
    const configPath = join(workDir, configFile);
    const configContent = await renderConfigTemplate('teamspeak6.tsserver.yaml', {
      workDir,
      port: Number(port),
      fileTransferPort: Number(port) + 1,
      logDir: `/var/log/${v.id}`,
    });
    {
      const res = await runCmdWithInput('sudo', ['-n', INSTALL_HELPER, 'write-file', serviceUser, configPath], configContent);
      if (!res.ok) throw new InstallerError(`Konfiguration konnte nicht geschrieben werden: ${res.stderr || res.error}`);
    }
    logFn(`[install] Konfiguration geschrieben: ${configPath}`);

    // 6) Log-Verzeichnis + Spiel-Logdatei (dem Server-User, NICHT dem Unit-Log).
    //    Kein /var/lib-Statedir mehr: die TS6-Datenbank entsteht als
    //    <workDir>/tsserver.sqlitedb direkt im Instanzordner (Clean Install).
    const logFilePath = `/var/log/${v.id}/${v.id}.log`;
    {
      const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'mkdir-logdir', v.id]);
      if (!res.ok) throw new InstallerError(`Log-Verzeichnis /var/log/${v.id} konnte nicht angelegt werden: ${res.stderr || res.error}`);
    }
    {
      const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'touch-logfile', v.id, `${v.id}.log`]);
      if (!res.ok) logFn(`[install] WARN Logdatei ${logFilePath}: ${res.stderr || res.error}`);
      else logFn(`[install] Logdatei vorbereitet: ${logFilePath} (Eigentuemer ${v.id})`);
    }

    // 7) Sword-Instanz (kein RCON, kein Java; game kommt aus dem Rack).
    const sword = {
      $schema: './sword.schema.json',
      id: v.id,
      rack: v.id,
      name,
      port: Number(port),
      protocol: 'udp',
      control: {
        type: 'systemd',
        service,
        user: serviceUser,
        workingDir: workDir,
        startScript: null,          // kein Shell-Skript: binaeres Release
        execStart: join(workDir, 'tsserver'),
        configFile,
      },
      logs: { type: 'file', path: logFilePath },
      rcon: null,
      update: {
        source: 'url',
        url: null,                  // Release-URL liegt im Rack; Panel kann sie dort lesen
        enabled: true,
        keep: [configFile, 'files', 'sql'],
        backupBeforeUpdate: true,
        keepGenerations: 2,
      },
      tier: 'free',
      javaRequired: null,
      javaInstalled: null,
      javaWarning: null,
      // Version der Instanz (Spec 2026-10-10): GitHub-Release-Tag, z.B.
      // "6.0.0-beta1" fuer TeamSpeak 6. Quelle = Asset-Release.
      installedVersion,
      installedVersionSource: installedVersion ? (installedVersionSource || 'github-release') : null,
      installedVersionAt: installedVersion ? Date.now() : null,
    };
    await mkdir(SWORDS_DIR, { recursive: true });
    const swordPath = join(SWORDS_DIR, `${v.id}.sword.json`);
    await writeFile(swordPath, JSON.stringify(sword, null, 2) + '\n');
    logFn(`[install] Sword-Instanz geschrieben: ${v.id}.sword.json`);

    // 8) systemd-Unit. Startet das Binary direkt (kein Skript), Log via
    //    StandardOutput=append (Unit-Log als root) - der Server schreibt sein
    //    eigenes Log selbst (logFilePath), beide Ziele sind getrennte Dateien.
    const unit = buildTarballUnit({ id: v.id, name, user: serviceUser, workingDir: workDir, configFile, port });
    const unitPath = await systemWriteService(service, unit);
    logFn(`[install] systemd-Unit geschrieben: ${unitPath}`);

    const reload = await systemctl(['daemon-reload']);
    if (!reload.ok) logFn(`[install] WARN daemon-reload: ${reload.stderr || reload.error}`);
    const enable = await systemctl(['enable', service]);
    if (!enable.ok) logFn(`[install] WARN enable: ${enable.stderr || enable.error}`);

    // 9) Erststart + Admin-Key (nur TeamSpeak 3/6). TS erzeugt beim ersten
    //    Start einer leeren DB einen Einmal-Schluessel ("ServerAdmin privilege
    //    key created" -> "token=..."). Der ist nur EINMAL sichtbar, deshalb
    //    starten wir hier direkt, warten kurz auf den Key und legen ihn ins
    //    Ergebnis. Ist der Key noch nicht da, ist das kein Fehler - er bleibt
    //    in der Panel-Konsole sichtbar.
    let adminKey = null;
    // Kriterium: die TS-Config (tsserver.yaml). Ein frueherer Zusatzcheck auf
    // v.game war wirkungslos - validateInstallInput() liefert kein game-Feld.
    const isTeamspeak = configFile.endsWith('tsserver.yaml');
    if (isTeamspeak) {
      // Start ueber den Service-Ctl-Helfer - der Install-Helfer kann nur
      // daemon-reload/enable (der Wrapper lehnt 'start' zu Recht ab).
      const started = await runCmd('sudo', ['-n', SERVICE_CTL, 'start', service]);
      if (!started.ok) {
        logFn(`[install] WARN Start fehlgeschlagen: ${started.stderr || started.error}`);
      } else {
        adminKey = await waitForPrivilegeKey({ id: v.id, log: logFn });
      }
    }

    result = {
      id: v.id,
      service,
      workingDir: workDir,
      swordPath,
      unitPath,
      configFile: configPath,
      adminKey,
      warnings: isTeamspeak
        ? [
          adminKey
            ? 'Server gestartet. Admin-Schluessel erzeugt (nur einmal sichtbar!).'
            : 'Server gestartet, aber noch kein Admin-Schluessel im Log - in der Konsole pruefen.',
          'Config liegt als ' + configFile + ' vor - im Panel editierbar.',
        ]
        : [
          'Service wurde enabled, aber NICHT gestartet.',
          'Config liegt als ' + configFile + ' vor - im Panel editierbar.',
        ],
    };
  } finally {
    // Temp IMMER wegraeumen, auch bei Fehler - kein Artefakt bleibt liegen.
    await rm(tmpRoot, { recursive: true, force: true });
  }
  return result;
}

// systemd-Unit fuer ein binaeres Release-Rack (startet das Binary direkt).
function buildTarballUnit({ id, name, user, workingDir, configFile, port }) {
  const bin = join(workingDir, 'tsserver');
  return `# Game-Armory: automatisch erzeugte Unit fuer ${name}
[Unit]
Description=${name} Dedicated Server (Game-Armory)
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${workingDir}
ExecStart=${bin} --config-file=${configFile}

Restart=on-abnormal
RestartSec=15

# Log via journald (wie die migrierte Referenz-Instanz). Vorteil: die
# Panel-Konsole liest ueber den Service-Ctl-Helfer journalctl, und der
# Erststart kann den Admin-Schluessel ("token=...") daraus holen. Der Server
# schreibt seine rotierten Dateien zusaetzlich selbst unter log-path.
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${id}

TimeoutStopSec=60
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
`;
}

// --- SteamCMD (fuer steamcmd-Racks, z.B. 7 Days to Die) --------------------

// Stellt sicher, dass SteamCMD vorhanden und funktionsfaehig ist.
// Idempotent: der Helfer installiert nur, wenn es fehlt. Nur fuer steamcmd-Racks.
export async function ensureSteamCmd({ log = () => {} } = {}) {
  const status = await runCmd('sudo', ['-n', STEAM_HELPER, 'steam-status']);
  if (status.ok && /steamcmd: present/.test(status.stdout)) {
    log('[steam] SteamCMD bereits vorhanden.');
    return { installed: false, present: true };
  }
  log('[steam] SteamCMD fehlt - wird eingerichtet (i386, lib32, Valve-Tarball)...');
  const setup = await runCmd('sudo', ['-n', STEAM_HELPER, 'steam-setup']);
  if (!setup.ok) {
    throw new InstallerError(`SteamCMD-Einrichtung fehlgeschlagen: ${setup.stderr || setup.error}`);
  }
  const lines = setup.stdout.split('\n').filter(Boolean);
  for (const l of lines) log(`[steam] ${l}`);
  return { installed: true, present: true };
}

// Installiert ein Spiel per SteamCMD in einen game-spezifischen Root.
// Zugangsdaten (optional) gehen per STDIN an den Helfer - NIE als Argument.
export async function installFromSteam(
  { id, name, port, appId, branch = 'public', rootDir = null, credentials = null, acceptEula = false, acceptedBy = null, rackId = null },
  { log = () => {}, onProgress = null } = {},
) {
  // Live-Fortschritt an den Aufrufer melden (Panel-Balken). onProgress ist
  // optional - fehlt es, verhaelt sich der Installer wie vorher.
  let lastPhase = null;
  let lastPercent = null;
  const reportProgress = (patch) => {
    if (!onProgress) return;
    try { onProgress(patch); } catch { /* Panel-Fehler nie fatal fuer den Install */ }
  };
  const v = validateInstallInput({ id, name, port });
  if (!Number.isInteger(Number(appId)) || Number(appId) < 100) {
    throw new InstallerError(`Ungueltige Steam-App-ID: ${appId}`);
  }
  const root = rootDir ?? GAME_ROOTS['7d2d'];
  const workDir = join(root, v.id);
  if (await pathExists(workDir)) {
    throw new InstallerError(`Zielordner existiert bereits: ${workDir}`);
  }

  // 1) SteamCMD sicherstellen (idempotent, nur hier fuer steamcmd-Racks).
  await ensureSteamCmd({ log });

  // 2) Service-User + Zielordner vorbereiten.
  //    Wichtig: mkdir-tree bekommt das WORKDIR (root/<id>), nicht den Root -
  //    die Helfer-Pruefung erlaubt nur Pfade UNTER einem erlaubten Root.
  await ensureUser(v.id, { workingDir: workDir });
  {
    const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'mkdir-tree', v.id, workDir]);
    if (!res.ok) throw new InstallerError(`Arbeitsverzeichnis ${workDir} konnte nicht angelegt werden: ${res.stderr || res.error}`);
  }

  // 3) SteamCMD-Download. Credentials per STDIN: Zeile 1 = user, Zeile 2 = pass.
  log(`[steam] Lade App ${appId} (${branch}) -> ${workDir} ...`);
  const stdin = credentials && credentials.username
    ? `${credentials.username}\n${credentials.password}\n`
    : '\n\n'; // beide leer -> Helfer nutzt 'login anonymous'
  // Live-Zeilen mitschneiden: jede Fortschrittszeile wandert sofort in den
  // Job (phase/progress), damit die Anzeige waehrend des Downloads laeuft.
  const steamLines = [];
  const onSteamLine = (line) => {
    steamLines.push(line);
    if (steamLines.length > 400) steamLines.shift();
    const p = parseSteamProgress(line);
    if (!p) return;
    // Nur echte Aenderungen melden (Steam wiederholt Zeilen sehr oft).
    if (p.phase === lastPhase && p.percent === lastPercent) return;
    lastPhase = p.phase;
    lastPercent = p.percent;
    reportProgress({
      phase: 'running',
      progress: p.percent === null ? undefined : p.percent,
      message: p.percent === null
        ? `${p.phase} laeuft`
        : `${p.phase}: ${p.percent.toFixed(1)} %`,
      steamPhase: p.phase,
      steamPercent: p.percent,
    });
  };

  reportProgress({ phase: 'running', progress: 0, message: 'SteamCMD gestartet' });
  const dl = await runCmdWithInput(
    'sudo', ['-n', STEAM_HELPER, 'steam-install', v.id, String(appId), branch, root], stdin,
    { onLine: onSteamLine },
  );
  if (!dl.ok) throw new InstallerError(`SteamCMD-Installation fehlgeschlagen: ${dl.stderr || dl.error}`);
  for (const l of dl.stdout.split('\n').filter(Boolean).slice(-15)) log(`[steam] ${l}`);

  // Ziel ist nach SteamCMD-Download evtl. root-owned -> Service-User uebernehmen.
  {
    const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'chown-tree', v.id, workDir]);
    if (!res.ok) throw new InstallerError(`Rechte auf ${workDir} konnten nicht gesetzt werden: ${res.stderr || res.error}`);
  }

  // 4) Startskript ausfuehrbar machen (haeufigster 7d2d-Startfehler) + Config-Kopie.
  let startScript = 'startserver.sh';
  const configFile = 'serverconfig.xml';
  const startPath = join(workDir, startScript);
  try { await chmod(startPath, 0o755); } catch { /* evtl. anders benannt */ }

  // 4a) Live-Konsole: Rack kann einen festen logFile-Pfad vorgeben. 7d2d schreibt
  // sonst in output_log__<zeitstempel>.txt - ein Name, dem die Konsole nicht folgen
  // kann. Dann zeigt die Unit auf die Armory-Kopie des Startskripts.
  let logFilePath = null;
  {
    let rack = null;
    try { rack = getRack(v.rackId ?? v.id) ?? null; } catch { /* Racks evtl. nicht geladen */ }
    const template = rack?.logFile ?? null;
    if (typeof template === 'string' && template.trim()) {
      logFilePath = template.replaceAll('{id}', v.id);
      const copied = await writeArmoryStartScript({
        id: v.id, workDir, startScript, logFile: logFilePath, log,
      });
      if (copied) startScript = copied;
    }
  }
  const userConfig = join(workDir, 'serversettings.xml');
  const origConfig = join(workDir, configFile);
  if (await pathExists(origConfig)) {
    // Eigene Config-Kopie, damit Updates die Datei nicht ueberschreiben.
    try {
      const content = await readFile(origConfig, 'utf8');
      await writeFile(userConfig, content, 'utf8');
      const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'chown-file', v.id, userConfig]);
      if (!res.ok) log(`[install] WARN chown ${userConfig}: ${res.stderr || res.error}`);
      log('[install] Config-Kopie angelegt: serversettings.xml (wird per -configfile genutzt)');
    } catch (err) {
      log(`[install] WARN Config-Kopie: ${err.message}`);
    }
  }

  // 5) Log-Verzeichnis.
  {
    const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'mkdir-logdir', v.id]);
    if (!res.ok) throw new InstallerError(`Log-Verzeichnis /var/log/${v.id} konnte nicht angelegt werden: ${res.stderr || res.error}`);
  }

  // 5a) Spiel-Logdatei dem Server-User geben. Sie ist NICHT das Unit-Log
  // (systemd legt unit.log als root an): der Server oeffnet diese Datei selbst
  // ueber -logfile. Ohne diesen Schritt scheitert der Start mit
  // "Unable to open log file" (exit 127).
  if (logFilePath) {
    const { dirname, basename } = await import('node:path');
    const logDir = dirname(logFilePath);
    const logName = basename(logFilePath);
    if (logDir === `/var/log/${v.id}`) {
      const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'touch-logfile', v.id, logName]);
      if (!res.ok) log(`[install] WARN Logdatei ${logFilePath}: ${res.stderr || res.error}`);
      else log(`[install] Logdatei vorbereitet: ${logFilePath} (Eigentuemer ${v.id})`);
    } else {
      log(`[install] WARN logFile ausserhalb /var/log/${v.id}: ${logFilePath} - Rechte bitte manuell pruefen`);
    }
  }

  // 6) Sword-Instanz (kein Java, kein Minecraft-RCON; Telnet optional).
  //    game kommt aus dem Rack, nicht aus dieser Datei.
  const service = `${v.id}.service`;
  const sword = {
    $schema: './sword.schema.json',
    id: v.id,
    rack: v.id,
    name,
    port,
    protocol: 'udp',
    control: {
      type: 'systemd',
      service,
      user: v.id,
      workingDir: workDir,
      startScript,
      startArgs: ['-configfile=serversettings.xml'],
    },
    logs: { type: 'file', path: logFilePath ?? `/var/log/${v.id}/${v.id}.log` },
    telnet: { host: '127.0.0.1', port: 8081, passwordFile: null },
    update: { source: 'steam', appId: Number(appId), branch, enabled: true, keep: ['serversettings.xml', 'Saves', 'serverconfig.xml'], backupBeforeUpdate: true, keepGenerations: 2 },
    tier: 'free',
    javaRequired: null,
    javaInstalled: null,
    javaWarning: null,
    // Version der Instanz (Spec 2026-10-10): CurseForge-Release, z.B. "1.5.0".
    installedVersion: fileVersion,
    installedVersionSource: fileVersion ? 'curseforge' : null,
    installedVersionAt: fileVersion ? Date.now() : null,
  };
  await mkdir(SWORDS_DIR, { recursive: true });
  const swordPath = join(SWORDS_DIR, `${v.id}.sword.json`);
  await writeFile(swordPath, JSON.stringify(sword, null, 2) + '\n');
  log(`[install] Sword-Instanz geschrieben: ${v.id}.sword.json`);

  // 7) systemd-Unit (7d2d-spezifisch: kein RCON-Stop).
  const unit = buildSteamUnit({ id: v.id, name, user: v.id, workingDir: workDir, startScript, port });
  const unitPath = await systemWriteService(service, unit);
  log(`[install] systemd-Unit geschrieben: ${unitPath}`);

  const reload = await systemctl(['daemon-reload']);
  if (!reload.ok) log(`[install] WARN daemon-reload: ${reload.stderr || reload.error}`);
  const enable = await systemctl(['enable', service]);
  if (!enable.ok) log(`[install] WARN enable: ${enable.stderr || enable.error}`);

  return {
    id: v.id,
    service,
    workingDir: workDir,
    swordPath,
    unitPath,
    configFile: userConfig,
    steamAppId: Number(appId),
    warnings: [
      'Service wurde enabled, aber NICHT gestartet.',
      'Config liegt als serversettings.xml vor (Update-sicher) - im Panel editierbar.',
    ],
  };
}

// Erzeugt eine Kopie des Startskripts, die den Server-Log auf einen FESTEN
// Pfad zwingt. Hintergrund: startserver.sh ruft das Binary mit
//   -logfile <workdir>/output_log__<datum>__<zeit>.txt
// auf. Der Dateiname wechselt bei JEDEM Start, und das Spiel ignoriert ein
// spaeteres -logfile (das ERSTE gewinnt). Die Live-Konsole im Panel kann einem
// wechselnden Namen nicht folgen - daher schreibt die Kopie auf logFile.
//
// Die Kopie heisst startserver.armory.sh und wird bei jedem Install neu
// erzeugt; ein Steam-Update, das startserver.sh ueberschreibt, ist damit egal.
async function writeArmoryStartScript({ id, workDir, startScript, logFile, log = () => {} }) {
  if (!logFile) return null;
  const srcPath = join(workDir, startScript);
  let content;
  try {
    content = await readFile(srcPath, 'utf8');
  } catch (err) {
    log(`[install] WARN Startskript-Kopie: ${srcPath} nicht lesbar (${err.message})`);
    return null;
  }

  // Die Aufrufzeile endet mit: ... -logfile "$SERVERDIR"/output_log__`date ...`.txt ...
  // Wir ersetzen NUR den -logfile-Wert durch den festen Pfad. Alles andere
  // (Config-Check, LD_LIBRARY_PATH, cd) bleibt unveraendert.
  // Wert und Argumentgrenze: der -logfile-Wert besteht aus mehreren Teilen
  // ("$SERVERDIR"/output_log__`date ...`.txt). Ein Muster nur auf den ersten
  // Teil wuerde einen kaputten Pfad hinterlassen. Deshalb alles bis zum
  // naechsten Argument (-quit) ersetzen.
  const replaced = content.replace(
    /-logfile\s+.*?\s-quit/,
    `-logfile ${logFile} -quit`,
  );
  if (replaced === content) {
    log('[install] WARN Startskript-Kopie: kein -logfile im Skript gefunden - unveraendert uebernommen');
  }

  const dstName = startScript.replace(/\.sh$/, '.armory.sh');
  const dstPath = join(workDir, dstName);
  await writeFile(dstPath, replaced, 'utf8');
  try { await chmod(dstPath, 0o755); } catch { /* Helfer setzt Rechte ohnehin */ }
  const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'chown-file', id, dstPath]);
  if (!res.ok) log(`[install] WARN chown ${dstPath}: ${res.stderr || res.error}`);
  log(`[install] Startskript-Kopie erzeugt: ${dstName} -> Log ${logFile}`);
  return dstName;
}

// systemd-Unit fuer native (SteamCMD-)Server. Kein Java, kein RCON-Stop via Node.
// startScript zeigt bei 7d2d auf die Armory-KOPIE (startserver.armory.sh), die
// den Server-Log auf einen festen Pfad zwingt - sonst schreibt das Spiel in
// output_log__<zeitstempel>.txt und die Live-Konsole bleibt leer.
function buildSteamUnit({ id, name, user, workingDir, startScript, port }) {
  return `# Game-Armory: automatisch erzeugte Unit fuer ${name}
[Unit]
Description=${name} Dedicated Server (Game-Armory)
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${workingDir}
ExecStart=/bin/bash ${join(workingDir, startScript)} -configfile=serversettings.xml

Restart=on-abnormal
RestartSec=15

# Getrennte Ziele: systemd schreibt seine eigenen Zeilen (Startfehler von bash,
# Hinweise) als root nach unit.log. Das SPIEL schreibt selbst in ${id}.log
# (fester -logfile-Pfad aus dem Rack) - beide Ziele duerfen NICHT dieselbe Datei
# sein, sonst kann der als ${user} laufende Server sie nicht oeffnen.
StandardOutput=append:/var/log/${id}/unit.log
StandardError=append:/var/log/${id}/unit.err

TimeoutStopSec=60
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
`;
}

// ---------------------------------------------------------------------------

// Ermittelt die Pack-Version aus einem CurseForge-Dateiobjekt (Spec 2026-10-10).
//   displayName "All the Mods 10 - 8.1"       -> "8.1"
//   fileName    "ServerFiles-8.1.zip"        -> "8.1"
// Rueckgabe: Version-String oder null (kein Raten).
export function extractCurseForgeVersion(file) {
  if (!file) return null;
  // Release-Suffixe, die zur Version gehoeren duerfen (Allowlist statt "alles
  // was kein Punkt ist" - sonst schluckt das Muster "beta.zip" mit).
  const REL = 'alpha|beta|rc|pre|preview|snapshot';
  const reServerFiles = new RegExp(
    `(?:ServerFiles|serverfiles)[-_]?([0-9]+(?:\\.[0-9]+)+(?:-(?:${REL})(?:\\.?[0-9]+)?)?)\\s*$`, 'i');
  const reTrailing = new RegExp(
    `-\\s*([0-9]+(?:\\.[0-9]+)+(?:-(?:${REL})(?:\\.?[0-9]+)?)?)\\s*$`, 'i');
  const reAny = /(?:^|[^0-9A-Za-z])([0-9]+\.[0-9]+(?:\.[0-9]+)*)(?:[^0-9A-Za-z]|$)/;

  for (const field of [file.displayName, file.fileName]) {
    if (typeof field !== 'string') continue;
    // Endung strippen: sie darf nie Teil der Version werden (Bug: "0.12.0-beta.zip").
    const s = field.replace(/\.(zip|jar)$/i, '');
    for (const re of [reServerFiles, reTrailing]) {
      const m = s.match(re);
      if (m) return m[1];
    }
    // Upload-Namen (upload-<uuid>) tragen keine Pack-Version - nicht raten.
    if (/\bupload[-_]/i.test(s)) continue;
    const m = s.match(reAny);
    if (m) return m[1];
  }
  return null;
}

export async function installFromCurseForge({ id, name, modId, fileId, port, acceptEula = false, acceptedBy = null }, { log = () => {} } = {}) {
  const v = validateInstallInput({ id, name, port });
  if (!modId) throw new InstallerError('modId fehlt');
  if (!(await getMod(modId))) throw new InstallerError('Modpack nicht gefunden');

  let file;
  if (fileId) {
    const files = await getFiles(modId, { pageSize: 50 });
    file = files.find((f) => f.id === Number(fileId));
    if (!file) throw new InstallerError(`Datei ${fileId} nicht im Projekt gefunden`);
  } else {
    const files = await getFiles(modId, { pageSize: 50 });
    const releases = files.filter((f) => f.releaseType === 1)
      .sort((a, b) => String(b.fileDate).localeCompare(String(a.fileDate)));
    file = releases[0];
    if (!file) throw new InstallerError('Keine Release-Datei gefunden');
  }

  let url = file.downloadUrl;
  if (!url) url = await getDownloadUrl(modId, file.id);

  // Version ermitteln (Spec 2026-10-10): CurseForge nennt sie im displayName
  // (z.B. "All the Mods 10 - 8.1") oder im Dateinamen ("ServerFiles-8.1.zip").
  // Beides ist die Pack-Version; Neoforge bleibt der Fallback in installFromSource.
  const fileVersion = extractCurseForgeVersion(file);

  const workDir = join(MINECRAFT_ROOT, v.id);
  if (await pathExists(workDir)) throw new InstallerError(`Zielordner existiert bereits: ${workDir}`);
  // /opt/minecraft selbst muss existieren und beschreibbar fuer den Helfer sein;
  // anlegen ueber den Helfer (armory darf dort nicht mkdir).
  {
    const res = await runCmd('sudo', ['-n', INSTALL_HELPER, 'mkdir-tree', v.id, MINECRAFT_ROOT]);
    if (!res.ok) throw new InstallerError(`/opt/minecraft konnte nicht vorbereitet werden: ${res.stderr || res.error}`);
  }

  const tmpZip = join(MINECRAFT_ROOT, `.${v.id}-download-${Date.now()}.zip`);
  log(`[install] Lade CurseForge-Datei ${file.fileName} ...`);
  try {
    await downloadFile(url, tmpZip);
    return await installFromZip(
      { ...v, zipPath: tmpZip, acceptEula, acceptedBy, packVersion: fileVersion, packVersionSource: fileVersion ? 'curseforge' : null },
      { log },
    );
  } finally {
    await rm(tmpZip, { force: true }).catch(() => {});
  }
}
