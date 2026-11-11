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
// Zwei Arten von Racks (2026-11-07):
//   game    - eine Schablone zum INSTALLIEREN eines Spiels (bisheriges Verhalten)
//   service - ein bereits laufender Dienst, der nur verwaltet wird
//
// Warum: Nextcloud laeuft als Docker-Stack. Es hat kein Spiel, keine
// Spiel-Version, keinen loader und keine Install-Quelle. Trotzdem braucht es
// ein Rack, weil die Seitenleiste RACKS listet, nicht Swords
// (public/app.js: countFor = (rack) => allSwords.filter(...)). Ohne Rack stand
// NC im Hauptbereich, fehlte aber links.
//
// Ohne `kind` gilt 'game' - alle Bestands-Racks bleiben damit gueltig, ohne
// dass eine Datei angefasst werden muss.
const KINDS = ['game', 'service'];

// Felder, die NUR ein Spiel-Rack braucht (es wird etwas installiert).
const GAME_REQUIRED_FIELDS = [
  'game', 'loader', 'installMethod', 'defaultRoot', 'source', 'javaRequired',
];

// Felder, die fuer BEIDE Arten gelten.
const BASE_REQUIRED_FIELDS = [
  'id', 'name', 'description', 'icon', 'tier', 'licenseRequired',
];

// Installer-Felder, die ein Dienst-Rack NICHT haben darf. Ein installMethod an
// einem Dienst waere eine Luege im Datenmodell - und der Installer koennte sie
// spaeter sogar befolgen.
const INSTALLER_FIELDS = [
  'game', 'loader', 'installMethod', 'defaultRoot', 'source', 'javaRequired',
  'startScript', 'startArgs', 'saveDir', 'logFile', 'packMarkers',
  'configTemplate', 'configFile', 'eula',
];

const REQUIRED_FIELDS = [...BASE_REQUIRED_FIELDS, ...GAME_REQUIRED_FIELDS];
// Erlaubte Spielwerte. teamspeak3 und teamspeak6 getrennt, weil es zwei
// eigenstaendige Produkte sind (eigene Racks, eigene Releases).
const GAMES = ['minecraft', '7d2d', 'teamspeak3', 'teamspeak6', 'satisfactory'];
const LOADERS = ['vanilla', 'neoforge', 'forge', 'fabric', 'quilt', 'paper', 'spigot', 'purpur', 'native'];
const TIERS = ['free', 'premium'];
const INSTALL_METHODS = ['curseforge', 'steamcmd', 'zip', 'upload', 'github', 'docker'];
  // 'docker' (Karte 28, 2026-11-10): ein LAUFENDER Compose-Stack wird
  // uebernommen, nicht installiert. Deshalb steht 'docker' NICHT in
  // SOURCE_TYPES - es gibt keine Quelle, aus der geladen wird. Wer ein
  // Docker-Rack anlegt, meint "verwalten", nicht "installieren".
// Erlaubte source.type. 'zip' und 'upload' sind die beiden Methoden OHNE
// entfernte Quelle: der Betreiber stellt das Archiv selbst (2026-11-06).
// Sie fehlten hier, obwohl installRoutes.js sie bedient (dort :1048 'zip'
// -> source.path, :1052 'upload' -> source.uploadId) und
// INSTALL_TYPE_FOR_METHOD (:977) sie als Zielwert bildet - ein ZIP-Rack
// liess sich dadurch gar nicht erst anlegen.
const SOURCE_TYPES = ['curseforge', 'modrinth', 'ftb', 'steam', 'github', 'local', 'zip', 'upload'];

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const ROOT_RE = /^\/[a-zA-Z0-9._/-]+$/;

function fail(filename, msg) {
  throw new Error(`Rack ${filename}: ${msg}`);
}

