// Game-Armory - Neustart-Merker
// Merkt sich, dass die Config eines Swords gespeichert wurde, die Werte aber
// erst nach einem Neustart greifen (kein Spiel liest seine Config im Betrieb neu).
//
// WICHTIG - bewusst NICHT in swords/<id>.sword.json:
//   * Die Sword-Datei beschreibt, was eine Instanz IST (Port, Service, User,
//     Pfade, Update-Verhalten) - gepflegt von Hand bzw. beim Install.
//   * Der Merker ist LAUFZEITZUSTAND (was gerade anliegt) und vergaenglich.
//   * Installer/Updater bauen die Sword-Datei bei jedem Lauf komplett neu -
//     ein Merker dort waere nach jedem Update weg. Genau das darf nicht passieren.
//
// Ablage: data/pending-restart.json (klein, eine Wahrheit fuer das Panel).
// Schreiben ist atomar (temp + rename), damit ein Abbruch die Datei nicht zerlegt.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const STATE_PATH = '/opt/game-armory/data/pending-restart.json';

let cache = null;

async function readState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    const data = JSON.parse(raw);
    return (data && typeof data === 'object') ? data : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    // Kaputte/teilweise Datei: nicht die ganze Anzeige blockieren - leer starten.
    // Der naechste Schreibvorgang repariert sie ohnehin.
    console.error(`[pendingRestart] Zustandsdatei unlesbar (${STATE_PATH}): ${err.message}`);
    return {};
  }
}

async function writeState(state) {
  cache = state;
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
  await rename(tmp, STATE_PATH);   // atomar: nie eine halbe Datei sichtbar
}

export async function loadPendingRestarts() {
  cache = await readState();
  return cache;
}

export function getPendingRestart(id) {
  if (cache === null) return null;
  return cache[id] ?? null;
}

// Setzt den Merker. by = wer die Config gespeichert hat (fuer die Anzeige).
export async function setPendingRestart(id, by = null) {
  const state = cache ?? await readState();
  state[id] = { since: Date.now(), by };
  await writeState(state);
  return state[id];
}

// Loescht den Merker. Gibt true zurueck, wenn wirklich etwas entfernt wurde.
export async function clearPendingRestart(id) {
  const state = cache ?? await readState();
  if (!(id in state)) return false;
  delete state[id];
  await writeState(state);
  return true;
}
