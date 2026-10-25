// Game-Armory - Rack Loader (Schablonen)
// Laedt alle Rack-Schablonen (*.rack.json) aus /opt/game-armory/racks/ und validiert sie
// gegen das eingebaute Regelwerk (Spiegel von racks/rack.schema.json).
//
// Rack = Adapter/SCHABLONE fuer einen Gameserver-Typ (Spiel, Loader, Install-Methode,
// Root-Verzeichnis, Config-Datei). Enthaelt tier ("free"/"premium") fuer spaetere
// Lizenz-Sperre (Logik kommt spaeter, Feld ist ab Tag 1 da).
//
// Die konkreten Instanzen (Port/Service/RCON/...) liegen in swords/*.sword.json
// und werden von swords.js geladen.
//
// Validierung: bewusst ohne externes npm-Paket (Ajv waere eine neue Abhaengigkeit).
// Die Regeln hier spiegeln racks/rack.schema.json; bei Schema-Aenderungen beide pflegen.

import { readdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

const RACKS_DIR = '/opt/game-armory/racks';

// Sicherheitsgrenze fuer den SCHREIBPFAD: nur Dateien direkt in racks/,
// die auf '.rack.json' enden. Ein Rack-Name kommt vom Client und darf NIE
// aus dem Ordner herausfuehren (Path-Traversal). Erlaubte id-Zeichen sind
// exakt die des Schemas (^[a-z0-9][a-z0-9._-]*$) - damit sind '/', '\\' und
// '..' bereits ausgeschlossen; die Pruefung hier ist das zweite Netz.
const RACK_FILE_RE = /^[a-z0-9][a-z0-9._-]*\.rack\.json$/;

let rackCache = [];
let rackErrors = [];    // Ladefehler des letzten loadRacks() - fuer die Diagnose
let rackWarnings = [];  // weiche Hinweise (z.B. unbekannte Felder), Rack laedt trotzdem

// --- Erlaubte Werte (Spiegel des Schemas) -----------------------------------
const REQUIRED_FIELDS = [
  'id', 'name', 'description', 'icon', 'game', 'loader',
  'tier', 'licenseRequired', 'installMethod', 'defaultRoot',
  'source', 'javaRequired',
];
// Erlaubte Spielwerte. teamspeak3 und teamspeak6 getrennt, weil es zwei
// eigenstaendige Produkte sind (eigene Racks, eigene Releases).
const GAMES = ['minecraft', '7d2d', 'teamspeak3', 'teamspeak6'];
const LOADERS = ['vanilla', 'neoforge', 'forge', 'fabric', 'quilt', 'paper', 'spigot', 'purpur', 'native'];
const TIERS = ['free', 'premium'];
const INSTALL_METHODS = ['curseforge', 'steamcmd', 'zip', 'upload', 'url'];
const SOURCE_TYPES = ['curseforge', 'modrinth', 'ftb', 'steam', 'url', 'local'];

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const ROOT_RE = /^\/[a-zA-Z0-9._/-]+$/;

function fail(filename, msg) {
  throw new Error(`Rack ${filename}: ${msg}`);
}

function validateRack(rack, filename, warnings) {
  if (rack === null || typeof rack !== 'object' || Array.isArray(rack)) {
    fail(filename, 'kein JSON-Objekt');
  }

  // 1) Pflichtfelder
  const missing = REQUIRED_FIELDS.filter((f) => rack[f] === undefined);
  if (missing.length > 0) {
    fail(filename, `Pflichtfelder fehlen: ${missing.join(', ')}`);
  }

  // 2) id + String-Felder
  if (typeof rack.id !== 'string' || !ID_RE.test(rack.id)) {
    fail(filename, `id ungueltig: ${JSON.stringify(rack.id)}`);
  }
  for (const f of ['name', 'description', 'icon']) {
    if (typeof rack[f] !== 'string' || rack[f].length < 1) {
      fail(filename, `${f} muss ein nicht-leerer String sein`);
    }
  }

  // 3) Enums
  if (!GAMES.includes(rack.game)) {
    fail(filename, `game ungueltig: ${JSON.stringify(rack.game)} (erlaubt: ${GAMES.join(', ')})`);
  }
  if (!LOADERS.includes(rack.loader)) {
    fail(filename, `loader ungueltig: ${JSON.stringify(rack.loader)} (erlaubt: ${LOADERS.join(', ')})`);
  }
  if (!TIERS.includes(rack.tier)) {
    fail(filename, `tier muss "free" oder "premium" sein`);
  }
  if (!INSTALL_METHODS.includes(rack.installMethod)) {
    fail(filename, `installMethod ungueltig: ${JSON.stringify(rack.installMethod)} (erlaubt: ${INSTALL_METHODS.join(', ')})`);
  }
  if (typeof rack.licenseRequired !== 'boolean') {
    fail(filename, `licenseRequired muss boolean sein`);
  }

  // 3b) singleton (optional): Einmal-Rack. Nur echte Booleans erlaubt,
  //     damit ein Tippfehler wie "true" (String) nicht still durchrutscht.
  if (rack.singleton !== undefined && typeof rack.singleton !== 'boolean') {
    fail(filename, `singleton muss boolean sein (ist: ${JSON.stringify(rack.singleton)})`);
  }

  // 4) Installationswurzel (wird beim Install als Pfad benutzt -> streng pruefen)
  //    Sicherheitsregel: Root muss unter einem erlaubten Basisverzeichnis liegen.
  // Erlaubte Install-Wurzeln. '/opt' selbst ist zulaessig (dann ist der
  // Zielordner /opt/<id>), ebenso tiefere Pfade wie '/opt/minecraft'.
  const ALLOWED_ROOTS = ['/opt'];
  if (typeof rack.defaultRoot !== 'string' || !ROOT_RE.test(rack.defaultRoot) || rack.defaultRoot.includes('..')) {
    fail(filename, `defaultRoot ungueltig: ${JSON.stringify(rack.defaultRoot)}`);
  }
  if (!ALLOWED_ROOTS.some((base) => rack.defaultRoot === base || rack.defaultRoot.startsWith(base + '/'))) {
    fail(filename, `defaultRoot muss unter ${ALLOWED_ROOTS.join(' oder ')} liegen (ist: ${rack.defaultRoot})`);
  }

  // 5) Optionale Pfad-/Datei-Felder
  for (const f of ['configFile', 'startScript']) {
    if (rack[f] !== undefined && rack[f] !== null) {
      if (typeof rack[f] !== 'string' || rack[f].includes('..') || rack[f].startsWith('/')) {
        fail(filename, `${f} muss ein relativer Pfad ohne ".." sein`);
      }
    }
  }

  // 6) Ports (optionales Objekt)
  if (rack.ports !== undefined) {
    if (rack.ports === null || typeof rack.ports !== 'object' || Array.isArray(rack.ports)) {
      fail(filename, 'ports muss ein Objekt sein');
    }
    for (const [k, v] of Object.entries(rack.ports)) {
      if (!Number.isInteger(v) || v < 1 || v > 65535) {
        fail(filename, `ports.${k} muss ein Port (1-65535) sein`);
      }
    }
  }

  // 7) source (Bezugsquelle)
  const src = rack.source;
  if (src === null || typeof src !== 'object' || Array.isArray(src)) {
    fail(filename, 'source muss ein Objekt sein');
  }
  if (src.type === undefined || src.projectId === undefined) {
    fail(filename, 'source braucht type und projectId');
  }
  if (!SOURCE_TYPES.includes(src.type)) {
    fail(filename, `source.type ungueltig: ${JSON.stringify(src.type)}`);
  }
  if (src.appId !== undefined && src.appId !== null && !Number.isInteger(src.appId)) {
    fail(filename, 'source.appId muss eine Ganzzahl sein');
  }
  // Konsistenz: SteamCMD-Racks brauchen eine Steam-App-ID.
  if (rack.installMethod === 'steamcmd' && (src.appId === undefined || src.appId === null)) {
    fail(filename, 'installMethod "steamcmd" verlangt source.appId');
  }
  // Konsistenz: URL-Racks brauchen eine Download-URL.
  if (rack.installMethod === 'url') {
    if (typeof src.url !== 'string' || !/^https?:\/\//.test(src.url)) {
      fail(filename, 'installMethod "url" verlangt source.url (http/https)');
    }
  }
  // 8) javaRequired
  if (rack.javaRequired !== undefined && rack.javaRequired !== null && !Number.isInteger(rack.javaRequired)) {
    fail(filename, 'javaRequired muss eine Ganzzahl oder null sein');
  }
  // 8b) eula: sagt, ob ein EULA-Schritt noetig ist. Optional, Default 'none'.
  if (rack.eula !== undefined && !['required', 'none'].includes(rack.eula)) {
    fail(filename, `eula muss 'required' oder 'none' sein (ist: ${JSON.stringify(rack.eula)})`);
  }
  rack.eula = rack.eula ?? 'none';

  // 8c) packMarkers: Woran ein gueltiges Server-Archiv fuer DIESES Spiel erkannt
  //     wird. Optional - fehlt es, gilt der Minecraft-Standardsatz (siehe pack.js).
  //     Die Inhalts-Pruefung ist spielabhaengig: ein Modpack hat mods/ und
  //     startserver.sh, ein TeamSpeak-Release hat tsserver und tsserver.yaml.
  if (rack.packMarkers !== undefined) {
    if (!Array.isArray(rack.packMarkers) || rack.packMarkers.length === 0) {
      fail(filename, 'packMarkers muss eine nicht-leere Liste sein');
    }
    for (const m of rack.packMarkers) {
      if (typeof m !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(m)) {
        fail(filename, `packMarkers enthaelt einen ungueltigen Namen: ${JSON.stringify(m)}`);
      }
    }
  }

  // Weiche Pruefung: unbekannte Felder sind ERLAUBT (Kundenracks duerfen eigene
  // Felder mitbringen), werden aber gemeldet. So faellt ein Rack nie stumm aus
  // dem Panel, und der Betreiber sieht trotzdem, wenn etwas ungewoehnlich ist.
  const KNOWN = new Set([...REQUIRED_FIELDS, 'singleton', 'ports', 'eula', 'configFile', 'startScript', 'logFile', 'packMarkers']);
  const unknown = Object.keys(rack).filter((k) => !k.startsWith('$') && !KNOWN.has(k));
  if (unknown.length > 0) {
    warnings.push(`unbekannte Felder: ${unknown.join(', ')} (werden ignoriert)`);
  }

  return true;
}

export async function loadRacks() {
  const racks = [];
  const errors = [];
  const warnings = [];

  let files;
  try {
    files = await readdir(RACKS_DIR);
  } catch (err) {
    console.error(`[racks] Rack-Verzeichnis nicht lesbar: ${err.message}`);
    rackCache = []; rackErrors = errors; rackWarnings = warnings;
    return { racks: [], errors, warnings };
  }

  for (const file of files.filter((f) => f.endsWith('.rack.json'))) {
    const path = join(RACKS_DIR, file);
    try {
      const raw = await readFile(path, 'utf8');
      const rack = JSON.parse(raw);
      const fileWarnings = [];
      validateRack(rack, file, fileWarnings);
      // Die id im Inhalt MUSS zum Dateinamen passen. Sonst liegt das Rack im
      // Cache unter einer id, zu der keine Datei existiert: getRack() findet
      // es, Aendern oder Loeschen sucht aber "<id>.rack.json" und meldet
      // "nicht vorhanden". createRack() verhindert genau diese Abweichung
      // beim Anlegen - beim Laden fehlte die Pruefung bisher, eine von Hand
      // kopierte Datei kam also durch. Harter Fehler statt Warnung: das Rack
      // ist so nicht bearbeitbar, und ein stiller Sonderfall waere schlimmer
      // als eine sichtbare Meldung.
      const expectedId = file.slice(0, -'.rack.json'.length);
      if (rack.id !== expectedId) {
        throw new Error(
          `id im Inhalt ("${rack.id}") stimmt nicht mit dem Dateinamen ("${expectedId}") ueberein`,
        );
      }
      // Sperrlogik vorgesehen: Premium-Racks werden geladen, aber markiert.
      // Aktive Sperre (Lizenzpruefung) wird spaeter aktiviert.
      rack.locked = rack.tier === 'premium' && rack.licenseRequired === true;
      // Normalisieren, damit das Frontend nicht auf undefined pruefen muss.
      rack.singleton = rack.singleton === true;
      racks.push(rack);
      for (const w of fileWarnings) {
        warnings.push({ file, message: w });
        console.warn(`[racks] Hinweis bei ${file}: ${w}`);
      }
    } catch (err) {
      errors.push({ file, message: err.message });
      console.error(`[racks] Fehler bei ${file}: ${err.message}`);
    }
  }

  rackCache = racks;
  rackErrors = errors;
  rackWarnings = warnings;
  return { racks, errors, warnings };
}

export function getRacks() {
  return rackCache;
}

// Ladefehler/Hinweise des letzten loadRacks() - fuer die Diagnose im Panel.
export function getRackDiagnostics() {
  return { errors: rackErrors, warnings: rackWarnings };
}

export function getRack(id) {
  return rackCache.find((r) => r.id === id) ?? null;
}

// --- Schreiben (Panel-Rack-Verwaltung) -------------------------------------
// Ein Rack ist eine Schablone, die festlegt, WELCHES Spiel mit welchem
// Startskript und Zielpfad installiert wird - maechtiger als ein einzelner
// Sword. Deshalb laeuft JEDER Schreibvorgang durch EXAKT dieselbe Validierung
// wie der Datei-Weg (validateRack: Pflichtfelder, Enums, /opt-Whitelist, ..-Sperre).
// Es gibt keinen zweiten, laxeren Pfad.

// Fehlerklasse, damit die Route 400 statt 500 antwortet.
export class RackError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RackError';
    this.status = status;
  }
}