function validateRack(rack, filename, warnings) {
  if (rack === null || typeof rack !== 'object' || Array.isArray(rack)) {
    fail(filename, 'kein JSON-Objekt');
  }

  // 0) Art bestimmen. Ohne kind = 'game' (Bestand).
  if (rack.kind !== undefined && !KINDS.includes(rack.kind)) {
    fail(filename, `kind ungültig: ${JSON.stringify(rack.kind)} (erlaubt: ${KINDS.join(', ')})`);
  }
  const kind = rack.kind ?? 'game';
  rack.kind = kind;

  // 1) Pflichtfelder - je nach Art unterschiedlich.
  if (kind === 'service') {
    const missingBase = BASE_REQUIRED_FIELDS.filter((f) => rack[f] === undefined);
    if (missingBase.length > 0) {
      fail(filename, `Pflichtfelder fehlen: ${missingBase.join(', ')}`);
    }
    // Keine Mischform: ein Dienst-Rack installiert nichts.
    const verboten = INSTALLER_FIELDS.filter((f) => rack[f] !== undefined);
    if (verboten.length > 0) {
      fail(filename, `Ein Dienst-Rack (kind "service") darf keine Installer-Felder haben: ${verboten.join(', ')}`);
    }
  } else {
    const missing = REQUIRED_FIELDS.filter((f) => rack[f] === undefined);
    if (missing.length > 0) {
      fail(filename, `Pflichtfelder fehlen: ${missing.join(', ')}`);
    }
  }

  // 2) id + String-Felder
  if (typeof rack.id !== 'string' || !ID_RE.test(rack.id)) {
    fail(filename, `id ungültig: ${JSON.stringify(rack.id)}`);
  }
  for (const f of ['name', 'description', 'icon']) {
    if (typeof rack[f] !== 'string' || rack[f].length < 1) {
      fail(filename, `${f} muss ein nicht-leerer String sein`);
    }
  }

  // 3) Enums - game/loader/installMethod NUR fuer Spiel-Racks. Ein Dienst
  //    hat kein Spiel und keinen Loader; die Pruefung wuerde sonst
  //    "game ungültig: undefined" melden (live erlebt beim ersten Versuch).
  if (kind === 'game') {
    if (!GAMES.includes(rack.game)) {
      fail(filename, `game ungültig: ${JSON.stringify(rack.game)} (erlaubt: ${GAMES.join(', ')})`);
    }
    if (!LOADERS.includes(rack.loader)) {
      fail(filename, `loader ungültig: ${JSON.stringify(rack.loader)} (erlaubt: ${LOADERS.join(', ')})`);
    }
    if (!INSTALL_METHODS.includes(rack.installMethod)) {
      fail(filename, `installMethod ungültig: ${JSON.stringify(rack.installMethod)} (erlaubt: ${INSTALL_METHODS.join(', ')})`);
    }
  }
  // Diese zwei gelten fuer BEIDE Arten.
  if (!TIERS.includes(rack.tier)) {
    fail(filename, `tier muss "free" oder "premium" sein`);
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
  if (kind === 'game') {
    if (typeof rack.defaultRoot !== 'string' || !ROOT_RE.test(rack.defaultRoot) || rack.defaultRoot.includes('..')) {
      fail(filename, `defaultRoot ungültig: ${JSON.stringify(rack.defaultRoot)}`);
    }
    if (!ALLOWED_ROOTS.some((base) => rack.defaultRoot === base || rack.defaultRoot.startsWith(base + '/'))) {
      fail(filename, `defaultRoot muss unter ${ALLOWED_ROOTS.join(' oder ')} liegen (ist: ${rack.defaultRoot})`);
    }
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

  // 7) source (Bezugsquelle) - nur Spiel-Racks haben eine Quelle zum Installieren.
  if (kind === 'game') {
  const src = rack.source;
  if (src === null || typeof src !== 'object' || Array.isArray(src)) {
    fail(filename, 'source muss ein Objekt sein');
  }
  if (src.type === undefined || src.projectId === undefined) {
    fail(filename, 'source braucht type und projectId');
  }
  if (!SOURCE_TYPES.includes(src.type)) {
    fail(filename, `source.type ungültig: ${JSON.stringify(src.type)}`);
  }
  if (src.appId !== undefined && src.appId !== null && !Number.isInteger(src.appId)) {
    fail(filename, 'source.appId muss eine Ganzzahl sein');
  }
  // Konsistenz: SteamCMD-Racks brauchen eine Steam-App-ID.
  if (rack.installMethod === 'steamcmd' && (src.appId === undefined || src.appId === null)) {
    fail(filename, 'installMethod "steamcmd" verlangt source.appId');
  }
  // Konsistenz: GitHub-Racks brauchen ein Repo. Bewusst STRENG - frueher hiess
  // die Methode "url" und nahm jeden http(s)-String an. Der Code loest sie aber
  // als GitHub-Repo auf (api.github.com/repos/<url>) und laedt die
  // browser_download_url aus der Antwort - ein fremder Host wurde damit als
  // Quelle akzeptiert und sein Archiv per Helfer als root entpackt.
  // Jetzt: nur github.com/<owner>/<repo>, nichts anderes.
  if (rack.installMethod === 'github') {
    const url = src.url;
    const okUrl = typeof url === 'string'
      && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.trim());
    const okShort = typeof url === 'string'
      && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.trim());
    if (!okUrl && !okShort) {
      fail(filename,
        `installMethod "github" verlangt source.url als https://github.com/<owner>/<repo> `
        + `(oder "owner/repo") - nicht ${JSON.stringify(url)}`);
    }
  }
  // 8a) configTemplate: Dateiname einer Vorlage unter templates/. Optional, aber
  //     fuer installMethod "github" Pflicht - ohne Vorlage laesst sich keine
  //     Konfiguration schreiben, und raten ist genau der Fehler vom 2026-09-27.
  if (rack.configTemplate !== undefined) {
    if (typeof rack.configTemplate !== 'string' || !/^[A-Za-z0-9._-]+\.(yaml|yml|json|conf|properties|xml|cfg|ini)$/.test(rack.configTemplate)) {
      fail(filename, `configTemplate muss ein Dateiname unter templates/ sein (ist: ${JSON.stringify(rack.configTemplate)})`);
    }
  }
  if (rack.installMethod === 'github' && !rack.configTemplate) {
    fail(filename, 'installMethod "github" verlangt configTemplate (Vorlage unter templates/)');
  }

  } // Ende source (nur kind === 'game')

  // 8) javaRequired (nur Spiel-Racks - ein Dienst hat kein Java)
  if (kind === 'game' && rack.javaRequired !== undefined && rack.javaRequired !== null && !Number.isInteger(rack.javaRequired)) {
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
        fail(filename, `packMarkers enthält einen ungültigen Namen: ${JSON.stringify(m)}`);
      }
    }
  }

  // Weiche Pruefung: unbekannte Felder sind ERLAUBT (Kundenracks duerfen eigene
  // Felder mitbringen), werden aber gemeldet. So faellt ein Rack nie stumm aus
  // dem Panel, und der Betreiber sieht trotzdem, wenn etwas ungewoehnlich ist.
  // 8d) readyMarkers: Log-Zeilen, an denen ein LAUFENDER Server spielbereit
  //     ist (2026-10-31). Bewusst KEINE Namenspruefung wie bei packMarkers -
  //     das sind freie Log-Texte ("StartGame done", "Done (", "listening on").
  //     Nur die Form wird geprueft: nicht-leere Strings.
  if (rack.readyMarkers !== undefined) {
    if (!Array.isArray(rack.readyMarkers) || rack.readyMarkers.length === 0) {
      fail(filename, 'readyMarkers muss eine nicht-leere Liste sein');
    }
    for (const m of rack.readyMarkers) {
      if (typeof m !== 'string' || m.trim().length === 0) {
        fail(filename, `readyMarkers enthält einen ungültigen Eintrag: ${JSON.stringify(m)}`);
      }
    }
  }

  // `kind` ist seit 2026-11-07 bekannt (game | service). Ohne den Eintrag hier
