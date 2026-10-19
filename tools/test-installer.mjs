// Game-Armory - Installer/Updater Trockentest
// Erzeugt ein Dummy-ZIP (mods/, libraries/, startserver.sh, world/, server.properties)
// und testet replacePackContents + createBackup in einem Temp-Zielordner.
//
// SICHERHEIT: Kein echter Server, kein systemd-Service. Alles unter /tmp.
// Aufruf: node tools/test-installer.mjs

import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'armory-test-'));
  const srcDir = join(root, 'pack-src');
  const tgtDir = join(root, 'server-target');
  const zipPath = join(root, 'dummy-pack.zip');

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
  console.log('[test] Zielserver mit User-Daten erstellt.');

  // --- Neoforge-Versionserkennung ------------------------------------------
  const detected = detectNeoforgeVersionFromPaths([
    'libraries/net/neoforged/neoforge/21.1.300/x.txt',
    'libraries/net/neoforged/neoforge/21.1.300/y.txt',
  ]);
  check('Neoforge-Version aus Pfad erkannt', detected === '21.1.300', `erhielt ${detected}`);

  // --- replacePackContents (keepConfigs=true) ------------------------------
  console.log('\n[test] replacePackContents (keepConfigs=true):');
  const report = await replacePackContents(srcDir, tgtDir, { keepConfigs: true, log: () => {} });

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
  await createBackup(tgtDir, { paths: ['world'], keepGenerations: 2, label: 'test', log: () => {} });
  await new Promise((r) => setTimeout(r, 1100));
  await createBackup(tgtDir, { paths: ['world'], keepGenerations: 2, label: 'test', log: () => {} });
  const backups = (await readdir(join(tgtDir, 'backups'))).filter((f) => f.startsWith('test-'));
  check('Alte Backup-Generationen aufgeraeumt (max 2)', backups.length === 2, `vorhanden: ${backups.length}`);

  // --- extractToTemp auf ein echtes ZIP ------------------------------------
  // Dummy-ZIP bauen (mit detectZipRoot-konformen Markern an der Wurzel).
  console.log('\n[test] extractToTemp (ZIP an Wurzel):');
  await execFileAsync('zip', ['-q', '-r', zipPath, 'mods', 'libraries', 'config', 'startserver.sh'], { cwd: srcDir });
  const { tmpRoot, sourceDir } = await extractToTemp(zipPath);
  check('ZIP entpackt', await exists(join(sourceDir, 'mods', 'newmod.jar')));
  check('startserver.sh im entpackten Pack', await exists(join(sourceDir, 'startserver.sh')));
  await rm(tmpRoot, { recursive: true, force: true });

  // --- Aufraeumen ----------------------------------------------------------
  await rm(root, { recursive: true, force: true });

  console.log(`\n[test] Ergebnis: ${passed} ok, ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[test] Abbruch mit Fehler:', err);
  process.exit(2);
});