// Validiert einen Rack-Entwurf, ohne zu schreiben. Gibt die normalisierte
// Kopie zurueck (eula-Default, singleton-Bool) oder wirft RackError.
export function validateRackDraft(rack, filename = 'rack.json') {
  const copy = JSON.parse(JSON.stringify(rack ?? null));
  const warnings = [];
  try {
    validateRack(copy, filename, warnings);
  } catch (err) {
    // validateRack wirft generische Errors mit Praefix "Rack <file>: ...".
    // Fuer die API den Praefix entfernen, die Meldung bleibt gleich. Ein
    // Schema-Verstoss ist ein Eingabefehler -> 400.
    const msg = String(err.message).replace(/^Rack [^:]+: /, '');
    throw new RackError(msg, 400);
  }
  return { rack: copy, warnings };
}

// Dateiname fuer eine Rack-id. Wirft, wenn die id nicht schema-konform ist
// (doppeltes Netz gegen Path-Traversal, unabhaengig von validateRack).
function rackFilenameFor(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new RackError(`Rack-id ungueltig: ${JSON.stringify(id)}`);
  }
  const file = `${id}.rack.json`;
  if (!RACK_FILE_RE.test(file)) {
    throw new RackError(`Rack-id ergibt keinen gueltigen Dateinamen: ${id}`);
  }
  return file;
}

