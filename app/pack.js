// Game-Armory - Pack-Verwaltung (ZIP-Handling)
// Entpackt Serverpack-ZIPs mit strikter Pfadpruefung (kein Zip-Slip) und
// schuetzt User-Daten: Welt, Configs und Server-Dateien bleiben unangetastet.
//
// REGEL (Betreiber, 2026-10-15): Beim Update wird ALLES aus dem Pack-ZIP ins
// Instanzverzeichnis kopiert - NICHTS darf ausgelassen werden. Eine feste
// Positiv-Liste hat genau das getan (z.B. eine neue
// neoforge-<version>-installer.jar fiel still durch) und ist deshalb raus.
//
// Geschuetzt (bleiben unangetastet): world*, server.properties, eula.txt,
// ops/whitelist/banned-*.json, usercache.json, server-icon.png, logs/,
// journeymap/, backups/, dynamic-data-pack-cache/, .mixin.out.
// NICHT mehr geschuetzt: local/ (ist ein Pack-Ordner, wird ersetzt).
// config/ und kubejs/ sind Pack-Inhalt und werden IMMER ersetzt; sie gehoeren
// zur Pack-Version (ein neuer Mod braucht die passenden Configs).

import { createHash } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { spawn } from 'node:child_process';

// Historische Positiv-Liste: NICHT mehr fuer das Ersetzen verwendet (sie hat
// Eintraege ausgelassen - genau der Bug). Bleibt nur zur Dokumentation, welche
// Pfade ein ATM-Pack typischerweise mitbringt. Die Ersetzungslogik arbeitet
// jetzt mit dem tatsaechlichen Inhalt des entpackten Packs.
export const PACK_PATHS = [
  'mods', 'config', 'libraries', 'libraries-integratedscripting', 'kubejs',
  'defaultconfigs', 'datapacks', 'patchouli_books', 'moonlight-global-datapacks',
  'run.sh', 'startserver.sh', 'startserver.bat', 'user_jvm_args.txt',
];

// Diese Pfade werden NIE angefasst - weder im Temp noch im Ziel. Echte
// Server-/User-Daten. Alles andere aus dem Pack wird ersetzt.
// Hinweis: 'local' ist bewusst NICHT mehr enthalten (Pack-Ordner, wird ersetzt).
export const PROTECTED_PATHS = [
  'world', 'server.properties', 'eula.txt', 'ops.json', 'whitelist.json',
  'banned-ips.json', 'banned-players.json', 'usercache.json',
  'usernamecache.json', 'server-icon.png', 'logs', 'journeymap',
  '.mixin.out', 'dynamic-data-pack-cache', 'backups',
];

// Muster, die nicht als exakter Name in PROTECTED_PATHS stehen koennen
// (Audit-Fix 2026-10-30, C102). Der Kommentar oben dokumentierte seit jeher
// "world*", der Code prueft aber mit includes() auf exakte Gleichheit - also
// traf nur 'world'. Minecraft legt bei mehreren Dimensionen zusaetzlich
// world_nether/ und world_the_end/ an; ein Pack-Update haette sie ueberschrieben.
// Alles, was auf diese Muster passt, gilt ebenfalls als geschuetzt.
const PROTECTED_PATTERNS = [
  /^world(_nether|_the_end)?$/,   // world, world_nether, world_the_end
];

// Einheitliche Pruefung - EINE Stelle, damit Liste und Muster nie auseinanderlaufen.
export function isProtectedPath(name) {
  if (PROTECTED_PATHS.includes(name)) return true;
  return PROTECTED_PATTERNS.some((re) => re.test(name));
}

// Pack-Ordner, die wie Einstellungen aussehen, aber zur Pack-Version gehoeren.
// Sie werden seit 2026-10-18 immer ersetzt (keepConfigs-Default false): ein
// Pack-Update bringt passende Configs mit, alte Configs + neuer Mod = Crash.
// Der Schalter bleibt nur als Notausgang fuer Sonderfaelle erhalten.
const CONFIG_LIKE = new Set(['config', 'defaultconfigs', 'kubejs', 'patchouli_books']);

export class PackError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'PackError';
    this.status = status;
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => { stdout += c.toString(); });
    child.stderr?.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new PackError(`${cmd} fehlgeschlagen (exit ${code}): ${stderr || stdout}`));
    });
  });
}

