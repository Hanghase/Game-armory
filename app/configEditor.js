// Game-Armory - Config-Editor
// Liest und schreibt die Haupt-Konfigurationsdatei einer Sword-Instanz.
//
// Unterstuetzte Formate (bewusst schlank, ohne externe Bibliothek):
//   * xml-properties : 7 Days to Die serverconfig.xml (<property name="X" value="Y"/>)
//   * properties     : Minecraft server.properties (key=value)
//
// SICHERHEIT:
//   * Nur der im Sword/Rack deklarierte configFile-Pfad wird angefasst
//     (relativ zur workingDir, kein "..", kein absoluter Pfad).
//   * Vor jedem Schreiben wird ein Backup angelegt (configFile.bak-<ts>).
//   * Werte werden beim Schreiben XML-escaped.

import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// Der Panel-Prozess laeuft als 'armory' und kommt nicht an die Config-Dateien
// der Server-User (600 <server>:<server>). Lesen UND Schreiben laufen daher
// ueber den Install-Helfer, der die Pfad-Whitelist (/opt/*, /var/log/*) prueft.
export const INSTALL_HELPER = '/usr/local/bin/armory-install-helper';

// Fuehrt einen Helfer-Schritt aus; optional wird Inhalt per STDIN uebergeben.
function runHelper(args, input) {
  return new Promise((resolvePromise) => {
    const child = spawn('sudo', ['-n', INSTALL_HELPER, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (err) => resolvePromise({ ok: false, stdout, stderr, error: err.message }));
    child.on('close', (code) => resolvePromise({
      ok: code === 0, stdout, stderr, error: code === 0 ? undefined : `exit ${code}`,
    }));
    if (input !== undefined && input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

// Liest eine Datei ueber den Helfer. Gibt den Inhalt zurueck oder wirft.
async function helperRead(path) {
  const res = await runHelper(['read-file', path]);
  if (!res.ok) throw new Error(res.stderr.trim() || res.error || 'read-file fehlgeschlagen');
  return res.stdout;
}

// Schreibt eine Datei ueber den Helfer und setzt Besitzer/Gruppe auf den Server-User.
async function helperWriteConfig(id, path, content) {
  const res = await runHelper(['write-config', id, path], content);
  if (!res.ok) throw new Error(res.stderr.trim() || res.error || 'write-config fehlgeschlagen');
  return true;
}

// Legt eine Backup-Datei an (Inhalt per STDIN), Eigentuemer = Server-User.
async function helperWriteNew(id, path, content) {
  const res = await runHelper(['write-file', id, path], content);
  if (!res.ok) throw new Error(res.stderr.trim() || res.error || 'write-file fehlgeschlagen');
  return true;
}

export class ConfigEditorError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'ConfigEditorError';
    this.status = status;
  }
}

// --- Felddefinitionen -------------------------------------------------------
// Aus der 7d2d-Recherche (wiki.7d2d.net/game/server-settings-xml/).
// type: text | number | bool | select | password
export const SEVEN_DTD_FIELDS = [
  { key: 'ServerName', label: 'Servername', type: 'text', group: 'Allgemein' },
  { key: 'ServerDescription', label: 'Beschreibung', type: 'text', group: 'Allgemein' },
  { key: 'ServerPassword', label: 'Serverpasswort', type: 'password', group: 'Allgemein' },
  { key: 'ServerMaxPlayerCount', label: 'Max. Spieler', type: 'number', min: 1, max: 64, group: 'Allgemein' },
  { key: 'ServerReservedSlots', label: 'Reservierte Slots', type: 'number', min: 0, max: 64, group: 'Allgemein' },
  { key: 'ServerVisibility', label: 'Sichtbarkeit', type: 'select', options: [
    { value: '0', label: 'Versteckt' }, { value: '1', label: 'Nur Freunde' }, { value: '2', label: 'Öffentlich' },
  ], group: 'Allgemein' },
  { key: 'ServerPort', label: 'Spielport', type: 'number', min: 1024, max: 65535, group: 'Netzwerk' },
  { key: 'TelnetEnabled', label: 'Telnet aktiv', type: 'bool', group: 'Netzwerk' },
  { key: 'TelnetPort', label: 'Telnet-Port', type: 'number', min: 1024, max: 65535, group: 'Netzwerk' },
  { key: 'TelnetPassword', label: 'Telnet-Passwort', type: 'password', group: 'Netzwerk' },
  { key: 'ControlPanelEnabled', label: 'Web-Panel aktiv', type: 'bool', group: 'Netzwerk' },
  { key: 'ControlPanelPort', label: 'Web-Panel-Port', type: 'number', min: 1024, max: 65535, group: 'Netzwerk' },
  { key: 'ControlPanelPassword', label: 'Web-Panel-Passwort', type: 'password', group: 'Netzwerk' },
  { key: 'EACEnabled', label: 'Easy Anti-Cheat', type: 'bool', group: 'Netzwerk' },
  { key: 'GameWorld', label: 'Welt', type: 'text', group: 'Welt' },
  { key: 'WorldGenSeed', label: 'Welt-Seed', type: 'text', group: 'Welt' },
  { key: 'WorldGenSize', label: 'Weltgröße', type: 'number', min: 2048, max: 16384, group: 'Welt' },
  { key: 'GameName', label: 'Spielname', type: 'text', group: 'Welt' },
  { key: 'GameDifficulty', label: 'Schwierigkeit', type: 'number', min: 0, max: 5, group: 'Gameplay' },
  { key: 'DayNightLength', label: 'Tageslänge (Min)', type: 'number', min: 10, max: 240, group: 'Gameplay' },
  { key: 'DayLightLength', label: 'Tageslicht (Std)', type: 'number', min: 0, max: 24, group: 'Gameplay' },
  { key: 'BloodMoonFrequency', label: 'Blood Moon alle X Tage', type: 'number', min: 0, max: 30, group: 'Gameplay' },
  { key: 'BloodMoonEnemyCount', label: 'Blood-Moon-Gegner', type: 'number', min: 1, max: 64, group: 'Gameplay' },
  { key: 'LootAbundance', label: 'Loot-Menge (%)', type: 'number', min: 10, max: 500, group: 'Gameplay' },
  { key: 'LootRespawnDays', label: 'Loot-Respawn (Tage)', type: 'number', min: 1, max: 90, group: 'Gameplay' },
  { key: 'AirDropFrequency', label: 'Airdrop alle X Std', type: 'number', min: 0, max: 240, group: 'Gameplay' },
  { key: 'XPMultiplier', label: 'XP-Multiplikator (%)', type: 'number', min: 10, max: 500, group: 'Gameplay' },
  { key: 'DropOnDeath', label: 'Drop bei Tod', type: 'select', options: [
    { value: '0', label: 'Nichts' }, { value: '1', label: 'Alles' }, { value: '2', label: 'Nur Werkzeuge' },
    { value: '3', label: 'Nur Rucksack' }, { value: '4', label: 'Alles löschen' },
  ], group: 'Gameplay' },
  { key: 'PlayerKillingMode', label: 'Spieler-töten', type: 'select', options: [
    { value: '0', label: 'Aus (PVE)' }, { value: '1', label: 'Nur Allies' },
    { value: '2', label: 'Nur Admins' }, { value: '3', label: 'Alle (PVP)' },
  ], group: 'Gameplay' },
  { key: 'EnemySpawnMode', label: 'Gegner spawnen', type: 'bool', group: 'Gameplay' },
  { key: 'MaxSpawnedZombies', label: 'Max. Zombies (Performance)', type: 'number', min: 8, max: 200, group: 'Performance' },
  { key: 'MaxSpawnedAnimals', label: 'Max. Tiere (Performance)', type: 'number', min: 0, max: 200, group: 'Performance' },
  { key: 'ServerMaxAllowedViewDistance', label: 'Max. Sichtweite', type: 'number', min: 4, max: 12, group: 'Performance' },
];

// Aus der echten server.properties (Vanilla/ATM10) abgeleitet. Bewusst ohne
// rcon.password & Konsorten - Secrets gehoeren NICHT ins Formular.
export const MINECRAFT_FIELDS = [
  { key: 'motd', label: 'MOTD (Serverliste)', type: 'text', group: 'Allgemein' },
  { key: 'max-players', label: 'Max. Spieler', type: 'number', min: 1, max: 200, group: 'Allgemein' },
  { key: 'difficulty', label: 'Schwierigkeit', type: 'select', options: [
    { value: 'peaceful', label: 'Friedlich' }, { value: 'easy', label: 'Einfach' },
    { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Schwer' },
  ], group: 'Allgemein' },
  { key: 'gamemode', label: 'Spielmodus', type: 'select', options: [
    { value: 'survival', label: 'Überleben' }, { value: 'creative', label: 'Kreativ' },
    { value: 'adventure', label: 'Abenteuer' }, { value: 'spectator', label: 'Zuschauer' },
  ], group: 'Allgemein' },
  { key: 'hardcore', label: 'Hardcore', type: 'bool', group: 'Allgemein' },
  { key: 'white-list', label: 'Whitelist aktiv', type: 'bool', group: 'Allgemein' },
  { key: 'enforce-whitelist', label: 'Whitelist erzwingen', type: 'bool', group: 'Allgemein' },
  { key: 'pvp', label: 'PvP', type: 'bool', group: 'Allgemein' },
  { key: 'allow-flight', label: 'Fliegen erlaubt', type: 'bool', group: 'Allgemein' },
  { key: 'allow-nether', label: 'Nether erlaubt', type: 'bool', group: 'Allgemein' },
  { key: 'online-mode', label: 'Online-Mode (Auth)', type: 'bool', group: 'Sicherheit' },
  { key: 'enforce-secure-profile', label: 'Sichere Profile erzwingen', type: 'bool', group: 'Sicherheit' },
  { key: 'prevent-proxy-connections', label: 'Proxy-Verbindungen blocken', type: 'bool', group: 'Sicherheit' },
  { key: 'spawn-protection', label: 'Spawn-Schutz (Blöcke)', type: 'number', min: 0, max: 1000, group: 'Sicherheit' },
  { key: 'op-permission-level', label: 'OP-Berechtigungsstufe', type: 'number', min: 1, max: 4, group: 'Sicherheit' },
  { key: 'level-seed', label: 'Welt-Seed', type: 'text', group: 'Welt' },
  { key: 'level-name', label: 'Weltname', type: 'text', group: 'Welt' },
  { key: 'level-type', label: 'Welt-Typ', type: 'text', group: 'Welt' },
  { key: 'generator-settings', label: 'Generator-Einstellungen (JSON)', type: 'text', group: 'Welt' },
  { key: 'generate-structures', label: 'Strukturen erzeugen', type: 'bool', group: 'Welt' },
  { key: 'max-world-size', label: 'Max. Weltgröße (Blocks)', type: 'number', min: 1, max: 29999984, group: 'Welt' },
  { key: 'spawn-animals', label: 'Tiere spawnen', type: 'bool', group: 'Welt' },
  { key: 'spawn-monsters', label: 'Monster spawnen', type: 'bool', group: 'Welt' },
  { key: 'spawn-npcs', label: 'NPCs spawnen', type: 'bool', group: 'Welt' },
  { key: 'view-distance', label: 'Sichtweite (Chunks)', type: 'number', min: 3, max: 32, group: 'Performance' },
  { key: 'simulation-distance', label: 'Simulationsweite (Chunks)', type: 'number', min: 3, max: 32, group: 'Performance' },
  { key: 'max-tick-time', label: 'Max. Tick-Zeit (ms)', type: 'number', min: -1, max: 600000, group: 'Performance' },
  { key: 'entity-broadcast-range-percentage', label: 'Entity-Broadcast (%)', type: 'number', min: 10, max: 1000, group: 'Performance' },
  { key: 'network-compression-threshold', label: 'Netzwerk-Kompression', type: 'number', min: -1, max: 65535, group: 'Performance' },
  { key: 'player-idle-timeout', label: 'Idle-Timeout (Min, 0=aus)', type: 'number', min: 0, max: 1440, group: 'Performance' },
  { key: 'sync-chunk-writes', label: 'Chunk-Writes synchron', type: 'bool', group: 'Performance' },
  { key: 'use-native-transport', label: 'Native Transport (Linux)', type: 'bool', group: 'Performance' },
  { key: 'server-port', label: 'Spielport', type: 'number', min: 1024, max: 65535, group: 'Netzwerk' },
  { key: 'server-ip', label: 'Server-IP (leer = alle)', type: 'text', group: 'Netzwerk' },
  { key: 'enable-status', label: 'Serverliste-Status', type: 'bool', group: 'Netzwerk' },
  { key: 'hide-online-players', label: 'Spielerliste verbergen', type: 'bool', group: 'Netzwerk' },
  { key: 'enable-query', label: 'Query aktiv', type: 'bool', group: 'Netzwerk' },
  { key: 'query.port', label: 'Query-Port', type: 'number', min: 1024, max: 65535, group: 'Netzwerk' },
  { key: 'enable-rcon', label: 'RCON aktiv', type: 'bool', group: 'Netzwerk' },
  { key: 'rcon.port', label: 'RCON-Port', type: 'number', min: 1024, max: 65535, group: 'Netzwerk' },
  { key: 'enable-command-block', label: 'Command-Blocks', type: 'bool', group: 'Gameplay' },
  { key: 'force-gamemode', label: 'Gamemode erzwingen', type: 'bool', group: 'Gameplay' },
  { key: 'broadcast-console-to-ops', label: 'Konsole an OPs', type: 'bool', group: 'Gameplay' },
  { key: 'broadcast-rcon-to-ops', label: 'RCON an OPs', type: 'bool', group: 'Gameplay' },
  { key: 'function-permission-level', label: 'Funktions-Berechtigung', type: 'number', min: 1, max: 4, group: 'Gameplay' },
  { key: 'require-resource-pack', label: 'Resource-Pack erzwingen', type: 'bool', group: 'Ressourcen' },
  { key: 'resource-pack', label: 'Resource-Pack URL', type: 'text', group: 'Ressourcen' },
  { key: 'resource-pack-prompt', label: 'Resource-Pack Hinweis', type: 'text', group: 'Ressourcen' },
  { key: 'resource-pack-sha1', label: 'Resource-Pack SHA1', type: 'text', group: 'Ressourcen' },
];

const FIELDS_BY_GAME = {
  '7d2d': { format: 'xml-properties', fields: SEVEN_DTD_FIELDS },
  'minecraft': { format: 'properties', fields: MINECRAFT_FIELDS },
};

// --- Pfad-Aufloesung --------------------------------------------------------

// Loest den Config-Pfad sicher auf: relativ zur workingDir, kein "..", kein absoluter Pfad.
export function resolveConfigPath(workingDir, configFile) {
  if (!workingDir || !configFile) {
    throw new ConfigEditorError('workingDir und configFile erforderlich');
  }
  if (configFile.startsWith('/') || configFile.includes('..')) {
    throw new ConfigEditorError(`Ungueltiger configFile-Pfad: ${configFile}`);
  }
  const full = resolve(join(workingDir, configFile));
  if (!full.startsWith(resolve(workingDir) + '/')) {
    throw new ConfigEditorError('Config-Pfad verlaesst das Arbeitsverzeichnis');
  }
  return full;
}

// --- XML-Properties (7d2d) --------------------------------------------------

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Liest alle <property name="X" value="Y" .../>-Eintraege als { X: Y }.
export function parseXmlProperties(xml) {
  const out = {};
  const re = /<property\s+name="([^"]+)"\s+value="([^"]*)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    out[m[1]] = m[2]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  }
  return out;
}

// Schreibt Werte in eine XML-Properties-Datei: vorhandene Eintraege werden ersetzt,
// fehlende vor </ServerSettings> ergaenzt. Andere Zeilen bleiben unberuehrt.
export function applyXmlProperties(xml, values) {
  let result = xml;
  let changed = 0;
  for (const [key, value] of Object.entries(values)) {
    const esc = xmlEscape(value);
    const re = new RegExp(`(<property\\s+name="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+value=")[^"]*(")`, 'g');
    if (re.test(result)) {
      result = result.replace(re, `$1${esc}$2`);
      changed++;
    } else {
      const insert = `    <property name="${key}" value="${esc}"/>\n`;
      if (/<\/ServerSettings>/.test(result)) {
        result = result.replace(/<\/ServerSettings>/, insert + '  </ServerSettings>');
      } else {
        result += '\n' + insert;
      }
      changed++;
    }
  }
  return { xml: result, changed };
}

// --- Minecraft: server.properties (key=value) -------------------------------
// Format: eine Zeile pro Key, '#'-Zeilen sind Kommentare, Leerzeilen bleiben.
// Wir fassen beim Schreiben NUR die Key-Zeilen an - Reihenfolge, Kommentare
// und unbekannte Keys bleiben unveraendert (Minecraft schreibt selbst neu).
export function parseProperties(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === '') continue;
    out[key] = line.slice(eq + 1);
  }
  return out;
}

// Setzt Werte in eine properties-Datei. Vorhandene Keys werden in-place
// ersetzt, fehlende am Ende ergaenzt. Rueckgabe: { text, changed }.
export function applyProperties(text, values) {
  const lines = String(text).split(/\r?\n/);
  const used = new Set();
  let changed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in values) || used.has(key)) continue;
    lines[i] = `${key}=${values[key]}`;
    used.add(key);
    changed++;
  }

  // Fehlende Keys anhaengen (in der Reihenfolge der Eingabe).
  for (const [key, value] of Object.entries(values)) {
    if (used.has(key)) continue;
    lines.push(`${key}=${value}`);
    used.add(key);
    changed++;
  }
  let result = lines.join('\n');
  if (!result.endsWith('\n')) result += '\n';
  return { text: result, changed };
}

