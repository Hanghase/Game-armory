#!/usr/bin/env node
// Prueft nach einem Fernupdate, ob das Arsenal wirklich hochgekommen ist -
// und rollt sonst zurueck.
//
// Dieser Prozess laeuft BEWUSST getrennt vom Dienst (via systemd-run). Er
// ueberlebt den Neustart, den er pruefen soll. Liefe er im Dienst, wuerde der
// Neustart genau den Code beenden, der ihn pruefen soll - und niemand merkt,
// dass das Update gescheitert ist.
//
// ER ENTSCHEIDET OHNE NETZ. Die Armory kommt hier nicht vor. Das ist die
// Regel aus dem Konzept: ein Rollback, der auf ein Lebenszeichen aus dem
// Panel wartet, ist bei einem Netzproblem tot - und dann steht die Maschine.
//
// Aufruf: node updateCheck.js <erwartete-version> <alter-tag>

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entscheideNachNeustart } from './update.js';

const run = promisify(execFile);
const ARSENAL_DIR = process.env.ARSENAL_DIR || '/opt/armory-arsenal';
const SERVICE = 'armory-arsenal';

const erwartet = process.argv[2] ?? null;
const alterTag = process.argv[3] ?? null;

const schlafe = (ms) => new Promise((r) => setTimeout(r, ms));

async function dienstAktiv() {
  try {
    await run('systemctl', ['is-active', '--quiet', SERVICE], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

async function gemeldeteVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(ARSENAL_DIR, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

async function melde(ergebnis) {
  // Ergebnis neben dem Arsenal ablegen. Das Panel liest es beim naechsten
  // Lebenszeichen; ohne Netz bleibt es einfach liegen - kein Verlust.
  try {
    const pfad = join(ARSENAL_DIR, '.update-result.json');
    await writeFile(pfad, JSON.stringify({ ...ergebnis, zeit: new Date().toISOString() }, null, 2));
  } catch {
    // Kein Schreibrecht? Dann bleibt das Log.
  }
  process.stdout.write(`[update-check] ${JSON.stringify(ergebnis)}\n`);
}

async function zurueckrollen(grund) {
  if (!alterTag) {
    await melde({ zustand: 'rollback-nicht-moeglich', grund, erwartet });
    // Ohne Ziel-Tag kann nicht zurueckgegangen werden. Das ist ehrlicher als
    // einen Wechsel vorzutaeuschen, der ins Leere greift.
    return;
  }
  try {
    await run('git', ['-C', ARSENAL_DIR, 'checkout', alterTag], { timeout: 60000 });
    await run('systemctl', ['restart', SERVICE], { timeout: 30000 }).catch(() => {});
    await melde({ zustand: 'zurueckgerollt', grund, auf: alterTag, erwartet });
  } catch (err) {
    await melde({ zustand: 'rollback-fehlgeschlagen', grund, fehler: String(err.message ?? err) });
  }
}

async function main() {
  // Dem Dienst Zeit geben hochzukommen. Ein Dienst, der nach 5 Sekunden noch
  // nicht laeuft, kommt auch nach 60 nicht.
  let aktiv = false;
  for (let i = 0; i < 12; i += 1) {
    await schlafe(5000);
    // eslint-disable-next-line no-await-in-loop
    aktiv = await dienstAktiv();
    if (aktiv) break;
  }

  // eslint-disable-next-line no-await-in-loop
  const version = await gemeldeteVersion();
  const entscheidung = entscheideNachNeustart({
    dienstAktiv: aktiv,
    versionGemeldet: version,
    erwartet,
  });

  if (!entscheidung.zurueck) {
    await melde({ zustand: 'ok', version, erwartet });
    return;
  }

  await zurueckrollen(entscheidung.grund);
}

main().catch(async (err) => {
  await melde({ zustand: 'pruefung-abgebrochen', fehler: String(err.message ?? err) });
  process.exit(1);
});
