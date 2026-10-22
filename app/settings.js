// Game-Armory - Settings
// Persistente Einstellungen (z.B. CurseForge-API-Key) in der Armory-DB.
// Der API-Key wird NIE im Klartext an das Frontend ausgeliefert; die API
// liefert nur, OB ein Key gesetzt ist, plus eine maskierte Vorschau.

import Database from 'better-sqlite3';

const DB_PATH = '/opt/game-armory/data/armory.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// Erlaubte Settings-Schluessel (Whitelist - nie beliebige Keys schreiben).
// steam_username/steam_password: OPTIONALER Steam-Login fuer SteamCMD-Installationen.
// Ist nichts gesetzt, wird 'login anonymous' verwendet (reicht fuer 7d2d).
// Das Passwort wird nie im Klartext ans Frontend geliefert (siehe maskSecret).
export const SETTING_KEYS = [
  'curseforge_api_key',
  'steam_username',
  'steam_password',
  // JSON-Array der Rack-IDs, die in der Sidebar angezeigt werden.
  // Leer/null = alle Racks anzeigen (Default).
  'sidebar_racks',
  // Brute-Force-Schutz (nur Admin einstellbar). Zahlen als Strings in der DB;
  // getLoginGuardConfig() liefert sie typisiert mit Defaults zurueck.
  'login_max_fails',      // Fehlversuche bis zur Sperre
  'login_window_minutes', // Beobachtungsfenster (findtime)
  'login_ban_minutes',    // Sperrdauer (bannzeit)
  // --- SMTP (Superuser): Versand von Passwort-Reset-, Einladungs- und Testmails.
  // Jeder Betreiber hinterlegt seine EIGENEN Zugangsdaten (Ionos, Brevo, eigener
  // Server - alles was SMTP spricht). smtp_pass ist ein Secret: es wird NIE im
  // Klartext ausgeliefert (maskSecret), nur {set, preview}.
  'smtp_host',
  'smtp_port',
  'smtp_secure',       // 'true' = implizites TLS (465); 'false' = STARTTLS (587)
  'smtp_user',
  'smtp_pass',         // Secret
  'smtp_from_name',
  'smtp_from_address',
  'smtp_enabled',      // 'true' | 'false' - Master-Schalter
  // Versions-Gegenprobe (2026-10-18): Wie oft soll das Panel pruefen, ob eine
  // neuere Version verfuegbar ist? 0 = nur manuell (Button). Sonst Minuten.
  'version_check_minutes',
  // Selbst-Update-Gegenprobe (2026-10-19): Wie oft soll die Armory selbst
  // pruefen, ob ein neuerer Tag verfuegbar ist? 0 = nur manuell.
  // Default 1440 = einmal am Tag, rollierend ab dem letzten Lauf.
  'self_update_check_minutes',
  // Ergebnis der letzten Selbst-Update-Pruefung (Zustand fuer den Header-Badge).
  'self_update_state',
  // IPs, die nie gesperrt werden (kommagetrennt). Leer = nur 127.0.0.1/::1.
  // Gehoert in die Einstellung, nicht in den Code: eine IP verraet,
  // welche Maschine das Panel betreibt.
  'login_whitelist',
];

// Numerische Settings mit Default und erlaubtem Bereich. Alles andere in
// SETTING_KEYS bleibt String/Secret. Wird von getLoginGuardConfig() genutzt.
// ECHTE Geheimnisse - nur diese werden maskiert ausgeliefert.
// Alles andere in SETTING_KEYS (Host, Port, User, Absender, Schalter, Rack-Auswahl)
// ist Konfiguration, kein Secret, und muss im Formular lesbar sein.
// 2026-10-22: smtp_user ergaenzt (Benutzername verraet das Mail-Konto).
export const SECRET_KEYS = new Set([
  'curseforge_api_key',
  'steam_password',
  'smtp_pass',
  'smtp_user',
]);

export const NUMERIC_SETTINGS = {
  login_max_fails:      { default: 5,  min: 1, max: 100 },
  login_window_minutes: { default: 10, min: 1, max: 1440 },
  login_ban_minutes:    { default: 15, min: 1, max: 10080 },
  // 0 = nur manuell pruefen (kein Hintergrund-Timer). 60 = stuendlich.
  // Default 0: niemand wird ohne Zutun mit fremden Abfragen belastet.
  version_check_minutes: { default: 0, min: 0, max: 1440 },
  // Default 1440 = einmal am Tag. Rollierend, keine feste Uhrzeit.
  self_update_check_minutes: { default: 1440, min: 0, max: 10080 },
};