async function rackFileExists(id) {
  try { await stat(join(RACKS_DIR, `${id}.rack.json`)); return true; } catch { return false; }
}

// Atomar schreiben: erst Nebendatei, dann rename. So sieht loadRacks nie eine
// halb geschriebene Rack-Datei, und ein Absturz mitten im Schreiben laesst das
// alte Rack intakt. Datei endet auf '.rack.json' -> direkt in racks/, nie sonst.
async function writeRackFile(id, rack) {
  const file = rackFilenameFor(id);
  const target = join(RACKS_DIR, file);
  const tmp = join(RACKS_DIR, `.${file}.tmp-${process.pid}-${Date.now()}`);
  const body = JSON.stringify(rack, null, 2) + '\n';
  await writeFile(tmp, body, 'utf8');
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return file;
}

// Legt ein neues Rack an. Existiert die id schon -> Konflikt (409).
export async function createRack(rack) {
  const id = rack?.id;
  rackFilenameFor(id); // wirft bei ungueltiger id
  if (await rackFileExists(id)) {
    throw new RackError(`Rack mit id "${id}" existiert bereits`, 409);
  }
  const { rack: clean, warnings } = validateRackDraft(rack, `${id}.rack.json`);
  // id im Inhalt MUSS zur Datei passen - sonst laedt die Datei spaeter unter
  // falschem Namen und das Rack verschwindet still aus dem Cache.
  if (clean.id !== id) {
    throw new RackError('id im Inhalt stimmt nicht mit der Rack-id ueberein');
  }
  await writeRackFile(id, clean);
  await loadRacks(); // Cache sofort synchronisieren
  return { id, warnings };
}

