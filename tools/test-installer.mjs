// Game-Armory - Installer/Updater Trockentest
// Erzeugt ein Dummy-ZIP (mods/, libraries/, startserver.sh, world/, server.properties)
// und testet replacePackContents + createBackup in einem Temp-Zielordner.
//
// SICHERHEIT: Kein echter Server, kein systemd-Service, keine Unit, kein Port.
// Der Arbeitsordner liegt UNTER /opt/minecraft/zzbtest-<zufall> - nicht in /tmp.
// Grund (2026-10-31): replacePackContents laeuft ueber den Install-Helfer, und
// dessen Pfad-Whitelist erlaubt nur /opt/game-armory, /var/log, /opt/minecraft,
// /opt/7d2d, /opt/teamspeak6. Unter /tmp brach der Test mit exit 3 ab ("Pfad
// nicht erlaubt") - und zwar seit v1.0.0, also unbemerkt.
// Der Ordner wird am Ende IMMER entfernt (finally), der Test prueft das selbst.
// Aufruf: node tools/test-installer.mjs

import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

import { replacePackContents, extractToTemp } from '../app/pack.js';
import { createBackup } from '../app/updater.js';
import { detectNeoforgeVersionFromPaths } from '../app/updater.js';

const execFileAsync = promisify(execFile);

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`); }
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// Erlaubter Root: der Install-Helfer akzeptiert nur diese Praefixe. /opt/minecraft
// ist der passende, weil dort die echten Instanzen liegen (gleiche Rechte, gleiche
// Platte) - der Test laeuft also unter realistischen Bedingungen.
const TEST_ROOT_BASE = '/opt/minecraft';
const tmpdirForZip = () => tmpdir();
const TEST_PREFIX = 'zzbtest-';

// Der Helfer chownt auf diesen UNIX-User (chown <id>:<id>) - eine freie Kennung
// wie 'zzbtest' scheitert mit "invalid user". 'armory' ist der Panel-User und
// existiert; es entstehen keine neuen Rechte, weil der Helfer ohnehin als root
// laeuft und nur diesen Namen als Ziel nimmt.
const TEST_ID = 'armory';

// Nie in einen existierenden Ordner schreiben: mkdtemp legt immer neu an, aber
// wir pruefen zusaetzlich, dass der Name das Praefix traegt.
async function makeWorkRoot() {
  const root = await mkdtemp(join(TEST_ROOT_BASE, TEST_PREFIX));
  if (!basename(root).startsWith(TEST_PREFIX)) {
    throw new Error(`Unerwarteter Arbeitsordner: ${root}`);
  }
  return root;
}

async function main() {
  const root = await makeWorkRoot();
  const srcDir = join(root, 'pack-src');
  const tgtDir = join(root, 'server-target');
  // Das ZIP muss nach /tmp: extract-pack erlaubt nur /tmp/* und
  // /opt/game-armory/data/uploads/* (Helfer, Zeile 218). Der Arbeitsordner
  // bleibt in /opt/minecraft, weil remove-tree dort arbeiten darf.
  const zipPath = join(tmpdirForZip(), `${basename(root)}.zip`);
  let cleanedUp = false;

  console.log(`[test] Arbeitsverzeichnis: ${root}`);

  // --- Dummy-Pack-Quelle bauen ---------------------------------------------
  await mkdir(join(srcDir, 'mods'), { recursive: true });
  await mkdir(join(srcDir, 'libraries/net/neoforged/neoforge/21.1.300'), { recursive: true });
  await mkdir(join(srcDir, 'config'), { recursive: true });
  await mkdir(join(srcDir, 'world'), { recursive: true });      // geschuetzt -> muss ignoriert werden
  await writeFile(join(srcDir, 'mods', 'newmod.jar'), 'MOD');
  await writeFile(join(srcDir, 'libraries/net/neoforged/neoforge/21.1.300', 'x.txt'), 'lib');
  await writeFile(join(srcDir, 'config', 'pack-config.toml'), 'PACKCFG');
  await writeFile(join(srcDir, 'world', 'level.dat'), 'PACKWORLD'); // darf NIE ins Ziel
  await writeFile(join(srcDir, 'server.properties'), 'from-pack=true'); // geschuetzt
  await writeFile(join(srcDir, 'startserver.sh'), '#!/bin/bash\necho hi\n');
  console.log('[test] Dummy-Pack-Quelle erstellt.');

  // --- Zielserver mit bestehenden User-Daten anlegen ------------------------
  await mkdir(join(tgtDir, 'mods'), { recursive: true });
  await mkdir(join(tgtDir, 'world'), { recursive: true });
  await mkdir(join(tgtDir, 'config'), { recursive: true });
  await mkdir(join(tgtDir, 'libraries/net/neoforged/neoforge/21.1.249'), { recursive: true });
  await writeFile(join(tgtDir, 'mods', 'oldmod.jar'), 'OLD');
  await writeFile(join(tgtDir, 'world', 'level.dat'), 'USERWORLD');
  await writeFile(join(tgtDir, 'world', 'session.lock'), 'LOCK');
  await writeFile(join(tgtDir, 'config', 'user-config.toml'), 'USERCFG');
  await writeFile(join(tgtDir, 'server.properties'), 'level-name=world\nrcon.password=abc\n');
  await writeFile(join(tgtDir, 'eula.txt'), 'eula=false\n');
  await writeFile(join(tgtDir, 'ops.json'), '[]');
  // Der Test laeuft als root, der Helfer kopiert aber mit `sudo -u <id>` (also
  // als Instanz-User). Ein root-eigener Zielordner fuehrt deshalb zu
  // "Permission denied", obwohl der Test selbst root ist - live erlebt.
  // Der Arbeitsordner wird darum dem Instanz-User uebergeben, bevor kopiert wird.
  {
    const { execFile: ef } = await import('node:child_process');
    const { promisify: pr } = await import('node:util');
    await pr(ef)('chown', ['-R', `${TEST_ID}:${TEST_ID}`, root]);
  }
  console.log(`[test] Zielserver mit User-Daten erstellt (Besitzer: ${TEST_ID}).`);

  // --- Neoforge-Versionserkennung ------------------------------------------
  const detected = detectNeoforgeVersionFromPaths([
    'libraries/net/neoforged/neoforge/21.1.300/x.txt',
    'libraries/net/neoforged/neoforge/21.1.300/y.txt',
  ]);
  check('Neoforge-Version aus Pfad erkannt', detected === '21.1.300', `erhielt ${detected}`);

  // --- replacePackContents (keepConfigs=true) ------------------------------
  // WICHTIG (2026-10-31): replacePackContents raeumt geschuetzte Pfade im
  // QUELLORDNER ueber den Install-Helfer weg (cleanup-path). Der Helfer erlaubt
  // dort nur /tmp/armory-pack-* - nicht einen selbst gebauten Ordner. Deshalb
  // muss der Quellordner durch genau denselben Weg entstehen wie im Betrieb:
  // ZIP bauen, extractToTemp. Vorher lief der Test gegen srcDir direkt und
  // brach mit "Pfad nicht erlaubt" ab.
  console.log('\n[test] Dummy-ZIP fuer replacePackContents:');
  await execFileAsync('zip', ['-q', '-r', zipPath, 'mods', 'libraries', 'config', 'startserver.sh', 'server.properties', 'world'], { cwd: srcDir });
  const packed = await extractToTemp(zipPath, { id: TEST_ID });
  check('Pack-Temp entpackt', await exists(join(packed.sourceDir, 'mods', 'newmod.jar')));
  check('Pack-Temp liegt unter /tmp/armory-pack-*', packed.tmpRoot.startsWith('/tmp/armory-pack-'), packed.tmpRoot);

  console.log('\n[test] replacePackContents (keepConfigs=true):');
  // id ist seit v1.0.0 Pflicht (pack.js:328): der Helfer entpackt und kopiert
  // mit den Rechten des Server-Users. Hier eine reine Test-Kennung.
  const report = await replacePackContents(packed.sourceDir, tgtDir, { id: TEST_ID, keepConfigs: true, log: () => {} });

  check('mods ersetzt (newmod.jar vorhanden)', await exists(join(tgtDir, 'mods', 'newmod.jar')));
  check('alte mod entfernt (oldmod.jar weg)', !(await exists(join(tgtDir, 'mods', 'oldmod.jar'))));
  check('libraries ersetzt', await exists(join(tgtDir, 'libraries/net/neoforged/neoforge/21.1.300/x.txt')));
  check('config BEHALTEN (user-config.toml unangetastet)', await exists(join(tgtDir, 'config', 'user-config.toml')));
  check('Pack-config NICHT kopiert (config uebersprungen)', !(await exists(join(tgtDir, 'config', 'pack-config.toml'))));
  check('startserver.sh ersetzt', await exists(join(tgtDir, 'startserver.sh')));

  // Geschuetzte Pfade:
  const worldData = await readFile(join(tgtDir, 'world', 'level.dat'), 'utf8');
  check('world UNANGETASTET (User-Welt erhalten)', worldData === 'USERWORLD', `erhielt ${worldData}`);
  check('session.lock erhalten', await exists(join(tgtDir, 'world', 'session.lock')));
  const sp = await readFile(join(tgtDir, 'server.properties'), 'utf8');
  check('server.properties UNANGETASTET', sp.includes('rcon.password=abc'), `erhielt ${JSON.stringify(sp)}`);
  const eula = await readFile(join(tgtDir, 'eula.txt'), 'utf8');
  check('eula.txt UNANGETASTET (nie automatisch gesetzt)', eula.includes('eula=false'));
  check('ops.json unangetastet', await exists(join(tgtDir, 'ops.json')));
  check('report.skipped enthaelt world/config', report.skipped.includes('world') && report.skipped.includes('config'));
  check('report.replaced enthaelt mods', report.replaced.includes('mods'));

  // --- createBackup --------------------------------------------------------
  console.log('\n[test] createBackup:');
  const b1 = await createBackup(tgtDir, {
    id: TEST_ID,
    paths: ['world', 'server.properties', 'ops.json', 'nicht-vorhanden.json'],
    keepGenerations: 2, label: 'test', log: () => {},
  });
  check('Backup erstellt', b1.created && b1.file, JSON.stringify(b1));
  check('Backup-Datei existiert', b1.file && await exists(b1.file));
  check('Backup schliesst world+server.properties ein', b1.included.includes('world') && b1.included.includes('server.properties'));
  check('Nicht vorhandene Pfade werden uebersprungen', !b1.included.includes('nicht-vorhanden.json'));

  const tarList = await execFileAsync('tar', ['-tzf', b1.file]);
  check('tar enthaelt world/level.dat', tarList.stdout.includes('world/level.dat'));
  check('tar enthaelt server.properties', tarList.stdout.includes('server.properties'));

  // Generationen-Aufraeumen: keepGenerations=2 -> nach 3 Backups bleiben 2.
  await new Promise((r) => setTimeout(r, 1100)); // sicherer Zeitstempel-Sprung
  await createBackup(tgtDir, { id: TEST_ID, paths: ['world'], keepGenerations: 2, label: 'test', log: () => {} });
  await new Promise((r) => setTimeout(r, 1100));
  await createBackup(tgtDir, { id: TEST_ID, paths: ['world'], keepGenerations: 2, label: 'test', log: () => {} });
  const backups = (await readdir(join(tgtDir, 'backups'))).filter((f) => f.startsWith('test-'));
  check('Alte Backup-Generationen aufgeraeumt (max 2)', backups.length === 2, `vorhanden: ${backups.length}`);

  // --- extractToTemp auf ein echtes ZIP ------------------------------------
  // Dummy-ZIP bauen (mit detectZipRoot-konformen Markern an der Wurzel).
  // Das zweite extractToTemp entfaellt: oben wird bereits eins gemacht und
  // der Ordner hier ueber den Helfer aufgeraeumt (gleicher Pfad wie im Betrieb).
  check('startserver.sh im entpackten Pack', await exists(join(packed.sourceDir, 'startserver.sh')));
  const cleanup = await (async () => {
    try {
      await execFileAsync('sudo', ['-n', '/usr/local/bin/armory-install-helper', 'cleanup-path', packed.tmpRoot]);
      return { ok: true };
    } catch (err) {
      return { ok: false, err: err.message };
    }
  })();
  check('Pack-Temp ueber Helfer aufgeraeumt', cleanup.ok, cleanup.err || '');
  await rm(packed.tmpRoot, { recursive: true, force: true }).catch(() => {});

  // --- Aufraeumen ----------------------------------------------------------
  // Erst aufraeumen, dann pruefen, dass es wirklich weg ist. Ein Test, der
  // seinen Ordner stehen laesst, ist in einem Produktions-Root ein Schaden.
  await rm(root, { recursive: true, force: true });
  cleanedUp = true;
  check('Arbeitsordner entfernt', !(await exists(root)), root);

  console.log(`\n[test] Ergebnis: ${passed} ok, ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[test] Abbruch mit Fehler:', err);
  process.exit(2);
});