// --- Oeffentliche API -------------------------------------------------------

// Liefert Felddefinitionen + aktuelle Werte fuer eine Instanz.
export async function readConfig({ game, workingDir, configFile }) {
  const spec = FIELDS_BY_GAME[game];
  if (!spec) throw new ConfigEditorError(`Kein Config-Editor fuer Spiel: ${game}`);
  const path = resolveConfigPath(workingDir, configFile);
  let raw;
  try {
    raw = await helperRead(path);
  } catch (err) {
    throw new ConfigEditorError(`Config nicht lesbar (${path}): ${err.message}`);
  }
  const values = spec.format === 'xml-properties'
    ? parseXmlProperties(raw)
    : (spec.format === 'properties' ? parseProperties(raw) : {});
  return {
    path,
    format: spec.format,
    fields: spec.fields.map((f) => ({ ...f, value: values[f.key] ?? null })),
    knownKeys: Object.keys(values),
  };
}

// Schreibt geaenderte Werte; legt vorher ein Backup an.
export async function writeConfig({ id, game, workingDir, configFile, values, backup = true }) {
  const spec = FIELDS_BY_GAME[game];
  if (!spec) throw new ConfigEditorError(`Kein Config-Editor fuer Spiel: ${game}`);
  if (values === null || typeof values !== 'object') {
    throw new ConfigEditorError('values muss ein Objekt sein');
  }
  // Der Helfer validiert die ID streng (^[a-z0-9][a-z0-9_-]{1,31}$). Ohne ID
  // kann er Besitzer/Gruppe nicht korrekt setzen - daher Pflicht.
  if (!id || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id)) {
    throw new ConfigEditorError(`Ungueltige bzw. fehlende Sword-ID fuer Config-Schreibzugriff: ${id}`);
  }
  const path = resolveConfigPath(workingDir, configFile);
  let raw;
  try {
    raw = await helperRead(path);
  } catch (err) {
    throw new ConfigEditorError(`Config nicht lesbar (${path}): ${err.message}`);
  }

  // Nur bekannte Felder + Werte als Strings (keine Objekte/Arrays).
  const allowed = new Set(spec.fields.map((f) => f.key));
  const clean = {};
  for (const [k, v] of Object.entries(values)) {
    if (!allowed.has(k)) continue;             // unbekannte Keys ignorieren
    if (v === null || v === undefined) continue;
    clean[k] = String(v);
  }
  if (Object.keys(clean).length === 0) {
    throw new ConfigEditorError('Keine bekannten Felder zum Speichern uebergeben');
  }

  let backupPath = null;
  if (backup) {
    backupPath = `${path}.bak-${Date.now()}`;
    try {
      await helperWriteNew(id, backupPath, raw);
    } catch (err) {
      throw new ConfigEditorError(`Backup konnte nicht angelegt werden (${backupPath}): ${err.message}`);
    }
  }

  const applied = spec.format === 'xml-properties'
    ? { text: applyXmlProperties(raw, clean).xml, changed: applyXmlProperties(raw, clean).changed }
    : applyProperties(raw, clean);

  // Echte Aenderung ermitteln: 'applied.changed' zaehlt nur GESCHRIEBENE Felder,
  // nicht Felder, deren Wert wirklich anders ist. Fuer die Frage "Neustart
  // noetig?" zaehlt nur die inhaltliche Aenderung. Deshalb alten Stand aus
  // 'raw' parsen und mit den neuen Werten vergleichen.
  const before = spec.format === 'xml-properties' ? parseXmlProperties(raw) : parseProperties(raw);
  const reallyChanged = Object.entries(clean).filter(([k, v]) => before[k] !== v).map(([k]) => k);

  try {
    await helperWriteConfig(id, path, applied.text);
  } catch (err) {
    throw new ConfigEditorError(`Config nicht schreibbar (${path}): ${err.message}`);
  }
  return {
    path,
    backupPath,
    changedFields: Object.keys(clean),
    changed: applied.changed,
    reallyChangedFields: reallyChanged,
    reallyChanged: reallyChanged.length,
  };
}

export function getEditorFields(game) {
  const spec = FIELDS_BY_GAME[game];
  if (!spec) throw new ConfigEditorError(`Kein Config-Editor fuer Spiel: ${game}`);
  return spec.fields;
}

export const SUPPORTED_GAMES = Object.keys(FIELDS_BY_GAME);
