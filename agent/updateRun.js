// Fernupdate ausfuehren - der Teil mit Prozessen.
//
// Getrennt von agent/update.js, weil hier git, tar und systemctl laufen und
// drueben nur Entscheidungen stehen. Das ist nicht Ordnungsliebe: die
// Entscheidungen muessen ohne Prozesse testbar sein, sonst prueft man sie nie.
//
// DER ABLAUF IST SO GEBAUT, DASS ER DIE ARMORY NICHT BRAUCHT:
//
//   1. Version holen (die Armory nennt sie im Befehl - oder der Agent fragt)
//   2. sichern (tar, lokal)
//   3. wechseln (git checkout <tag>)
//   4. neu starten
//   5. NACH DEM NEUSTART SELBST PRUEFEN - ohne Netz
//   6. bei Misserfolg SELBST zurueckrollen
//
// Schritt 5 und 6 laufen in einem eigenen kurzen Prozess, der vom Dienst-
// Neustart nicht mitgerissen wird. Waeren sie im Dienst, wuerde der Neustart
// genau den Code beenden, der ihn pruefen soll.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { entscheideNachNeustart, planeUpdate } from './update.js';

const run = promisify(execFile);

// Wo das Arsenal liegt und was es ist. Installationspfad aus dem Konzept.
export const ARSENAL_DIR = process.env.ARSENAL_DIR || '/opt/armory-arsenal';
export const SERVICE = 'armory-arsenal';
const BACKUP_DIR = join(ARSENAL_DIR, 'backup');

async function git(args, opts = {}) {
  const { stdout } = await run('git', ['-C', ARSENAL_DIR, ...args], {
    timeout: 30000,
    ...opts,
  });
  return stdout.trim();
}

// Welche Tags gibt es? Neueste zuerst, damit "aktuellste Version" nicht
// alphabetisch sortiert wird.
export async function verfuegbareVersion() {
  const out = await git(['tag', '--list', 'v*', '--sort=-v:refname']);
  const erster = out.split('\n').filter(Boolean)[0];
  return erster ? erster.replace(/^v/, '') : null;
}

export async function aktuelleVersion() {
  try {
    const out = await git(['describe', '--tags', '--abbrev=0']);
    return out.replace(/^v/, '') || null;
  } catch {
    return null;
  }
}

// Sichert den laufenden Stand als tar. Ohne diese Sicherung gibt es kein
// Zurueck - und ein Fernupdate ohne Zurueck ist ein Risiko ohne Deckung.
async function sichern(ziel) {
  await mkdir(BACKUP_DIR, { recursive: true });
  const datei = join(ARSENAL_DIR, ziel);
  await run('tar', [
    'czf', datei,
    '--exclude=backup',
    '--exclude=node_modules',
    '--exclude=.git',
    '-C', ARSENAL_DIR, '.',
  ], { timeout: 120000 });
  return datei;
}

// Kurzer Prozess, der NACH dem Neustart entscheidet. Bewusst mit
// systemd-run in einer eigenen Unit: stirbt der Dienst beim Neustart, laeuft
// diese Pruefung weiter und holt ihn zurueck.
async function pruefungStarten({ erwartet, alterTag }) {
  const skript = join(ARSENAL_DIR, 'agent/updateCheck.js');
  const einheit = `arsenal-check-${Date.now()}`;
  await run('systemd-run', [
    '--unit', einheit, '--collect', '--quiet',
    '--description', 'Arsenal: Update pruefen',
    '/usr/bin/node', skript, erwartet, alterTag,
  ], { timeout: 15000 });
  return einheit;
}

// Der eigentliche Ablauf. Gibt ein Ergebnis zurueck, das der Agent als
// Antwort schickt - der Aufruf wartet NICHT auf den Neustart, sonst waere die
// Antwort immer "Verbindung weg".
export async function starteUpdate({ meldung = () => {} } = {}) {
  const aktuell = await aktuelleVersion();
  const verfuegbar = await verfuegbareVersion();
  const plan = planeUpdate({ aktuell, verfuegbar });

  if (!plan.noetig) {
    return { ok: true, gestartet: false, grund: plan.grund, aktuell, verfuegbar };
  }

  meldung(`Update ${plan.von} -> ${plan.auf}: sichere`);
  const sicherung = await sichern(plan.sicherung);

  // Der alte Tag muss VOR dem Wechsel festgehalten werden. Danach steht er
  // nicht mehr da, und der Rollback haette kein Ziel.
  const alterTag = await git(['describe', '--tags', '--abbrev=0']).catch(() => null);

  meldung(`Update: wechsle auf v${plan.auf}`);
  await git(['fetch', '--tags', '--force'], { timeout: 60000 }).catch(() => {});
  await git(['checkout', `v${plan.auf}`], { timeout: 60000 });

  // Erst die Pruefung anmelden, DANN neu starten. Andersherum wuerde der
  // Neustart die Pruefung mitreissen.
  const einheit = await pruefungStarten({ erwartet: plan.auf, alterTag });

  meldung(`Update: starte ${SERVICE} neu, Pruefung laeuft als ${einheit}`);
  await run('systemctl', ['restart', '--no-block', SERVICE], { timeout: 15000 })
    .catch(() => {});

  return {
    ok: true,
    gestartet: true,
    von: plan.von,
    auf: plan.auf,
    sicherung,
    alterTag,
    pruefung: einheit,
  };
}

export { entscheideNachNeustart };
