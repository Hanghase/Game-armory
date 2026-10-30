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
//
// Audit 2026-10-30 (Befunde aus /tmp/armory-audit, app/pendingRestart.js):
//   06 HOCH  Parallele Read-modify-write-Zyklen ueberschreiben sich  -> Schreib-Queue
//   01 MITTEL Inhalt wird ohne Schemapruefung uebernommen            -> Eintraege filtern
//   04 MITTEL Race Condition bei gleichzeitigem Schreiben            -> Schreib-Queue
//   07 MITTEL Cache wird vor erfolgreicher Persistenz gesetzt        -> erst nach rename
//   08 MITTEL Lesefehler werden als leerer Zustand behandelt         -> Fehler werfen
//   10 MITTEL Geerbte Object.prototype-Eigenschaften als Merker      -> Object.create(null)
//   05 NIEDRIG .tmp-Reste nach Absturz bleiben liegen                -> Startbereinigung
//   09 NIEDRIG Getter vor Initialisierung meldet "kein Merker"       -> synchron nachladen
//   11 NIEDRIG .tmp-Reste bei Schreibfehlern                         -> try/catch + rm
//   12 HINWEIS Unbenutzter join-Import                               -> entfernt
//   02 NIEDRIG Fehlerbehandlung verschluckt kritische Fehler         -> siehe readState
//   03 HINWEIS id als Objektschluessel ohne Zeichenpruefung          -> isValidId
//
// Bewusste Entscheidung zu 03: Die id kommt aus der Route und wird vorher in
// installRoutes.js gegen die vorhandenen Swords geprueft. Trotzdem wird sie hier
// zusaetzlich auf ein enges Zeichenset begrenzt - eine Pruefung mehr kostet nichts.

import { readFile, writeFile, rename, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const STATE_PATH = '/opt/game-armory/data/pending-restart.json';
const STATE_DIR = dirname(STATE_PATH);
const TMP_PREFIX = `${STATE_PATH}.tmp-`;

// Zustand: nur eigene Schluessel, damit 'toString' oder '__proto__' nie als
// vorhandener Merker gelten (Befund 10).
let cache = null;

// Alle Schreibvorgaenge laufen nacheinander. Ohne das lesen zwei parallele
// Aufrufe denselben alten Stand und der letzte rename gewinnt (Befunde 04/06).
let writeChain = Promise.resolve();

function emptyState() {
  return Object.create(null);
}

// Die id landet als Schluessel in JSON. Nur Zeichen, die in einer Sword-ID
// vorkommen koennen - alles andere wird abgewiesen statt still veraendert.
function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[A-Za-z0-9._-]+$/.test(id);
}

// Ein Eintrag aus der Datei ist nur gueltig, wenn er die erwartete Form hat.
// Alles andere wird verworfen, statt es ungeprueft ins Panel zu reichen (Befund 01).
function normalizeEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const since = typeof value.since === 'number' && Number.isFinite(value.since) ? value.since : null;
  if (since === null) return null;
  const by = typeof value.by === 'string' && value.by.trim() !== '' ? value.by : null;
  return { since, by };
}

function normalizeState(data) {
  const state = emptyState();
  if (!data || typeof data !== 'object' || Array.isArray(data)) return state;
  for (const [id, value] of Object.entries(data)) {
    if (!isValidId(id)) continue;
    const entry = normalizeEntry(value);
    if (entry) state[id] = entry;
  }
  return state;
}

// Reste eines abgebrochenen Schreibvorgangs entfernen (Befunde 05/11).
// Ein Fehler hier darf den Start nicht verhindern - es sind nur Reste.
async function cleanupTmpFiles() {
  try {
    const entries = await readdir(STATE_DIR);
    await Promise.all(
      entries
        .filter((name) => name.startsWith('pending-restart.json.tmp-'))
        .map((name) => rm(join(STATE_DIR, name), { force: true })),
    );
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[pendingRestart] Aufraeumen der Temp-Reste fehlgeschlagen: ${err.message}`);
    }
  }
}

async function readState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    return normalizeState(JSON.parse(raw));
  } catch (err) {
    // Nur "gibt es nicht" bedeutet wirklich "nichts ausstehend". Eine unlesbare
    // oder kaputte Datei wird NICHT als leer behandelt - sonst ueberschreibt der
    // naechste Schreibvorgang alle vorhandenen Merker (Befund 08).
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

async function writeStateAtomic(state) {
  await mkdir(STATE_DIR, { recursive: true });
  const tmp = `${TMP_PREFIX}${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
    await rename(tmp, STATE_PATH); // atomar: nie eine halbe Datei sichtbar
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {}); // Rest nicht liegen lassen
    throw err;
  }
}

// Lese-Aendere-Schreibe als eine unteilbare Einheit. Der Cache wird erst nach
// erfolgreichem rename gesetzt, damit er nie einen Stand zeigt, der nicht auf
// der Platte liegt (Befund 07).
function mutate(mutator) {
  const run = writeChain.then(async () => {
    const current = cache ?? await readState();
    const next = Object.assign(emptyState(), current);
    const result = mutator(next);
    await writeStateAtomic(next);
    cache = next;
    return result;
  });
  // Die Kette darf nicht an einem Fehler haengen bleiben.
  writeChain = run.catch(() => {});
  return run;
}

export async function loadPendingRestarts() {
  await cleanupTmpFiles();
  try {
    cache = await readState();
  } catch (err) {
    // Beim Start nicht die ganze Anzeige blockieren, aber den Fehler sichtbar
    // machen und den Cache leer lassen statt einen falschen Stand zu cachen.
    console.error(`[pendingRestart] Zustandsdatei unlesbar (${STATE_PATH}): ${err.message}`);
    cache = emptyState();
  }
  return cache;
}

// Der Aufrufer (server.js) ruft den Getter direkt nach dem Start. Ist der Cache
// noch nicht gefuellt, wird hier synchron nachgeladen statt faelschlich null zu
// melden (Befund 09). Nach loadPendingRestarts() greift sofort der Cache.
export async function getPendingRestart(id) {
  if (!isValidId(id)) return null;
  const state = cache ?? await loadPendingRestarts();
  return Object.hasOwn(state, id) ? state[id] : null;
}

// Setzt den Merker. by = wer die Config gespeichert hat (fuer die Anzeige).
export async function setPendingRestart(id, by = null) {
  if (!isValidId(id)) throw new Error(`Ungueltige Sword-ID fuer Neustart-Merker: ${id}`);
  return mutate((state) => {
    state[id] = { since: Date.now(), by: typeof by === 'string' ? by : null };
    return state[id];
  });
}

// Loescht den Merker. Gibt true zurueck, wenn wirklich etwas entfernt wurde.
export async function clearPendingRestart(id) {
  if (!isValidId(id)) return false;
  return mutate((state) => {
    if (!Object.hasOwn(state, id)) return false;
    delete state[id];
    return true;
  });
}
