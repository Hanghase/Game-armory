// Game-Armory - Updater
// Aktualisiert ein bestehendes Sword (Server-Instanz) aus einem ZIP oder CurseForge.
//
// Ablauf (updateFromZip):
//   1) Backup (Welt + User-Dateien) als tar.gz in <workingDir>/backups/
//   2) Server stoppen und warten, bis der Service inaktiv ist
//   3) ZIP entpacken
//   4) replacePackContents (config/kubejs werden mit ersetzt)
//   5) Neoforge-Versions-Check (ZIP-libraries vs. installiert)
//   6) Server starten
//   7) Log auf "Done (" pruefen (bis 180s)
//
// Update-Status liegt als Modul-State (getUpdateState) fuer die UI bereit.
// KEIN systemctl-Aufruf ausserhalb von control.js (serviceAction/serviceStatus).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, stat, writeFile, access, open } from 'node:fs/promises';
import { join, basename } from 'node:path';

import { extractToTemp, replacePackContents } from './pack.js';
import { SWORDS_DIR } from './installer.js';
import { detectRequiredNeoforgeVersion, extractCurseForgeVersion } from './installer.js';
import { serviceAction, serviceStatus } from './control.js';
import { getMod, getFiles, getDownloadUrl, downloadFile } from './curseforge.js';

// Privilegierter Install-Helfer (per sudo, eng gefasste Rechte in /etc/sudoers.d/armory).
// Notwendig, weil die Armory als 'armory' laeuft, die Instanz-Daten aber dem
// jeweiligen Server-User gehoeren (atm10, 7d2d, ...). tar/cp muessen deshalb
// als dieser User laufen - sonst scheitert der Zugriff auf 0600-Weltdateien.
const INSTALL_HELPER = '/usr/local/bin/armory-install-helper';

async function runHelper(step, args, { log = () => {} } = {}) {
  const res = await run('sudo', ['-n', INSTALL_HELPER, step, ...args]);
  if (!res.ok) log(`[helper] ${step}: ${res.stderr || res.error}`);
  return res;
}

const execFileAsync = promisify(execFile);

export class UpdaterError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'UpdaterError';
    this.status = status;
  }
}

// --- Update-Status (In-Memory, fuer UI-Polling) ----------------------------

const states = new Map(); // swordId -> state

function setState(swordId, patch) {
  const prev = states.get(swordId) ?? {
    phase: 'idle', progress: 0, message: '', startedAt: null, finishedAt: null, error: null,
  };
  const next = { ...prev, ...patch };
  states.set(swordId, next);
  return next;
}

export function getUpdateState(swordId) {
  return states.get(swordId) ?? {
    phase: 'idle', progress: 0, message: 'Kein Update aktiv.',
    startedAt: null, finishedAt: null, error: null,
  };
}

// --- Hilfen ----------------------------------------------------------------

async function pathExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function run(cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args);
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '', error: err.message };
  }
}

// --- Backup ----------------------------------------------------------------

// Erzeugt ein tar.gz der uebergebenen Pfade in <workingDir>/backups/.
// Raeumt danach alte Generationen auf (keepGenerations, Standard 2).
export async function createBackup(workingDir, { id, paths = [], log = () => {}, keepGenerations = 2, label = 'backup' } = {}) {
  const backupDir = join(workingDir, 'backups');
  // Bugfix 2026-10-26 (Audit): 'armory' darf unter einem Instanz-Verzeichnis
  // kein mkdir (Owner ist der Instanz-User). Deshalb ueber den Helfer, der
  // legt an und setzt den Eigentuemer in einem Schritt - wie bei den anderen
  // Schreibpfaden (AGENTS.md: Schreibpfade ueber den Helfer).
  // Nicht fatal: existiert es schon, ist der Aufruf ein No-Op. Schlaegt er
  // fehl, entscheidet der tar-Aufruf darunter, ob es geht (Backup ist optional).
  if (!(await pathExists(backupDir))) {
    const mk = await runHelper('mkdir-tree', [id, backupDir], { log });
    if (!mk.ok) log(`[backup] Warnung: ${backupDir} konnte nicht angelegt werden: ${mk.stderr || mk.error}`);
  }

  const present = [];
  for (const p of paths) {
    if (await pathExists(join(workingDir, p))) present.push(p);
  }
  if (present.length === 0) {
    log('[backup] Keine der angegebenen Pfade vorhanden - Backup uebersprungen.');
    return { created: false, file: null, included: [] };
  }
  if (!id) throw new UpdaterError('createBackup braucht die Instanz-id (Rechte des Server-Users).');

  log(`[backup] Erstelle Backup (${present.join(', ')}) als ${id}`);
  // tar laeuft ueber den Helfer als Instanz-User - siehe backup-tar dort.
  const res = await runHelper('backup-tar', [id, label, workingDir, ...present], { log });
  if (!res.ok) throw new UpdaterError(`Backup fehlgeschlagen: ${res.stderr || res.error}`);

  const out = String(res.stdout).trim();
  const m = out.match(/backup ok (.+)$/m);
  const file = m ? m[1].trim() : null;
  if (!file) throw new UpdaterError(`Backup meldete keinen Pfad: ${out}`);
  log(`[backup] Fertig: ${file}`);

  await pruneBackups(backupDir, { id, keepGenerations, label, log });
  return { created: true, file, included: present };
}