// Liest eine numerische Einstellung typisiert; ungueltig/leer -> Default.
export function getNumericSetting(key) {
  const spec = NUMERIC_SETTINGS[key];
  if (!spec) throw new Error(`Kein numerisches Setting: ${key}`);
  const raw = getSetting(key);
  if (raw === null) return spec.default;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < spec.min || n > spec.max) return spec.default;
  return n;
}

// Komplette Bruteforce-Konfiguration fuer die Login-Pruefung.
export function getLoginGuardConfig() {
  return {
    maxFails:  getNumericSetting('login_max_fails'),
    windowMs:  getNumericSetting('login_window_minutes') * 60_000,
    banMs:     getNumericSetting('login_ban_minutes') * 60_000,
  };
}

export function getSetting(key) {
  if (!SETTING_KEYS.includes(key)) throw new Error(`Unbekanntes Setting: ${key}`);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  if (!SETTING_KEYS.includes(key)) throw new Error(`Unbekanntes Setting: ${key}`);
  if (value === null || value === undefined || String(value).trim() === '') {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  // Numerische Settings hart gegen ihren erlaubten Bereich pruefen: sonst
  // landet z.B. eine negative Minutenangabe in der DB und der Timer spinnt.
  const numSpec = NUMERIC_SETTINGS[key];
  if (numSpec) {
    const n = Number.parseInt(String(value).trim(), 10);
    if (!Number.isFinite(n) || n < numSpec.min || n > numSpec.max) {
      throw new Error(`${key} muss zwischen ${numSpec.min} und ${numSpec.max} liegen`);
    }
  }
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value).trim(), Date.now());
}

// Sidebar-Auswahl. Rueckgabe:
//   { initialized: false, ids: null }  -> noch nie gewaehlt (Erststart)
//   { initialized: true,  ids: null }  -> bewusst "alle"
//   { initialized: true,  ids: [...] } -> konkrete Auswahl
// Der Unterschied ist wichtig: beim Erststart leiten wir eine sinnvolle
// Startauswahl ab (Racks mit Servern); danach respektieren wir die Wahl.
export function getSidebarRacks() {
  const raw = getSetting('sidebar_racks');
  if (!raw) return { initialized: false, ids: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const ids = parsed.ids === null ? null
        : Array.isArray(parsed.ids) ? parsed.ids.filter((x) => typeof x === 'string') : null;
      return { initialized: true, ids };
    }
    // Altes Format (nacktes Array) - als initialisierte Auswahl uebernehmen.
    if (Array.isArray(parsed)) return { initialized: true, ids: parsed.filter((x) => typeof x === 'string') };
  } catch {
    /* ungueltig -> wie uninitialisiert behandeln */
  }
  return { initialized: false, ids: null };
}

export function setSidebarRacks(ids) {
  const payload = { initialized: true, ids: ids === null ? null
    : [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string'))] };
  setSetting('sidebar_racks', JSON.stringify(payload));
  return payload.ids;
}

// Maskierte Vorschau fuer das Frontend: nur letzte 4 Zeichen sichtbar.
export function maskSecret(value) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 4) return '••••';
  return `••••${s.slice(-4)}`;
}

// Status fuer die Settings-Seite. Secrets: nur {set, preview} (kein Klartext!).
// Numerische Settings: {value, default, min, max} - sie sind kein Geheimnis und
// muessen im Admin-Formular editierbar sein.
export function getSettingsStatus() {
  const out = {};
  for (const key of SETTING_KEYS) {
    const spec = NUMERIC_SETTINGS[key];
    if (spec) {
      const raw = getSetting(key);
      out[key] = {
        numeric: true,
        value: getNumericSetting(key),
        isDefault: raw === null,
        default: spec.default,
        min: spec.min,
        max: spec.max,
      };
      continue;
    }
    const v = getSetting(key);
    if (SECRET_KEYS.has(key)) {
      out[key] = { set: Boolean(v), preview: maskSecret(v) };
    } else {
      // Konfigurationswert (kein Secret): im Klartext, damit das Formular
      // die gespeicherte Konfiguration wirklich anzeigen kann.
      out[key] = { set: Boolean(v), value: v ?? '' };
    }
  }
  return out;
}
