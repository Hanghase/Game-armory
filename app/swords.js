// Game-Armory - Sword Loader
// Lädt alle Sword-Instanzen (*.sword.json) aus /opt/game-armory/swords/ und validiert sie.
// Sword = INSTANZ eines konkreten laufenden Servers (Port, Service, RCON, Welt-Pfad, User).
// Die Schablone (Spieltyp/Loader/Quelle) liegt separat in racks/*.rack.json (siehe racks.js).

import { readdir, readFile, writeFile, rename, stat, chown } from 'node:fs/promises';
import { join } from 'node:path';
import { getRack } from './racks.js';

const SWORDS_DIR = '/opt/game-armory/swords';
const REQUIRED_FIELDS = ['id', 'name', 'control'];

const KNOWN_FIELDS = [
  '$schema', 'id', 'rack', 'name', 'game', 'port', 'protocol', 'control',
  'logs', 'rcon', 'telnet', 'update', 'tier', 'licenseRequired',
  'javaRequired', 'javaInstalled', 'javaWarning', 'description', 'configFile',
  'installedVersion', 'installedVersionSource', 'installedVersionAt', 'installedVersionBy',
  // Ergebnis der Versions-Gegenprobe (2026-10-18): was ist laut Quelle die
  // neueste Verfuegbare Version, wann wurde geprueft, und was kam heraus.
  // state: current | outdated | unknown  (unknown = Quelle sagt nichts, nie raten)
  'availableVersion', 'versionCheckedAt', 'versionState', 'versionCheckReason',
];

let swordCache = [];
let swordErrors = [];    // Ladefehler des letzten loadSwords() - fuer die Diagnose
let swordWarnings = [];  // weiche Hinweise (z.B. unbekanntes Rack), Sword laedt trotzdem

function validateSword(sword, filename, warnings) {
  const missing = REQUIRED_FIELDS.filter((f) => sword[f] === undefined);
  if (missing.length > 0) {
    throw new Error(`Sword ${filename}: Pflichtfelder fehlen: ${missing.join(', ')}`);
  }
  if (sword.tier !== undefined && !['free', 'premium'].includes(sword.tier)) {
    throw new Error(`Sword ${filename}: tier muss "free" oder "premium" sein`);
  }
  // installedVersion ist PFLICHT (Spec 2026-10-10): entweder automatisch
  // ermittelt oder im Panel von Hand nachgetragen. Ein Sword ohne Version
  // ist unzulaessig. Fehlt sie, wird der Sword NICHT geladen (harter Fehler),
  // damit die Luecke sichtbar wird statt still zu bleiben.
  if (typeof sword.installedVersion !== 'string' || sword.installedVersion.trim() === '') {
    throw new Error(
      `Sword ${filename}: installedVersion fehlt - automatisch nicht ermittelbar, `
      + 'bitte im Panel ueber "Version eintragen" nachtragen.',
    );
  }

  // Weiche Pruefung: unbekannte Felder sind erlaubt (Kundenracks duerfen eigene
  // Felder mitbringen), werden aber gemeldet - kein stummer Ausfall.
  const unknown = Object.keys(sword).filter((k) => !KNOWN_FIELDS.includes(k));
  if (unknown.length > 0) {
    warnings.push(`unbekannte Felder: ${unknown.join(', ')} (werden ignoriert)`);
  }
  return true;
}

export async function loadSwords() {
  const swords = [];
  const errors = [];
  const warnings = [];

  let files;
  try {
    files = await readdir(SWORDS_DIR);
  } catch (err) {
    console.error(`[swords] Sword-Verzeichnis nicht lesbar: ${err.message}`);
    swordCache = []; swordErrors = errors; swordWarnings = warnings;
    return { swords: [], errors, warnings };
  }

  for (const file of files.filter((f) => f.endsWith('.sword.json'))) {
    const path = join(SWORDS_DIR, file);
    try {
      const raw = await readFile(path, 'utf8');
      const sword = JSON.parse(raw);
      const fileWarnings = [];
      validateSword(sword, file, fileWarnings);
      // Sperrlogik vorgesehen: Premium-Swords werden geladen, aber markiert.
      // Aktive Sperre (Lizenzprüfung) wird später aktiviert.
      sword.locked = sword.tier === 'premium' && sword.licenseRequired === true;
      // Spiel IMMER aus dem Rack ableiten (einheitliche Quelle). Das Feld
      // game wird nicht mehr in der Sword-Datei gepflegt - eine Kopie waere
      // eine zweite Wahrheit, die auseinanderlaufen kann. Minecraft ist der
      // Default nur fuer Alt-Swords ohne passendes Rack.
      const rack = getRack(sword.rack);
      sword.game = rack?.game ?? 'minecraft';
      if (!rack) {
        fileWarnings.push(`kein Rack "${sword.rack}" gefunden - game faellt auf 'minecraft' zurueck`);
      }
      // EULA-Schritt aus dem Rack ableiten (einheitliche Quelle). So weiss
      // das Frontend pro Sword, ob der EULA-Button ueberhaupt sinnvoll ist.
      sword.eula = rack?.eula ?? 'none';
      swords.push(sword);
      for (const w of fileWarnings) {
        warnings.push({ file, message: w });
        console.warn(`[swords] Hinweis bei ${file}: ${w}`);
      }
    } catch (err) {
      errors.push({ file, message: err.message });
      console.error(`[swords] Fehler bei ${file}: ${err.message}`);
    }
  }

  swordCache = swords;
  swordErrors = errors;
  swordWarnings = warnings;
  return { swords, errors, warnings };
}