// Aufraeumen alter Backup-Generationen ueber den Helfer (als root).
// Warum nicht direkt: Backups koennen gemischte Besitzer haben - alte von
// 'armory', neue vom Instanz-User. 'armory' scheitert an dessen Dateien
// (EACCES). Der Helfer loescht streng begrenzt: nur <label>-*.tar.gz
// direkt im backupDir, die aeltesten zuerst.
async function pruneBackups(backupDir, { id, keepGenerations, label, log }) {
  if (!id) throw new UpdaterError('pruneBackups braucht die Instanz-id.');
  const res = await runHelper('prune-backups', [backupDir, label, String(Math.max(0, keepGenerations))], { log });
  if (!res.ok) {
    log(`[backup] Warnung: Aufraeumen fehlgeschlagen: ${res.stderr || res.error}`);
    return;
  }
  const out = String(res.stdout).trim();
  const m = out.match(/prune ok (\d+) removed/);
  if (m && Number(m[1]) > 0) log(`[backup] ${m[1]} alte Generation(en) entfernt.`);
}

// --- Neoforge-Versions-Check ----------------------------------------------

// Ermittelt die Neoforge-Version aus einem libraries/-Pfad:
//   libraries/net/neoforged/neoforge/<version>/...
// Rueckgabe: Version-String oder null.
// Versionsvergleich NUMERISCH, nicht lexikografisch.
// Audit-Fix 2026-10-30 (D320): [...versions].sort() verglich Ziffern als Text.
// ['21.1.100','21.1.99','21.1.209'].sort() ergibt 21.1.100, 21.1.209, 21.1.99 -
// .pop() nahm also 21.1.99 statt 21.1.209. Bei zwei Builds im selben Bereich
// (99 und 259) wurde so die AELTERE Version als installiert erkannt und beim
// Update die falsche Zielversion gesetzt.
function cmpVersion(a, b) {
  const pa = String(a).split(/[.\-_+]/);
  const pb = String(b).split(/[.\-_+]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const na = Number.parseInt(pa[i], 10);
    const nb = Number.parseInt(pb[i], 10);
    // Nicht-numerische Teile (z.B. 'beta', 'LTS') kommen nach den numerischen,
    // damit eine Release-Version immer vor ihrem Vorab-Stand liegt.
    const aNum = Number.isFinite(na);
    const bNum = Number.isFinite(nb);
    if (aNum && bNum) {
      if (na !== nb) return na - nb;
    } else if (aNum !== bNum) {
      return aNum ? 1 : -1;
    } else {
      const sa = String(pa[i] ?? '');
      const sb = String(pb[i] ?? '');
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

function newestVersion(versions) {
  let best = null;
  for (const v of versions) {
    if (best === null || cmpVersion(v, best) > 0) best = v;
  }
  return best;
}

export function detectNeoforgeVersionFromPaths(paths) {
  const re = /libraries\/net\/neoforged\/neoforge\/([^/]+)\//;
  const versions = new Set();
  for (const p of paths) {
    const m = String(p).replace(/\\/g, '/').match(re);
    if (m) versions.add(m[1]);
  }
  if (versions.size === 0) return null;
  return newestVersion([...versions]);
}

export async function detectInstalledNeoforgeVersion(workingDir) {
  const base = join(workingDir, 'libraries', 'net', 'neoforged', 'neoforge');
  try {
    const entries = await readdir(base);
    const dirs = entries.filter((e) => /^\d/.test(e));
    if (dirs.length === 0) return null;
    return newestVersion(dirs); // numerisch, nicht lexikografisch (D320)
  } catch {
    return null;
  }
}

// Stellt sicher, dass die von startserver.sh benoetigte Neoforge-Version in
// libraries/ vorhanden ist. Fehlt sie (typisch beim Versionswechsel im Update),
// wird libraries/ entfernt - dann laesst das startserver.sh den (mitgelieferten,
// vorgepatchten) Installer beim Start laufen und baut alles neu auf.
//
// Liefert { required, installed, action }:
//   action = 'ok'          -> Version liegt bereits vor (nichts zu tun)
//   action = 'rebuilt'     -> libraries/ entfernt, startserver.sh installiert
//   action = 'skipped'     -> keine NEOFORGE_VERSION im Startskript (kein ATM-Pack)
// Wirft, wenn die Version fehlt UND kein Installer im Ziel liegt (dann koennte
// startserver.sh nichts installieren -> toter Server. Lieber Update abbrechen).
export async function ensureNeoforgePresent(sword, workingDir, { log = () => {} } = {}) {
  const id = sword.id;
  const startScript = sword.startScript || 'startserver.sh';
  const required = await detectRequiredNeoforgeVersion(join(workingDir, startScript));
  if (!required) {
    log('[update] Keine NEOFORGE_VERSION im Startskript - Neoforge-Aufbau uebersprungen.');
    return { required: null, installed: null, action: 'skipped' };
  }
  const installed = await detectInstalledNeoforgeVersion(workingDir);
  const versionDir = join(workingDir, 'libraries', 'net', 'neoforged', 'neoforge', required);
  if (await pathExists(versionDir)) {
    log(`[update] Neoforge ${required} liegt bereits in libraries/ - kein Neuaufbau noetig.`);
    return { required, installed, action: 'ok' };
  }
  // Version fehlt. Ist ein Installer im Ziel, den startserver.sh nutzen kann?
  const hasInstaller = (await readdir(workingDir).catch(() => []))
    .some((n) => /^neoforge-.*-installer\.jar$/.test(n));
  if (!hasInstaller) {
    throw new UpdaterError(
      `Neoforge ${required} fehlt in libraries/ und im Instanzordner liegt kein ` +
      `neoforge-*-installer.jar - startserver.sh koennte nichts installieren. ` +
      `Update abgebrochen (statt toten Server zu starten). Pruefe das Pack-ZIP.`
    );
  }
  log(`[update] Neoforge ${required} fehlt (installiert: ${installed ?? 'keine'}) - ` +
      `libraries/ wird entfernt, startserver.sh baut beim Start neu auf.`);
  const res = await runHelper('remove-tree', [id, workingDir, 'libraries'], { log });
  if (!res.ok) {
    throw new UpdaterError(`libraries/ konnte nicht entfernt werden: ${res.stderr || res.error}`);
  }
  return { required, installed, action: 'rebuilt' };
}

export async function checkNeoforgeVersion(workingDir, zipLibPaths, { log = () => {} } = {}) {
  const packVersion = detectNeoforgeVersionFromPaths(zipLibPaths);
  const installed = await detectInstalledNeoforgeVersion(workingDir);
  const changed = Boolean(packVersion && installed && packVersion !== installed);
  if (changed) {
    log(`[update] Neoforge-Version aendert sich: ${installed} -> ${packVersion}`);
  } else if (packVersion) {
    log(`[update] Neoforge-Version unveraendert: ${installed ?? packVersion}`);
  } else {
    log('[update] Keine Neoforge-Version im ZIP gefunden - Check uebersprungen.');
  }
  return { packVersion, installed, changed };
}

// --- Log-Warten auf "Done (" -------------------------------------------------

export async function waitForDone(sword, { timeoutMs = 180_000, pollMs = 3000, log = () => {} } = {}) {
  const logPath = sword.logs?.path;
  const deadline = Date.now() + timeoutMs;
  let startOffset = 0;
  try {
    startOffset = (await stat(logPath)).size;
  } catch { startOffset = 0; }

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      const { size } = await stat(logPath);
      if (size < startOffset) startOffset = 0; // Log rotiert/geleert -> neu einsteigen
      if (size > startOffset) {
        // Bugfix 2026-10-26: vorher `readFile(logPath)` - das las die GANZE
        // Datei in den Speicher und nutzte davon nur die Bytes ab startOffset.
        // Beim atm10-Update sind das 98 MB pro Poll, alle 3 Sekunden, bis zu
        // 60 Mal. Jetzt nur der neue Bereich per Datei-Deskriptor, mit Deckel
        // gegen Ausreisser (Log-Ausbrueche durch Mod-Fehler).
        const MAX_FRESH = 8 * 1024 * 1024;
        const from = Math.min(startOffset, size);
        const to = Math.min(size, from + MAX_FRESH);
        const fh = await open(logPath, 'r');
        let fresh;
        try {
          const buf = Buffer.alloc(to - from);
          const { bytesRead } = await fh.read(buf, 0, buf.length, from);
          fresh = buf.subarray(0, bytesRead).toString('utf8');
        } finally {
          await fh.close();
        }
        startOffset = to;
        if (fresh.includes('Done (')) return { ok: true, matched: 'Done (' };
      }
    } catch { /* Logdatei evtl. noch nicht da */ }
  }
  return { ok: false, matched: null };
}

// --- Warten bis Service inaktiv ---------------------------------------------

async function waitForInactive(service, { timeoutMs = 60_000, pollMs = 2000, log = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await serviceStatus(service);
    if (!st.running) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  log('[update] Timeout: Service laeuft noch.');
  return false;
}

// --- Gemeinsamer Kern --------------------------------------------------------

const BACKUP_PATHS = ['world', 'server.properties', 'ops.json', 'whitelist.json', 'banned-ips.json', 'banned-players.json', 'usercache.json', 'usernamecache.json', 'server-icon.png'];

async function runUpdate(sword, { zipPath, keepConfigs = false, log = () => {}, newVersion = null, newVersionSource = null }) {
  const swordId = sword.id;
  const service = sword.control?.service;
  const workingDir = sword.control?.workingDir;
  if (!service || !workingDir) throw new UpdaterError('Sword hat keinen Service/workingDir definiert.');

  const startedAt = Date.now();
  setState(swordId, { phase: 'starting', progress: 0, message: 'Update gestartet', startedAt, finishedAt: null, error: null });

  const gen = sword.update?.keepGenerations ?? 2;
  const result = { swordId, backup: null, neoforge: null, neoforgeBuild: null, pack: null, started: false, doneSeen: false };
  let stopped = false; // true, sobald der Stop durch ist

  try {
    // 1) Stop + warten - VOR dem Backup. Grund: ein laufender Server schreibt
    //    permanent in world/region/*.mca und level.dat. Ein tar waehrenddessen
    //    liefert keinen konsistenten Schnitt (Dateien mittendrin geaendert).
    //    Ohne Halt kein sauberes Backup - deshalb bricht ein fehlgeschlagener
    //    Stop das Update ab, statt ohne Backup weiterzumachen.
    setState(swordId, { phase: 'stopping', progress: 5, message: 'Server wird gestoppt' });
    const stop = await serviceAction(service, 'stop');
    if (!stop.ok) throw new UpdaterError(`Server konnte nicht gestoppt werden: ${stop.error || 'unbekannter Fehler'}`);
    const inactive = await waitForInactive(service, { log });
    if (!inactive) throw new UpdaterError('Server wurde nicht rechtzeitig inaktiv.');
    stopped = true; // ab hier ist der Server aus - Fehler muessen ihn wieder hochfahren

    // 2) Backup (jetzt konsistent, da der Server steht)
    setState(swordId, { phase: 'backup', progress: 15, message: 'Backup wird erstellt' });
    result.backup = await createBackup(workingDir, { id: swordId, paths: BACKUP_PATHS, log, keepGenerations: gen, label: 'update' });

    // 3) Entpacken
    setState(swordId, { phase: 'extracting', progress: 40, message: 'Pack wird entpackt' });
    const { tmpRoot, sourceDir } = await extractToTemp(zipPath, { id: swordId, log });
    let neoforgePaths = [];
    try {
      neoforgePaths = await listSourcePaths(sourceDir, 'libraries');

      // 4) Inhalte ersetzen
      setState(swordId, { phase: 'applying', progress: 55, message: 'Pack-Inhalte werden ersetzt' });
      result.pack = await replacePackContents(sourceDir, workingDir, { id: swordId, keepConfigs, log });
    } finally {
      // Temp gehoert dem Instanz-User - 'armory' kann es nicht loeschen.
      await runHelper('cleanup-path', [tmpRoot], { log });
    }

    // 5) Neoforge sicherstellen. ATM-Packs bringen bei JEDEM Update eine
    //    vorgepatchte neoforge-<version>-installer.jar mit; das startserver.sh
    //    ruft sie nur auf, wenn 'libraries/' FEHLT. Bei einem Update existiert
    //    'libraries/' aber (vom Erststart) -> Installer laeuft nie -> die neue
    //    Version fehlt und der Server bricht sofort ab
    //    ("could not open libraries/.../<version>/unix_args.txt").
    //    Deshalb: benötigt das (frisch ersetzte) startserver.sh eine Version,
    //    die in libraries/ NICHT liegt, wird libraries/ entfernt - dann baut
    //    startserver.sh beim Start alles neu auf (inkl. der mitkopierten Jar).
    setState(swordId, { phase: 'checking', progress: 70, message: 'Versions-Check' });
    result.neoforge = await checkNeoforgeVersion(workingDir, neoforgePaths, { log });
    result.neoforgeBuild = await ensureNeoforgePresent(sword, workingDir, { log });

    // 6) Start
    setState(swordId, { phase: 'starting', progress: 80, message: 'Server wird gestartet' });
    const start = await serviceAction(service, 'start');
    result.started = start.ok;
    if (!start.ok) log(`[update] Start-Warnung: ${start.error}`);

    // 7) Done-Warten
    setState(swordId, { phase: 'waiting', progress: 90, message: 'Warte auf Serverstart ("Done (")' });
    const done = await waitForDone(sword, { timeoutMs: 180_000, log });
    result.doneSeen = done.ok;

    // BUGFIX 2026-10-18: Das Ergebnis (Backup-Datei, Pack-Statistik, ob der
    // Server wirklich hochkam) wurde nur zurueckgegeben, aber NIE in den
    // Status geschrieben - das Panel konnte dem Nutzer also nicht sagen,
    // WO sein Backup liegt. Genau das ist im Fehlerfall die wichtigste Info.
    const summary = {
      backup: result.backup?.file ?? null,
      backupIncluded: result.backup?.included ?? [],
      pack: result.pack ?? null,
      neoforge: result.neoforge ?? null,
      started: result.started,
      doneSeen: result.doneSeen,
    };

    // Audit-Fix 2026-10-30 (C124): Die message sagte "Update erfolgreich
    // abgeschlossen", auch wenn der Serverstart fehlgeschlagen war (start.ok
    // false). Die UI faerbt den Balken bei phase='done' gruen - der
    // widersprechende Hinweis stand nur im Ergebnis-Panel darunter.
    // Jetzt nennt die message den Start mit; error bleibt null, weil das UPDATE
    // selbst durchgelaufen ist. Ein API-Aufrufer sieht am Text, was los ist.
    if (!result.started) {
      setState(swordId, { phase: 'done', progress: 100, message: 'Update angewendet, aber Serverstart FEHLGESCHLAGEN - bitte Log pruefen.', finishedAt: Date.now(), error: null, result: summary });
    } else if (done.ok) {
      setState(swordId, { phase: 'done', progress: 100, message: 'Update erfolgreich abgeschlossen', finishedAt: Date.now(), error: null, result: summary });
    } else {
      setState(swordId, { phase: 'done', progress: 100, message: 'Update angewendet, aber "Done (" nicht bestaetigt (Timeout 180s).', finishedAt: Date.now(), error: null, result: summary });
    }

    // 8) Version im Sword fortschreiben (Spec 2026-10-10): nach einem Update
    //    kennt die Instanz ihre neue Version. Reihenfolge (wichtig):
    //    a) vom Aufrufer gemeldete Version (CurseForge-Datei)
    //    b) Pack-Version aus dem ZIP-Dateinamen  ("ServerFiles-8.3.zip" -> 8.3)
    //    c) Neoforge-Version aus dem frisch entpackten Pack (letzter Ausweg)
    //    Fehler hier duerfen das Update NICHT kippen - der Server laeuft bereits.
    try {
      // (b) Dateiname: dieselbe gepruefte Logik wie beim Erstinstall
      //     (extractCurseForgeVersion, Spec 2026-10-10) - kein zweiter Parser.
      const fromFilename = extractCurseForgeVersion({ fileName: basename(zipPath) });
      // (c) BUGFIX 2026-10-16: checkNeoforgeVersion liefert { packVersion, installed,
      //     changed } - es gab nie ein Feld 'needed'. Dadurch war die Version
      //     immer null und die Anzeige blieb auf dem Stand des Erstinstalls.
      const fromNeoforge = result.neoforge?.packVersion ?? null;
      const version = newVersion
        || fromFilename
        || (fromNeoforge ? `neoforge ${fromNeoforge}` : null);
      const versionSource = newVersion
        ? (newVersionSource || 'curseforge')
        : fromFilename
          ? 'filename'
          : (fromNeoforge ? 'neoforge-startscript' : null);
      if (version) {
        const swordPath = join(SWORDS_DIR, `${swordId}.sword.json`);
        const current = JSON.parse(await readFile(swordPath, 'utf8'));
        current.installedVersion = version;
        current.installedVersionSource = versionSource;
        current.installedVersionAt = Date.now();
        await writeFile(swordPath, JSON.stringify(current, null, 2) + '\n');
        log(`[update] Version im Sword aktualisiert: ${version} (${versionSource})`);
      } else {
        log('[update] Keine neue Version ermittelbar - Sword-Version bleibt unveraendert.');
      }
    } catch (err) {
      log(`[update] Warnung: Sword-Version konnte nicht fortgeschrieben werden: ${err.message}`);
    }

    return { ok: true, ...result };
  } catch (err) {
    // Wir haben den Server gestoppt, aber das Update ist gescheitert: die
    // Instanz darf nicht down liegen bleiben. Wieder hochfahren - der Status
    // bleibt 'error', das ist Wiederherstellung, kein Erfolg.
    if (stopped && !result.started) {
      log('[update] Fehler - Server wird wieder gestartet (Wiederherstellung).');
      const rec = await serviceAction(service, 'start');
      if (!rec.ok) log(`[update] WARNUNG: Wiederstart fehlgeschlagen: ${rec.error}`);
      else result.started = true;
    }
    setState(swordId, { phase: 'error', progress: 100, message: `Update fehlgeschlagen: ${err.message}`, finishedAt: Date.now(), error: err.message, result: {
      // Auch im Fehlerfall: wo liegt das Backup? Bei einem gescheiterten
      // Update ist das die Information, die zaehlt.
      backup: result.backup?.file ?? null,
      backupIncluded: result.backup?.included ?? [],
      pack: result.pack ?? null,
      neoforge: result.neoforge ?? null,
      started: result.started,
      doneSeen: result.doneSeen,
    } });
    throw err;
  }
}

// Listet relative Pfade unterhalb eines Verzeichnisses (rekursiv) als
// "libraries/..."-Strings - genutzt fuer den Neoforge-Check.
async function listSourcePaths(sourceDir, sub) {
  const base = join(sourceDir, sub);
  const out = [];
  async function walk(dir, rel) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), childRel);
      else out.push(childRel);
    }
  }
  await walk(base, sub);
  return out;
}

