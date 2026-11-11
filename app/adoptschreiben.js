// Uebernehmen: aus einem geprueften Kandidaten wird ein Sword (Karte 28).
//
// Diese Datei schreibt. Deshalb gilt hier, was fuer alle Schreiber im Projekt
// gilt: Lock + tmp+rename, damit ein abgebrochener Schreibvorgang keine halbe
// Datei hinterlaesst.
//
// Und: ein Sword ohne Rack laedt nicht. validateSword verlangt
// installedVersion als nicht-leeren String (swords.js:64), und `game` kommt
// NICHT aus der Sword-Datei, sondern aus getRack(sword.rack) (swords.js:135).
// Deshalb prueft diese Datei das Rack VOR dem Schreiben und legt nichts an,
// wenn es fehlt.

import { writeFile, rename, mkdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const SWORDS_DIR = '/opt/game-armory/swords';

// Wohin die Herkunft geschrieben wird. Damit weiss das Panel spaeter, ob eine
// Version "angegeben" oder "erkannt" ist - ohne diese Datei muesste es raten.
export const INSTANZ_DATEI = 'armory-instance.json';

/**
 * Baut das control-Objekt aus einem erkannten Kandidaten.
 *
 * Warum das hier und nicht im Panel: das Panel kennt den Compose-Pfad gar
 * nicht - es sieht nur id, label, rackId. Der Pfad steckt in kandidat.quellen.
 * Wuerde das Panel ihn mitschicken, koennte ein Aufrufer irgendeinen Pfad
 * unterschieben. Der Server nimmt ihn aus SEINER Erkennung.
 *
 * Gibt null zurueck, wenn kein Pfad da ist. Dann wird NICHT geraten: ein
 * falscher Pfad zeigt dockerStatus auf eine fremde Datei, und das faellt
 * erst beim Start/Stop auf.
 */
export function baueControl(kandidat, arbeitsVerzeichnis) {
  if (!kandidat || typeof kandidat !== 'object') return null;

  // Nur der Docker-Zweig hat eine Compose-Datei. Eine systemd-Unit hat keine,
  // und sie braucht auch keine - dort ist control.type 'systemd'.
  if (kandidat.quelle !== 'docker') {
    if (kandidat.quelle === 'systemd') {
      return { type: 'systemd', unit: `${kandidat.id}.service` };
    }
    return null;
  }

  const quellen = Array.isArray(kandidat.quellen) ? kandidat.quellen.filter(Boolean) : [];
  if (quellen.length === 0) return null;

  // Genau EINE Datei. Zwei waeren ein Zeichen fuer einen Namenskonflikt -
  // dann lieber nachfragen als eine auswaehlen.
  if (quellen.length > 1) {
    throw new Error(`Kandidat ${kandidat.id} hat ${quellen.length} Compose-Dateien `
      + `(${quellen.join(', ')}) - welche gilt?`);
  }

  return {
    type: 'docker',
    compose: quellen[0],
    services: Array.isArray(kandidat.dienste) ? [...kandidat.dienste] : [],
    workingDir: arbeitsVerzeichnis || null,
  };
}

/**
 * Was ein uebernommener Sword mindestens braucht.
 * Alles andere kommt aus dem Rack oder bleibt leer.
 */
export function baueAdoptiertenSword({ id, rackId, name, port, control, logs, beschreibung }) {
  return {
    $schema: './sword.schema.json',
    id,
    rack: rackId,
    name,
    port,
    protocol: 'tcp',
    control,
    logs,
    // Die Herkunft ist der Kern der Adoption: dieser Sword wurde NICHT
    // installiert, sondern vorgefunden.
    installedVersionSource: 'existing',
    installedVersion: beschreibung ?? 'vorgefunden',
    tier: 'free',
  };
}

/**
 * Prueft, ob ein Sword-Objekt geschrieben werden darf.
 *
 * Bewusst dieselben Regeln wie validateSword, aber hier VOR dem Schreiben -
 * sonst legt die Adoption eine Datei an, die beim naechsten loadSwords()
 * als Fehler auftaucht und den Sword unsichtbar macht.
 */
export function pruefeSchreibbar(sword, vorhandeneIds) {
  const fehler = [];

  if (!sword || typeof sword !== 'object') return ['kein Sword-Objekt'];

  if (typeof sword.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(sword.id)) {
    fehler.push(`ungültige id: ${sword.id}`);
  }
  if (typeof sword.name !== 'string' || sword.name.trim() === '') {
    fehler.push('name fehlt');
  }
  if (!sword.control || typeof sword.control !== 'object') {
    fehler.push('control fehlt');
  }
  if (typeof sword.installedVersion !== 'string' || sword.installedVersion.trim() === '') {
    // Harte Regel aus swords.js:64 - ohne diese Angabe laedt der Sword nicht.
    fehler.push('installedVersion fehlt (der Sword wuerde nicht laden)');
  }
  if (!sword.rack) {
    fehler.push('rack fehlt (ohne Rack kein game/eula)');
  }
  if (Array.isArray(vorhandeneIds) && vorhandeneIds.includes(sword.id)) {
    fehler.push(`id bereits vergeben: ${sword.id}`);
  }
  if (Number.isInteger(sword.port) && (sword.port < 1024 || sword.port > 65535)) {
    fehler.push(`Port außerhalb 1024-65535: ${sword.port}`);
  }

  return fehler;
}

/**
 * Schreibt die Sword-Datei.
 *
 * Ablauf: nach tmp schreiben, dann umbenennen. Ein Abbruch mittendrin laesst
 * damit entweder die alte Datei oder gar keine - nie eine halbe.
 *
 * @returns {Promise<{ok: boolean, pfad?: string, fehler?: string[]}>}
 */
export async function schreibeSword(sword, deps = {}) {
  const dir = deps.dir ?? SWORDS_DIR;
  const fsWrite = deps.writeFile ?? writeFile;
  const fsRename = deps.rename ?? rename;
  const fsMkdir = deps.mkdir ?? mkdir;
  const fsUnlink = deps.unlink ?? unlink;
  const vorhandene = deps.vorhandeneIds ?? [];

  const fehler = pruefeSchreibbar(sword, vorhandene);
  if (fehler.length > 0) return { ok: false, fehler };

  await fsMkdir(dir, { recursive: true });
  const ziel = join(dir, `${sword.id}.sword.json`);
  const tmp = `${ziel}.tmp-${process.pid}`;

  try {
    await fsWrite(tmp, `${JSON.stringify(sword, null, 2)}\n`, 'utf8');
    await fsRename(tmp, ziel);
  } catch (err) {
    // Aufraeumen, damit kein .tmp-* liegen bleibt (Lehre aus dem Transfer:
    // eine .teil-Datei, die niemand wegraeumt, sieht aus wie ein Fehler).
    try { await fsUnlink(tmp); } catch { /* war schon weg */ }
    return { ok: false, fehler: [`schreiben fehlgeschlagen: ${err.message}`] };
  }

  return { ok: true, pfad: ziel };
}

/**
 * Legt armory-instance.json ins Arbeitsverzeichnis der Instanz - oder
 * meldet, dass es dort schon liegt.
 *
 * Was da drin steht, ist bewusst wenig: Herkunft und Zeitpunkt. Die
 * Pack-Version steht NICHT drin, weil sie an einer ATM-Instanz gar nicht
 * existiert (keine modrinth.index.json, keine manifest.json - nachgemessen
 * 2026-11-10). Sie zu erfinden waere schlimmer als sie weglassen.
 */
export async function schreibeHerkunft(arbeitsVerzeichnis, daten, deps = {}) {
  const fsWrite = deps.writeFile ?? writeFile;
  const fsRename = deps.rename ?? rename;
  const fsUnlink = deps.unlink ?? unlink;
  const fsStat = deps.stat ?? stat;
  const dateiName = deps.dateiName ?? INSTANZ_DATEI;

  if (!arbeitsVerzeichnis || !arbeitsVerzeichnis.startsWith('/')) {
    return { ok: false, grund: 'kein gültiges Arbeitsverzeichnis' };
  }

  const ziel = join(arbeitsVerzeichnis, dateiName);
  const tmp = `${ziel}.tmp-${process.pid}`;

  // Existiert schon? Dann NICHT ueberschreiben - der Betreiber koennte dort
  // eigene Angaben stehen haben. Melden statt plattmachen.
  try {
    await fsStat(ziel);
    return { ok: false, vorhanden: true, pfad: ziel,
      grund: `${dateiName} liegt bereits dort - nicht ueberschrieben` };
  } catch { /* gut, gibt es nicht */ }

  try {
    await fsWrite(tmp, `${JSON.stringify(daten, null, 2)}\n`, 'utf8');
    await fsRename(tmp, ziel);
  } catch (err) {
    try { await fsUnlink(tmp); } catch { /* egal */ }
    return { ok: false, grund: `schreiben fehlgeschlagen: ${err.message}` };
  }

  return { ok: true, pfad: ziel };
}

// --- Struktur-Marker je Dienstart ---------------------------------------
//
// Die Marker, die ein uebernommener Dienst haben MUSS. Sie stammen aus
// docs/rack-schema.md §12 und wurden an einer echten ATM-Instanz nachgemessen
// (2026-11-10): startserver.sh, user_jvm_args.txt, mods/,
// libraries/net/neoforged/, server.properties, world/.
//
// Bewusst NICHT enthalten: modrinth.index.json und manifest.json - die gibt
// es in einer ATM11-Installation nicht. Ein Marker, den es nie gibt, macht
// jede Pruefung rot.

export const MARKER = {
  nextcloud: ['docker-compose.yml', 'data'],
  atm11: ['startserver.sh', 'user_jvm_args.txt', 'mods', 'libraries/net/neoforged', 'server.properties', 'world'],
  atm10: ['startserver.sh', 'user_jvm_args.txt', 'mods', 'libraries/net/neoforged', 'server.properties', 'world'],
};

/**
 * Gibt die Marker fuer eine Dienstart - oder null, wenn unbekannt.
 * null heisst: nicht pruefbar. Das darf NIE als "bestanden" zaehlen.
 */
export function markerFuer(rackId) {
  return MARKER[rackId] ?? null;
}