export function getSwords() {
  return swordCache;
}

export function getSword(id) {
  return swordCache.find((s) => s.id === id) ?? null;
}

// Ladefehler/Hinweise des letzten loadSwords() - fuer die Diagnose im Panel.
export function getSwordDiagnostics() {
  return { errors: swordErrors, warnings: swordWarnings };
}

// Traegt die installierte Version haendisch nach (Spec 2026-10-10).
// Gedacht fuer Faelle, in denen die Automatik keine Version findet (z.B.
// Kundenpack mit unbekanntem Dateinamen). Schreibt atomar (tmp + rename),
// damit nie eine halbe Datei sichtbar ist. Rueckgabe: das aktualisierte Sword.
export async function setInstalledVersion(id, { version, source = 'manual', by = null }) {
  const v = typeof version === 'string' ? version.trim() : '';
  if (!v) throw new Error('Version darf nicht leer sein');

  const sword = swordCache.find((s) => s.id === id);
  if (!sword) {
    const err = new Error('Sword nicht gefunden');
    err.status = 404;
    throw err;
  }

  const path = join(SWORDS_DIR, `${id}.sword.json`);
  let data;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`Sword-Datei nicht lesbar (${id}): ${err.message}`);
  }

  data.installedVersion = v;
  data.installedVersionSource = source;
  data.installedVersionAt = Date.now();
  data.installedVersionBy = by;

  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, path);   // atomar

  // Besitz erhalten: der Panel-Prozess laeuft als 'armory'. Wird die Datei von
  // einem anderen User (z.B. root) neu geschrieben, faellt sie sonst auf
  // root:root und 'armory' kann sie beim naechsten Speichern nicht mehr
  // ueberschreiben. Deshalb den urspruenglichen Besitzer wiederherstellen.
  try {
    const st = await stat(path);
    if (st.uid !== process.getuid() || st.gid !== process.getgid()) {
      await chown(path, process.getuid(), process.getgid());
    }
  } catch { /* Besitz nicht aenderbar: Schreibzugriff prueft der Aufrufer */ }

  // Cache aktualisieren, damit die API sofort den neuen Wert liefert.
  sword.installedVersion = v;
  sword.installedVersionSource = source;
  sword.installedVersionAt = data.installedVersionAt;
  sword.installedVersionBy = by;
  return sword;
}

// Schreibt die Soll-Version (update.availableVersion) in die Sword-Datei.
// Nur noetig fuer Quellen OHNE Abfragemoeglichkeit (z.B. CurseForge ohne Key):
// dort ist das die einzige Wahrheit, gegen die verglichen werden kann.
// Leerer Wert entfernt sie wieder (dann gilt: keine Soll-Version eingetragen).
export async function setTargetVersion(id, { version = null, by = null }) {
  const v = typeof version === 'string' ? version.trim() : '';

  const sword = swordCache.find((s) => s.id === id);
  if (!sword) {
    const err = new Error('Sword nicht gefunden');
    err.status = 404;
    throw err;
  }

  const path = join(SWORDS_DIR, `${id}.sword.json`);
  let data;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`Sword-Datei nicht lesbar (${id}): ${err.message}`);
  }

  data.update = data.update ?? {};
  if (v) {
    data.update.availableVersion = v;
    data.targetVersionAt = Date.now();
    data.targetVersionBy = by;
  } else {
    delete data.update.availableVersion;
    delete data.targetVersionAt;
    delete data.targetVersionBy;
  }

  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, path);   // atomar

  // Besitz erhalten (Panel-Prozess = 'armory'), sonst kein Schreiben mehr.
  try {
    const st = await stat(path);
    if (st.uid !== process.getuid() || st.gid !== process.getgid()) {
      await chown(path, process.getuid(), process.getgid());
    }
  } catch { /* Besitz nicht aenderbar: Schreibzugriff prueft der Aufrufer */ }

  // Cache aktualisieren, damit die API sofort den neuen Wert liefert.
  sword.update = data.update;
  sword.targetVersionAt = data.targetVersionAt ?? null;
  sword.targetVersionBy = data.targetVersionBy ?? null;
  return sword;
}