// meldete jedes Rack "unbekannte Felder: kind (werden ignoriert)" - live
// erlebt beim ersten Lauf, weil validateRack() das Feld selbst setzt.
const KNOWN = new Set([...REQUIRED_FIELDS, 'kind', 'singleton', 'ports', 'eula', 'configFile', 'startScript', 'startArgs', 'saveDir', 'logFile', 'packMarkers', 'readyMarkers', 'configTemplate']);
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
          `id im Inhalt ("${rack.id}") stimmt nicht mit dem Dateinamen ("${expectedId}") überein`,
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
    // Marker fuer den zentralen Error-Handler (M2, 2026-10-31): nur mit
    // userMessage=true geht message nach aussen. Diese Klasse traegt eine fuer
    // Menschen geschriebene Meldung, keine Bibliotheks-Interna.
    // (Bewusst NICHT `expose`: das setzt body-parser selbst bei Parser-Fehlern.)
    this.userMessage = true;
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
    throw new RackError(`Rack-id ungültig: ${JSON.stringify(id)}`);
  }
  const file = `${id}.rack.json`;
  if (!RACK_FILE_RE.test(file)) {
    throw new RackError(`Rack-id ergibt keinen gültigen Dateinamen: ${id}`);
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

// Serialisiert alle Rack-Schreibvorgaenge (Audit-Fix 2026-10-30, D302).
// Vorher lagen Pruefung und Schreiben in createRack durch ein `await` getrennt:
// zwei gleichzeitige Anfragen sahen beide "existiert nicht", beide bekamen 201,
// und der zweite rename ueberschrieb den ersten. Die 409-Zusage war damit
// gebrochen. Gleiche Bauart wie withSwordLock in swords.js.
let rackLockTail = Promise.resolve();
function withRackLock(fn) {
  const run = rackLockTail.then(fn, fn);
  rackLockTail = run.then(() => undefined, () => undefined);
  return run;
}

// Legt ein neues Rack an. Existiert die id schon -> Konflikt (409).
export async function createRack(rack) {
  return withRackLock(async () => {
    const id = rack?.id;
    rackFilenameFor(id); // wirft bei ungueltiger id
    if (await rackFileExists(id)) {
      throw new RackError(`Rack mit id "${id}" existiert bereits`, 409);
    }
    const { rack: clean, warnings } = validateRackDraft(rack, `${id}.rack.json`);
    // id im Inhalt MUSS zur Datei passen - sonst laedt die Datei spaeter unter
    // falschem Namen und das Rack verschwindet still aus dem Cache.
    if (clean.id !== id) {
      throw new RackError('id im Inhalt stimmt nicht mit der Rack-id überein');
    }
    await writeRackFile(id, clean);
    await loadRacks(); // Cache sofort synchronisieren
    return { id, warnings };
  });
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
    throw new RackError('Die id eines Racks ist unveränderlich und darf nicht geändert werden');
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