// Privilegierter Helfer: cp/rename muessen als der User laufen, dem die
// Instanz-Daten gehoeren (atm10, 7d2d, ...) - die Armory laeuft als 'armory'.
const INSTALL_HELPER = '/usr/local/bin/armory-install-helper';

// Wie run(), aber als Helfer und mit {ok}-Rueckgabe statt Wurf - der Aufrufer
// entscheidet ueber Fehlerbehandlung und Rollback.
async function runHelper(step, args, { log = () => {} } = {}) {
  try {
    const res = await run('sudo', ['-n', INSTALL_HELPER, step, ...args]);
    return { ok: true, stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    log(`[helper] ${step}: ${err.message}`);
    return { ok: false, stdout: '', stderr: err.message };
  }
}

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

export async function listZip(zipPath) {
  const { stdout } = await run('unzip', ['-Z1', zipPath]);
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

// --- Archiv-Erkennung (2026-10-18) -----------------------------------------
// Warum: ein Rack kann per ZIP ODER per Tarball aktualisiert werden (TS6 kommt
// als .tar.gz, Modpacks als .zip). Vorher war pack.js komplett auf 'unzip'
// gebaut - ein Tarball scheiterte beim Lesen der Eintraege mit
// "End-of-central-directory signature not found". Deshalb entscheidet jetzt
// der INHALT (Magic Bytes), nicht der Dateiname.

// 'zip' | 'tar' | null. Liest die ersten 4 Bytes - kein Rueckgriff auf Endungen,
// die ein Upload faelschen koennte.
export async function detectArchiveKind(filePath) {
  const { open } = await import('node:fs/promises');
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    if (bytesRead >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
      return 'zip';   // PK\x03\x04 (normal), PK\x05\x06 (leer), PK\x07\x08 (spanned)
    }
    if (bytesRead >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'tar';  // gzip
    // xz (0xFD 37 7A 58 5A)
    if (bytesRead >= 4 && buf[0] === 0xfd && buf[1] === 0x37 && buf[2] === 0x7a && buf[3] === 0x58) return 'tar';
    // bzip2 ("BZh") - tar -xf liest das klaglos, wurde aber vorher abgewiesen.
    if (bytesRead >= 3 && buf[0] === 0x42 && buf[1] === 0x5a && buf[2] === 0x68) return 'tar';
    // Unkomprimiertes tar traegt "ustar" erst bei Byte 257 - die 4-Byte-Lesung
    // oben erreicht das nicht. Bugfix 2026-10-26: der Kommentar versprach diese
    // Pruefung, der Code hatte sie nicht, also wurde ein .tar mit "Unbekanntes
    // Archivformat" abgewiesen, obwohl tar es entpacken kann.
    const magic = Buffer.alloc(5);
    const got = await fh.read(magic, 0, 5, 257);
    if (got.bytesRead === 5 && magic.toString('latin1') === 'ustar') return 'tar';
    return null;
  } finally {
    await fh.close();
  }
}

// Eintraege lesen - je nach Format. Beide Formen liefern dieselbe Liste
// (relative Pfade, keine fuehrenden './'), damit der Rest der Logik
// formatunabhaengig bleibt.
export async function listArchive(filePath) {
  const kind = await detectArchiveKind(filePath);
  if (kind === 'zip') return listZip(filePath);
  if (kind === 'tar') return listTarball(filePath);
  throw new PackError(`Unbekanntes Archivformat: ${filePath} (weder ZIP noch tar)`);
}

export async function assertSafeArchive(filePath) {
  const kind = await detectArchiveKind(filePath);
  if (kind === 'zip') return assertSafeZip(filePath);
  if (kind === 'tar') return assertSafeTarball(filePath);
  throw new PackError(`Unbekanntes Archivformat: ${filePath} (weder ZIP noch tar)`);
}

export async function assertSafeZip(zipPath) {
  const entries = await listZip(zipPath);
  for (const entry of entries) {
    const n = normalize(entry).replace(/\\/g, '/');
    if (n.startsWith('..') || n.includes('/../') || n.startsWith('/')) {
      throw new PackError(`Unsicherer Pfad im ZIP: ${entry}`);
    }
  }
  return entries;
}

export async function detectZipRoot(zipPath) {
  const entries = await listZip(zipPath);
  const markers = ['mods', 'config', 'libraries', 'startserver.sh'];
  const hasMarkerAt = (prefix) =>
    entries.some((e) => markers.some((m) =>
      (prefix === '' && (e === m || e.startsWith(`${m}/`))) ||
      (prefix !== '' && e.startsWith(`${prefix}${m}/`))));

  // 1) Inhalt liegt direkt im ZIP-Root.
  if (hasMarkerAt('')) return '';

  // 2) CurseForge-Format: der Inhalt liegt unter 'overrides/' (daneben liegen
  //    manifest.json, modlist.html ...). Das ist der haeufigste Client-Pack-Fall.
  for (const cand of ['overrides', 'server-overrides']) {
    if (entries.some((e) => e.startsWith(`${cand}/`)) && hasMarkerAt(`${cand}/`)) {
      return `${cand}/`;
    }
  }

  // 3) Genau ein Top-Level-Ordner -> nur nehmen, wenn darin ein Marker liegt
  //    (sonst waere es z.B. ein 'docs/'-Ordner ohne Server-Inhalt).
  const top = new Set(entries.map((e) => e.split('/')[0]).filter(Boolean));
  if (top.size === 1) {
    const only = [...top][0];
    if (entries.some((e) => e.startsWith(`${only}/`))) {
      if (hasMarkerAt(`${only}/`)) return `${only}/`;
      // Falls darunter nochmal ein Marker-Ordner liegt, tiefer gehen.
      const deeper = entries
        .filter((e) => e.startsWith(`${only}/`))
        .map((e) => e.split('/')[1])
        .filter(Boolean);
      for (const sub of new Set(deeper)) {
        if (hasMarkerAt(`${only}/${sub}/`)) return `${only}/${sub}/`;
      }
    }
  }

  // 4) Letzter Versuch: irgendeinen Ordner finden, der die Marker enthaelt
  //    (z.B. 'atm10-1.2/mods/...'). Tiefe begrenzt, damit nichts Entferntes greift.
  const dirs = new Set();
  for (const e of entries) {
    const parts = e.split('/').filter(Boolean);
    if (parts.length >= 2) dirs.add(parts.slice(0, -1).join('/') + '/');
  }
  for (const dir of dirs) {
    if (dir.split('/').filter(Boolean).length > 3) continue;
    if (hasMarkerAt(dir)) return dir;
  }
  return '';
}

// Entpackt das Pack-ZIP ueber den Helfer als INSTANZ-User.
// Warum nicht selbst entpacken: mkdtemp legt 0700 an und gehoert 'armory' -
// der Instanz-User (atm10, 7d2d, ...) kann das Temp dann nicht betreten, der
// spaetere replace-pack (laufend als dieser User) scheitert mit EACCES.
// Der Zip-Slip-Schutz laeuft VORHER hier in der Armory (assertSafeZip).
// --- Tarball-Unterstuetzung (fuer URL-Racks wie TeamSpeak 6) ---------------
// Warum eigener Zweig statt ZIP-Erweiterung: ein Release-Tarball hat KEINE
// Modpack-Struktur (keine mods/config/startserver.sh) und keine verschachtelte
// Wurzel. Eine Wurzel-Erkennung wie bei Modpacks waere hier schlicht falsch.

// Listet die Eintraege eines Tarballs (.tar.xz/.gz/.bz2). GNU tar erkennt die
// Kompression selbst; -f liest die Datei, --force-local verhindert, dass ein
// Doppelpunkt im Pfad als Remote-Spezifikation gilt.
export async function listTarball(tarballPath) {
  const { stdout } = await run('tar', ['-tf', tarballPath, '--force-local']);
  return stdout.split('\n').map((s) => s.trim().replace(/^\.\//, '')).filter(Boolean);
}

// Sicherheitspruefung analog assertSafeZip: absolute Pfade und '..' verbieten
// (Tar-Slip). Zusaetzlich: symbolische/harte Links ablehnen, weil ein Link aus
// dem Zielordner herauszeigen koennte - beim Entpacken als Instanz-User waere
// das ein Ausbruch aus dem vorgesehenen Temp.
export async function assertSafeTarball(tarballPath) {
  const { stdout } = await run('tar', ['-tvf', tarballPath, '--force-local']);
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    // tar -tvf: "<perms> <owner/group> <size> <date> <time> <name>"
    const parts = line.split(/\s+/);
    const perms = parts[0] ?? '';
    const name = parts.slice(5).join(' ');
    if (!name) continue;
    // Link-Typen: l = symlink, h = hardlink. Beide verboten.
    if (perms.startsWith('l') || perms.startsWith('h')) {
      throw new PackError(`Link im Tarball nicht erlaubt: ${name}`);
    }
    const n = normalize(name).replace(/\\/g, '/');
    if (n.startsWith('..') || n.includes('/../') || n.startsWith('/')) {
      throw new PackError(`Unsicherer Pfad im Tarball: ${name}`);
    }
    entries.push(name);
  }
  return entries;
}

// Entpackt einen Tarball ueber den Helfer in ein Temp, das dem Instanz-User
// gehoert. Kein Wurzel-Erkennungs-Schritt: bei einem flachen Release-Archiv
// ist die Wurzel immer '' (Inhalt liegt direkt vor).
export async function extractTarballToTemp(tarballPath, { id, log = () => {} } = {}) {
  if (!id) throw new PackError('extractTarballToTemp braucht die Instanz-id (Rechte des Server-Users).');
  const entries = await assertSafeTarball(tarballPath);
  const res = await runHelper('extract-tarball', [id, tarballPath], { log });
  if (!res.ok) throw new PackError(`Entpacken fehlgeschlagen: ${res.stderr || res.error}`);
  const m = String(res.stdout).match(/extracted (.+)$/m);
  if (!m) throw new PackError(`Helfer meldete keinen Temp-Pfad: ${String(res.stdout).trim()}`);
  const tmpRoot = m[1].trim();
  log(`[pack] Tarball entpackt nach ${tmpRoot} (${entries.length} Eintraege)`);
  return { tmpRoot, sourceDir: tmpRoot };
}

// Formatneutral (2026-10-18): erkennt ZIP und Tarball am Inhalt und ruft den
// passenden Helfer-Schritt. Vorher war hier fest 'assertSafeZip' + 'extract-pack'
// verdrahtet - ein .tar.gz scheiterte bereits beim Lesen der Eintraege
// ("End-of-central-directory signature not found").
// Rueckgabe: { tmpRoot, sourceDir, kind }. Bei Tarballs ist sourceDir = tmpRoot
// (flache Release-Struktur), bei ZIPs ggf. ein Wurzel-Unterordner.
export async function extractToTemp(archivePath, { id, log = () => {} } = {}) {
  if (!id) throw new PackError('extractToTemp braucht die Instanz-id (Rechte des Server-Users).');

  const kind = await detectArchiveKind(archivePath);
  if (!kind) {
    throw new PackError(`Unbekanntes Archivformat (weder ZIP noch tar): ${archivePath}`);
  }

  const entries = await assertSafeArchive(archivePath);
  const top = [...new Set(entries.map((e) => String(e).replace(/^\.\//, '').split('/')[0]).filter(Boolean))];

  if (kind === 'tar') {
    const res = await runHelper('extract-tarball', [id, archivePath], { log });
    if (!res.ok) throw new PackError(`Entpacken fehlgeschlagen: ${res.stderr || res.error}`);
    const m = String(res.stdout).match(/extracted (.+)$/m);
    if (!m) throw new PackError(`Helfer meldete keinen Temp-Pfad: ${String(res.stdout).trim()}`);
    const tmpRoot = m[1].trim();
    log(`[pack] Tarball entpackt nach ${tmpRoot}`);
    log(`[pack] Archiv enthaelt ${entries.length} Eintraege, Top-Level: ${top.slice(0, 12).join(', ')}${top.length > 12 ? ' ...' : ''}`);
    return { tmpRoot, sourceDir: tmpRoot, kind };
  }

  const res = await runHelper('extract-pack', [id, archivePath], { log });
  if (!res.ok) throw new PackError(`Entpacken fehlgeschlagen: ${res.stderr || res.error}`);
  const m = String(res.stdout).match(/extracted (.+)$/m);
  if (!m) throw new PackError(`Helfer meldete keinen Temp-Pfad: ${String(res.stdout).trim()}`);
  const tmpRoot = m[1].trim();
  const root = await detectZipRoot(archivePath);
  log(`[pack] ZIP-Wurzel erkannt: '${root || '(Root)'}', entpackt nach ${tmpRoot}`);
  log(`[pack] ZIP enthaelt ${entries.length} Eintraege, Top-Level: ${top.slice(0, 12).join(', ')}${top.length > 12 ? ' ...' : ''}`);
  return { tmpRoot, sourceDir: join(tmpRoot, root), kind };
}

export async function replacePackContents(sourceDir, targetDir, { id, keepConfigs = false, log = () => {} } = {}) {
  if (!id) throw new PackError('replacePackContents braucht die Instanz-id (Rechte des Server-Users).');
  const report = { replaced: [], skipped: [], removed: [] };

  // ALLES aus dem entpackten Pack ersetzen - ausser den geschuetzten Pfaden und
  // (bei keepConfigs) den Config-Ordnern. Keine feste Positiv-Liste mehr: die
  // hat Eintraege still ausgelassen (Neoforge-Installer-Jar!).
  //
  // 1) Was liegt ueberhaupt im Pack-Temp (Top-Level)?
  let sourceEntries;
  try {
    sourceEntries = (await readdir(sourceDir, { withFileTypes: true })).map((e) => e.name);
  } catch (err) {
    throw new PackError(`Pack-Temp nicht lesbar (${sourceDir}): ${err.message}`);
  }
  if (sourceEntries.length === 0) {
    throw new PackError('Pack-Temp ist leer - nichts zu ersetzen.');
  }

  // 2) Geschuetzte Pfade aus dem Pack-Temp werfen. Das rm laeuft ueber den
  //    Helfer: sourceDir ist das Temp, das dem INSTANZ-User gehoert - 'armory'
  //    kann darin nichts loeschen (EPERM). Alle in einem Aufruf gebuendelt.
  const protPresent = [];
  for (const name of sourceEntries) {
    if (isProtectedPath(name)) protPresent.push(join(sourceDir, name));
  }

  // 2b) Audit-Fix 2026-10-30 (C113): Der Schutz gilt fuer den ZIELORDNER, nicht
  //     nur fuer das Pack-Temp. Vorher wurde isProtectedPath ausschliesslich
  //     gegen sourceEntries (Pack-Inhalt) geprueft - ein Pack, das eine Welt
  //     unter anderem Namen mitbringt oder dessen Eintraege mit einer der
  //     geschuetzten Dateien kollidieren, konnte den Ziel-Zustand ersetzen,
  //     ohne dass irgendwo geprueft wurde, was im Ziel liegt.
  //     Jetzt: liegt im Ziel ein geschuetzter Name, und will das Pack ihn
  //     ersetzen, wird der Eintrag uebersprungen und im Report gefuehrt.
  let targetEntries = [];
  try {
    targetEntries = await readdir(targetDir);
  } catch (err) {
    // Erstinstallation: Zielordner existiert noch nicht -> nichts zu schuetzen.
    if (err.code !== 'ENOENT') {
      throw new PackError(`Zielordner nicht lesbar (${targetDir}): ${err.message}`);
    }
  }
  const protectedInTarget = new Set(targetEntries.filter((n) => isProtectedPath(n)));
  if (protectedInTarget.size > 0) {
    log(`[pack] Im Ziel geschuetzt: ${[...protectedInTarget].join(', ')}`);
  }
  if (protPresent.length > 0) {
    const res = await runHelper('cleanup-path', protPresent, { log });
    if (!res.ok) throw new PackError(`Geschuetzte Pfade entfernen fehlgeschlagen: ${res.stderr || res.error}`);
    for (const name of sourceEntries) {
      if (isProtectedPath(name)) {
        report.skipped.push(name);
        log(`[pack] Geschuetzt, aus Pack entfernt: ${name}`);
      }
    }
  }

  // 3) Jeden verbleibenden Top-Level-Eintrag ersetzen. Reihenfolge: Dateien
  //    zuletzt? Nein - der Helfer arbeitet pro Eintrag (Rename-trash -> cp ->
  //    Rollback) und kann auch mit Ordnern/Dateien gemischt umgehen.
  let replaced = 0;
  for (const name of sourceEntries) {
    if (isProtectedPath(name)) continue;
    if (protectedInTarget.has(name)) {
      // Liegt im Ziel (z.B. world) und das Pack will es ersetzen -> ablehnen.
      report.removed.push(name);
      log(`[pack] Nicht ersetzt (im Ziel geschuetzt): ${name}`);
      continue;
    }
    if (keepConfigs && CONFIG_LIKE.has(name)) {
      report.skipped.push(name);
      log(`[pack] Uebersprungen (Configs behalten): ${name}`);
      continue;
    }
    const src = join(sourceDir, name);
    const res = await runHelper('replace-pack', [id, targetDir, name, src], { log });
    if (!res.ok) {
      throw new PackError(`Ersetzen fehlgeschlagen fuer ${name}: ${res.stderr || res.error}`);
    }
    report.replaced.push(name);
    replaced += 1;
    log(`[pack] Ersetzt: ${name}`);
  }

  // Stiller Fehler ausschliessen: ein Pack mit keinem einzigen Treffer hat
  // nichts bewirkt - das darf nicht als Erfolg durchgehen.
  if (replaced === 0) {
    const teile = [];
    if (report.removed.length > 0) teile.push(`${report.removed.length} im Ziel geschuetzt`);
    if (report.skipped.length > 0) teile.push(`${report.skipped.length} Configs behalten`);
    throw new PackError(
      'Kein Pack-Inhalt ersetzt: nichts uebrig'
      + (teile.length ? ` (${teile.join(', ')})` : '') + '.',
    );
  }
  log(`[pack] Fertig: ${replaced} Eintraege ersetzt, ${report.skipped.length} geschuetzt/behalten.`);
  return report;
}

export async function fileSha256(path) {
  const { createReadStream } = await import('node:fs');
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const s = createReadStream(path);
    s.on('data', (d) => hash.update(d));
    s.on('end', () => resolvePromise(hash.digest('hex')));
    s.on('error', reject);
  });
}

// Was ein gueltiges Archiv fuer DIESES Rack enthaelt, steht im Rack selbst
// (packMarkers). Die Inhalts-Pruefung ist spielabhaengig - ein Modpack hat
// mods/ und startserver.sh, ein TeamSpeak-Release hat tsserver und
// tsserver.yaml. Die Sicherheitspruefung (Pfad-Ausbrueche, Links) bleibt
// davon unberuehrt und gilt fuer alle gleich.
const DEFAULT_PACK_MARKERS = ['mods', 'libraries', 'startserver.sh'];

export function packMarkersFor(rack) {
  const m = rack?.packMarkers;
  if (Array.isArray(m) && m.length > 0) return m;
  return DEFAULT_PACK_MARKERS;
}

// Formatneutral: erkennt ZIP und Tarball am Inhalt, prueft Pfade/Links und
// meldet, welcher Marker des Racks tatsaechlich gefunden wurde.
export async function validatePackArchive(archivePath, rack = null) {
  const kind = await detectArchiveKind(archivePath);
  const entries = await assertSafeArchive(archivePath);
  const markers = packMarkersFor(rack);

  // Marker duerfen auf Top-Level liegen ODER in einem Wurzel-Unterordner
  // (Modpack-ZIPs haben oft 'ServerFiles-x.y/mods/...').
  const found = markers.filter((m) => entries.some((e) => {
    const n = String(e).replace(/^\.\//, '');
    return n === m || n.startsWith(`${m}/`) || n.includes(`/${m}/`);
  }));

  // Startscript-Sonderfall: je nach Pack heisst es anders. Wenn das Rack keinen
  // eigenen Marker dafuer hat, zaehlt jedes gaengige Startskript als Treffer.
  // BUGFIX 2026-10-18 (Testfall mc-test.zip gegen teamspeak6): ein pauschales
  // hasStartScript machte JEDES Archiv gueltig, sobald eine startserver.sh
  // darin lag - auch fuer TeamSpeak. Damit war die spielabhaengige Pruefung
  // wieder aufgeweicht. Es zaehlen ausschliesslich die Marker des Racks;
  // atm10/atm11 haben startserver.sh ohnehin in ihrer Liste.
  const hasStartScript = entries.some((e) => /(^|\/)startserver\.(sh|bat)$/.test(String(e)));
  const ok = found.length > 0;

  return {
    ok,
    kind,
    found,
    expected: markers,
    hasStartScript,
    entryCount: entries.length,
    rackId: rack?.id ?? null,
  };
}

// Rueckwaerts-kompatibler Name fuer Aufrufer, die noch keine Rack-Info haben.
// Ohne Rack gilt der Minecraft-Standardsatz - nichts rutscht still durch.
export async function validatePackZip(zipPath, rack = null) {
  const r = await validatePackArchive(zipPath, rack);
  return {
    ok: r.ok,
    hasMods: r.found.includes('mods'),
    hasLibraries: r.found.includes('libraries'),
    hasStart: r.hasStartScript,
    entryCount: r.entryCount,
    found: r.found,
    expected: r.expected,
    rackId: r.rackId,
  };
}

export async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}
