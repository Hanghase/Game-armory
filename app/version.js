// Game-Armory - Versionsermittlung
// Liest die laufende Version aus Git statt sie irgendwo zu hardcodieren.
// So zeigt die UI immer den echten Stand - inkl. "dirty", wenn seit dem
// letzten Tag ungespeicherte Aenderungen laufen.
//
// Warum 'git -c safe.directory=...' statt --global:
//   Das Panel laeuft als User 'armory', das Repo gehoert 'root'. Git verweigert
//   fremde Repos ("dubious ownership"). Statt die Ausnahme systemweit in
//   /etc/gitconfig zu setzen, steht sie hier GENAU dort, wo sie gebraucht wird -
//   nur fuer diesen einen Aufruf, nur fuer dieses eine Repo.
//
// Ergebnis wird kurz gecacht: git wird nicht bei jedem UI-Abruf gestartet.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

const REPO_DIR = '/opt/game-armory';
const PACKAGE_JSON = '/opt/game-armory/package.json';
const CACHE_MS = 30_000;   // 30 s: kurz genug fuer frische Tags, selten genug fuer Last

let cached = null;   // { data, at }

// git describe --tags --dirty liefert z.B.:
//   v0.4.0                (exakt auf dem Tag)
//   v0.4.0-3-g1a2b3c4     (3 Commits nach dem Tag)
//   v0.4.0-dirty          (ungespeicherte Aenderungen)
//   v0.4.0-3-g1a2b3c4-dirty
async function git(args) {
  const { stdout } = await execFileAsync('git', [
    '-c', `safe.directory=${REPO_DIR}`,
    '-C', REPO_DIR,
    ...args,
  ], { timeout: 5000 });
  return stdout.trim();
}

async function readPackageVersion() {
  try {
    const pkg = JSON.parse(await readFile(PACKAGE_JSON, 'utf8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

// Liefert { tag, commit, dirty, source }. Faellt nie hart aus: wenn git nicht
// verfuegbar ist (z.B. Kunde ohne git), kommt die package.json-Version zurueck.
export async function getVersion() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;

  let data;
  try {
    const describe = await git(['describe', '--tags', '--dirty', '--always']);
    let commit = null;
    try {
      commit = await git(['rev-parse', '--short', 'HEAD']);
    } catch { /* commit ist optional */ }

    const dirty = describe.endsWith('-dirty');
    const tag = dirty ? describe.slice(0, -'-dirty'.length) : describe;
    data = { tag, commit, dirty, source: 'git' };
  } catch (err) {
    // Kein git / kein Repo / Rechte: package.json als Notnagel.
    data = { tag: await readPackageVersion(), commit: null, dirty: null, source: 'package' };
    console.error(`[version] git nicht nutzbar, nutze package.json: ${err.message}`);
  }

  cached = { data, at: Date.now() };
  return data;
}

// Fuer Tests / nach einem Tag-Wechsel: Cache verwerfen.
export function clearVersionCache() {
  cached = null;
}