// --- Oeffentliche API --------------------------------------------------------

export async function updateFromZip(sword, zipPath, { onLog = () => {}, keepConfigs } = {}) {
  if (!(await pathExists(zipPath))) throw new UpdaterError(`ZIP nicht gefunden: ${zipPath}`);
  const keep = keepConfigs ?? sword.update?.keepConfigs ?? false;
  return runUpdate(sword, { zipPath, keepConfigs: keep, log: onLog });
}

export async function updateFromCurseForge(sword, { modId, fileId, onLog = () => {}, keepConfigs } = {}) {
  const projectId = modId ?? sword.update?.projectId;
  if (!projectId) throw new UpdaterError('Kein CurseForge-Projekt (modId) vorhanden.');
  await getMod(projectId); // Existenz pruefen (wirft ohne Key)

  const files = await getFiles(projectId, { pageSize: 50 });
  let file;
  if (fileId) {
    file = files.find((f) => f.id === Number(fileId));
    if (!file) throw new UpdaterError(`Datei ${fileId} nicht gefunden`);
  } else {
    file = files.filter((f) => f.releaseType === 1)
      .sort((a, b) => String(b.fileDate).localeCompare(String(a.fileDate)))[0];
    if (!file) throw new UpdaterError('Keine Release-Datei gefunden');
  }

  let url = file.downloadUrl;
  if (!url) url = await getDownloadUrl(projectId, file.id);

  const workingDir = sword.control?.workingDir;
  const tmpZip = join(workingDir, `.armory-update-${Date.now()}.zip`);
  await mkdir(workingDir, { recursive: true });
  try {
    onLog(`[update] Lade CurseForge-Datei ${file.fileName} ...`);
    await downloadFile(url, tmpZip);
    const keep = keepConfigs ?? sword.update?.keepConfigs ?? false;
    return await runUpdate(sword, { zipPath: tmpZip, keepConfigs: keep, log: onLog });
  } finally {
    // Download liegt im workingDir des Instanz-Users -> ueber den Helfer weg.
    await runHelper('cleanup-path', [tmpZip], { log });
  }
}