// CurseForge-Pack-Nummer (update.projectId) setzen oder entfernen.
// Warum ein eigenes Feld: Die Pack-Nummer ist ein CURSE-Thema und steht NICHT
// im Serverpack/Manifest - sie laesst sich also nicht beim Install erraten.
// Wer sie kennt (und einen eigenen API-Key hat), traegt sie hier ein; dann
// kann der Versionscheck direkt gegen CurseForge laufen statt gegen eine
// handgepflegte Soll-Version.
// Zulaessig: Zahl oder Slug-String (Racks erlauben beides). Leer = entfernen.
export async function setSwordProjectId(id, { projectId = null, by = null }) {
  const raw = typeof projectId === 'string' ? projectId.trim() : (projectId ?? '');
  const pid = raw === '' ? null : (/^\d+$/.test(String(raw)) ? Number(raw) : String(raw));

  if (pid !== null) {
    // Nur harmlose Zeichen: CurseForge-Slugs sind a-z0-9-_, Zahlen pur.
    if (typeof pid === 'string' && !/^[a-zA-Z0-9._-]{1,80}$/.test(pid)) {
      const err = new Error('projectId darf nur Buchstaben, Zahlen, Punkt, _ und - enthalten');
      err.status = 400;
      throw err;
    }
    if (typeof pid === 'number' && (!Number.isSafeInteger(pid) || pid <= 0)) {
      const err = new Error('projectId als Zahl muss eine positive Ganzzahl sein');
      err.status = 400;
      throw err;
    }
  }

  const sword = swordCache.find((s) => s.id === id);
  if (!sword) {
    const err = new Error('Sword nicht gefunden');
    err.status = 404;
    throw err;
  }

  const path = join(SWORDS_DIR, `${id}.sword.json`);
  let data;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`Sword-Datei nicht lesbar (${id}): ${err.message}`);
  }

  data.update = data.update ?? {};
  if (pid !== null) {
    data.update.projectId = pid;
    data.projectIdAt = Date.now();
    data.projectIdBy = by;
  } else {
    delete data.update.projectId;
    delete data.projectIdAt;
    delete data.projectIdBy;
  }

  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, path);   // atomar

  try {
    const st = await stat(path);
    if (st.uid !== process.getuid() || st.gid !== process.getgid()) {
      await chown(path, process.getuid(), process.getgid());
    }
  } catch { /* Besitz nicht aenderbar: Schreibzugriff prueft der Aufrufer */ }

  sword.update = data.update;
  sword.projectIdAt = data.projectIdAt ?? null;
  sword.projectIdBy = data.projectIdBy ?? null;
  return sword;
}

// Schreibt die Ergebnis-Prüfung der Versions-Gegenprobe in die Sword-Datei.
// Eigene Funktion (statt in setInstalledVersion hinein), weil das zwei
// verschiedene Dinge sind: installedVersion = was laeuft,
// availableVersion = was es gibt. Atomar wie oben, Besitz bleibt erhalten.
export async function setVersionCheck(id, { state, available = null, reason = null }) {
  const allowed = new Set(['current', 'outdated', 'unknown']);
  const st = allowed.has(state) ? state : 'unknown';

  const sword = swordCache.find((s) => s.id === id);
  if (!sword) {
    const err = new Error('Sword nicht gefunden');
    err.status = 404;
    throw err;
  }

  const path = join(SWORDS_DIR, `${id}.sword.json`);
  let data;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`Sword-Datei nicht lesbar (${id}): ${err.message}`);
  }

  data.versionState = st;
  data.availableVersion = available;
  data.versionCheckReason = reason;
  data.versionCheckedAt = Date.now();

  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, path);

  try {
    const s = await stat(path);
    if (s.uid !== process.getuid() || s.gid !== process.getgid()) {
      await chown(path, process.getuid(), process.getgid());
    }
  } catch { /* Besitz nicht aenderbar */ }

  sword.versionState = st;
  sword.availableVersion = available;
  sword.versionCheckReason = reason;
  sword.versionCheckedAt = data.versionCheckedAt;
  return sword;
}