// Ueberschreibt ein BESTEHENDES Rack. Die id ist unveraenderlich (Dateiname
// = id); ein Aendern der id waere ein Umbenennen und ist hier nicht erlaubt.
export async function updateRack(id, rack) {
  rackFilenameFor(id);
  if (!(await rackFileExists(id))) {
    throw new RackError(`Rack mit id "${id}" existiert nicht`, 404);
  }
  const { rack: clean, warnings } = validateRackDraft(rack, `${id}.rack.json`);
  if (clean.id !== id) {
    throw new RackError('Die id eines Racks ist unveraenderlich und darf nicht geaendert werden');
  }
  await writeRackFile(id, clean);
  await loadRacks();
  return { id, warnings };
}

// Loescht ein Rack. VERWEIGERT, solange noch Swords dieses Rack benutzen -
// ein Rack zu loeschen, waehrend Instanzen laufen, macht deren Anreicherung
// (game/eula) kaputt. Der Aufrufer uebergibt die Zahl der abhaengigen Swords.
export async function deleteRack(id, { dependentSwordIds = [] } = {}) {
  rackFilenameFor(id);
  if (!(await rackFileExists(id))) {
    throw new RackError(`Rack mit id "${id}" existiert nicht`, 404);
  }
  if (dependentSwordIds.length > 0) {
    throw new RackError(
      `Rack "${id}" wird noch von ${dependentSwordIds.length} Sword(s) benutzt `
      + `(${dependentSwordIds.join(', ')}). Erst diese entfernen.`,
      409,
    );
  }
  await unlink(join(RACKS_DIR, `${id}.rack.json`));
  await loadRacks();
  return { id };
}
