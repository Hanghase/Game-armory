// Game-Armory - Rechte-Matrix 2.0 (Stufe 1: Fundament)
// NAMENTLICHE Rechte statt harter Rang-Vergleiche. Die Zuordnung Rolle -> Recht
// liegt in der DB und ist spaeter pro Rolle editierbar.
//
// WICHTIG (Stufe 1): Das VERHALTEN aendert sich NICHT. Die Startbelegung ist so
// gewaehlt, dass sie exakt die alte requireRole-Leiter abbildet (Migration erbt
// die alte Leiter). Erst Stufe 2 stellt die Routen auf requirePerm um.
//
// Der superuser ist FIX: er hat IMMER alle Rechte, unabhaengig vom DB-Inhalt.
// Das schuetzt vor Selbst-Aussperrung (jemand entzieht superuser ein Recht).
//
// Import-Graph: permissions.js importiert NICHTS aus auth.js (kein Circular-
// Import). auth.js importiert roleHasPerm/loadPermissions von hier.

import Database from 'better-sqlite3';

const DB_PATH = '/opt/game-armory/data/armory.db';

// Eigene DB-Verbindung (better-sqlite3 ist synchron; WAL erlaubt mehrere
// Verbindungen im selben Prozess problemlos).
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// --- Rechte-Katalog (verbindlich, exakt diese Namen) -----------------------
// {perm, label, group} fuer die spaetere UI.
export const PERMISSIONS = [
  // Kontroll-Aktionen
  { perm: 'sword.control.start',    label: 'Server starten',            group: 'Kontroll-Aktionen' },
  { perm: 'sword.control.stop',     label: 'Server stoppen',            group: 'Kontroll-Aktionen' },
  { perm: 'sword.control.restart',  label: 'Server neu starten',        group: 'Kontroll-Aktionen' },
  // Config/Konsole
  { perm: 'sword.config.read',      label: 'Config lesen',              group: 'Config & Konsole' },
  { perm: 'sword.config.write',     label: 'Config schreiben',          group: 'Config & Konsole' },
  { perm: 'sword.console.read',     label: 'Live-Konsole lesen',        group: 'Config & Konsole' },
  // Sword-Lebenszyklus
  { perm: 'sword.upload',           label: 'Sword-Dateien hochladen',    group: 'Sword-Lebenszyklus' },
  { perm: 'sword.create',           label: 'Sword installieren',         group: 'Sword-Lebenszyklus' },
  { perm: 'sword.delete',           label: 'Sword loeschen',            group: 'Sword-Lebenszyklus' },
  { perm: 'sword.update',           label: 'Sword aktualisieren',       group: 'Sword-Lebenszyklus' },
  { perm: 'sword.eula',             label: 'EULA akzeptieren',          group: 'Sword-Lebenszyklus' },
  { perm: 'sword.restart_marker',   label: 'Neustart-Merker setzen',    group: 'Sword-Lebenszyklus' },
  // Racks
  { perm: 'rack.read',              label: 'Racks lesen',               group: 'Racks' },
  { perm: 'rack.create',            label: 'Racks anlegen',             group: 'Racks' },
  // Eigener Recht fuer Aenderungen an bestehenden Racks. Vorher hing PUT /racks/:id
  // am Anlegen-Recht - wer anlegen durfte, konnte auch bestehende Racks umbiegen
  // (root, startScript). Seit 2026-10-22 getrennt.
  { perm: 'rack.edit',              label: 'Racks bearbeiten',          group: 'Racks' },
  { perm: 'rack.delete',            label: 'Racks loeschen',            group: 'Racks' },
  { perm: 'rack.sidebar.write',     label: 'Sidebar-Racks bearbeiten',  group: 'Racks' },
  { perm: 'rack.reload',            label: 'Racks neu laden',           group: 'Racks' },
  // Einstellungen/System
  { perm: 'settings.read',          label: 'Einstellungen lesen',       group: 'Einstellungen & System' },
  { perm: 'settings.write',         label: 'Einstellungen schreiben',   group: 'Einstellungen & System' },
  { perm: 'settings.test_mail',     label: 'Test-Mail senden',          group: 'Einstellungen & System' },
  { perm: 'system.diagnostics',     label: 'Diagnose abrufen',          group: 'Einstellungen & System' },
  // Nutzer
  { perm: 'user.read',              label: 'Nutzer lesen',              group: 'Nutzer' },
  { perm: 'user.create',            label: 'Nutzer anlegen',            group: 'Nutzer' },
  { perm: 'user.delete',            label: 'Nutzer loeschen',           group: 'Nutzer' },
  { perm: 'user.role',              label: 'Rolle aendern',             group: 'Nutzer' },
  { perm: 'user.password',          label: 'Passwort setzen',           group: 'Nutzer' },
  { perm: 'user.email',             label: 'E-Mail hinterlegen',        group: 'Nutzer' },
];

// Schnelle Lookup-Struktur fuer unbekannte Rechte-Pruefung.
const PERM_NAMES = PERMISSIONS.map((p) => p.perm);
const PERM_SET = new Set(PERM_NAMES);

// --- Rollen ----------------------------------------------------------------
// Reihenfolge/Ableitung aus der alten requireRole-Leiter.
// level dient nur als stabile Sortierung/Anzeige; die Rechte stehen in der Matrix.
export const ROLES = ['strangerdanger', 'friend', 'moderator', 'admin', 'superuser'];
export const ROLE_LEVEL = { strangerdanger: 0, friend: 1, moderator: 2, admin: 3, superuser: 4 };

// Fixe Rollen: NICHT editierbar, haben IMMER alle Rechte (Schutz vor Lockout).
const FIXED_ROLES = new Set(['superuser']);

// --- Startbelegung (erbt die alte Leiter) ----------------------------------
// Pro Rolle die erlaubten Rechte. Nur was hier steht, wird migriert.
const MODERATOR_PERMS = [
  // Wer stoppen und neu starten darf, darf auch starten - sonst bleibt ein
  // gestoppter Server fuer diese Rolle liegen.
  'sword.control.start',
  'sword.control.stop',
  'sword.control.restart',
  'sword.config.read',
  'sword.config.write',
  'sword.restart_marker',
  'sword.update',
  'sword.upload',       // Nur Upload (POST/GET/DELETE /uploads) - NICHT das echte Installieren!
  'sword.console.read', // Live-Konsole: heute ab Level 1 (friend) erlaubt -> siehe friend
  'rack.read',
];

const ADMIN_PERMS = [
  ...MODERATOR_PERMS,
  'sword.create',       // ECHTES Anlegen (POST /installs) - heute requireRole('admin')
  'system.diagnostics',
  'rack.create',        // Rack anlegen - seit 2026-10-22 getrennt von rack.edit
  'rack.edit',          // Bestehende Racks aendern (PUT /racks/:id)
  'rack.delete',        // Rack loeschen - heute implizit admin (kein Recht in der Leiter)
  'rack.sidebar.write',
  'rack.reload',
  'sword.delete',
  'sword.eula',
  'user.email',         // E-Mail eines Nutzers setzen (Reset-Ziel)
];

// superuser: ALLES (wird hier nur zur Vollstaendigkeit/Doku gelistet; der
// Check liefert fuer superuser ohnehin IMMER true).
const SUPERUSER_PERMS = PERM_NAMES.slice();

export const DEFAULT_MATRIX = {
  strangerdanger: [],                                                  // nur Basis-Zugriff, KEIN Katalog-Recht
  friend:         ['sword.control.start', 'sword.console.read'],       // darf starten UND zuschauen (heute Level 1+)
  moderator:      MODERATOR_PERMS,
  admin:          ADMIN_PERMS,
  superuser:      SUPERUSER_PERMS,
};

// Seed-Version: erhoehen, wenn sich DEFAULT_MATRIX/Katalog aendert. Beim Start
// wird eine aeltere DB-Version deterministisch auf diese Soll-Belegung
// nachgezogen - aber NUR fuer Seed-Zeilen (Betreiber-Aenderungen bleiben).
export const PERMISSIONS_SEED_VERSION = 5;

// --- Migration / Init (deterministisch, selbstheilend, idempotent) ---------
// Mechanismus (Begruendung):
//   * meta-Tabelle haelt EIN Seed-Kennzeichen ('permissions_seed_version').
//     Daraus erkennt der Start, ob die DB neu/leer ist, eine aeltere Soll-
//     Belegung traegt oder schon aktuell ist.
//   * role_permissions bekommt eine Spalte `source` ('seed' | 'user'):
//       - 'seed' = vom System aus DEFAULT_MATRIX gesetzt. Ein Re-Seed DARF
//         diese Zeile anpassen (so werden geaenderte Katalog-/Matrix-Defaults
//         beim Versionssprung korrekt nachgezogen).
//       - 'user' = per setPermission vom Betreiber gesetzt. Ein Re-Seed darf
//         sie NIE ueberschreiben (sonst gingen Admin-Entscheidungen verloren).
//   * Idempotenz: laeuft die Version bereits, passiert NICHTS (kein Schreiben).
//
// Damit bleibt ein Erstinstall exakt auf Soll, der Bestandsfall divergiert
// nicht mehr, und Betreiber-Aenderungen sind dauerhaft geschuetzt.

let loaded = false;

function getSeedVersion() {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'permissions_seed_version'`).get();
  return row ? Number(row.value) : null;
}

function setSeedVersion(v) {
  db.prepare(`INSERT INTO meta (key, value) VALUES ('permissions_seed_version', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(v));
}

export function loadPermissions() {
  db.exec(`
    -- Schluessel/Wert-Ablage (u.a. Seed-Version).
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Rolle -> Recht -> erlaubt(0/1). Primaerschluessel verhindert Duplikate.
    -- source: 'seed' (aus DEFAULT_MATRIX) oder 'user' (Betreiber via setPermission).
    CREATE TABLE IF NOT EXISTS role_permissions (
      role TEXT NOT NULL,
      perm TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'seed',
      PRIMARY KEY (role, perm)
    );
    -- Rolle -> editierbar + Level. Fixe Rollen (superuser) sind nicht editierbar.
    CREATE TABLE IF NOT EXISTS roles_config (
      role TEXT PRIMARY KEY,
      editable INTEGER NOT NULL DEFAULT 1,
      level INTEGER NOT NULL
    );
  `);

  // Bestands-DB ohne source-Spalte: Spalte ergaenzen. Alte Zeilen stammen aus
  // dem Seed des ersten Laufs -> Default 'seed' (korrekt fuer die Migration).
  const cols = db.prepare('PRAGMA table_info(role_permissions)').all().map((c) => c.name);
  if (!cols.includes('source')) {
    db.exec(`ALTER TABLE role_permissions ADD COLUMN source TEXT NOT NULL DEFAULT 'seed'`);
  }

  // Ist die Soll-Belegung bereits eingespielt? Dann nichts tun (idempotent).
  const dbVersion = getSeedVersion();
  if (dbVersion === PERMISSIONS_SEED_VERSION) {
    loaded = true;
    return true;
  }

  // Audit-Fix 2026-10-30 (D123): Eine NEUERE Datenbankversion darf nie
  // zurueckgebaut werden. Vorher wurde nur auf Gleichheit geprueft - stand in der
  // DB eine 7 und der Code kennt nur 5 (nach einem Downgrade), lief der Seed
  // erneut und setzte die Matrix still auf den alten Stand. Betreiber-Aenderungen
  // an Rechten gingen dabei verloren, ohne Warnung.
  if (typeof dbVersion === 'number' && dbVersion > PERMISSIONS_SEED_VERSION) {
    console.error(
      `[permissions] Datenbank hat Seed-Version ${dbVersion}, der Code kennt nur `
        + `${PERMISSIONS_SEED_VERSION}. Die Rechte-Matrix wird NICHT zurueckgebaut - `
        + 'bitte die neuere Armory-Version verwenden.',
    );
    loaded = true;
    return false;
  }

  // "Frische DB" = die Matrix ist wirklich LEER. NICHT an der meta-Zeile
  // festmachen: eine Bestands-DB aus der Vorversion hat zwar (noch) keine
  // Seed-Version, aber 120 Zeilen. Wuerde man dbVersion===null als "frisch"
  // deuten, liefe ein INSERT OR IGNORE ueber diese Zeilen und wuerde NICHTS
  // korrigieren (genau der Divergenz-Bug). Deshalb zaehlt der Zeilenstand.
  const rowCount = db.prepare('SELECT COUNT(*) AS n FROM role_permissions').get().n;
  const isFreshDb = rowCount === 0;

  // Rollen-Konfiguration nachziehen (additiv; bestehende Werte bleiben).
  const insertRole = db.prepare(
    'INSERT OR IGNORE INTO roles_config (role, editable, level) VALUES (?, ?, ?)'
  );
  // Seed-Zeile setzen/aktualisieren: nur wenn NICHT vom Betreiber geaendert.
  const upsertSeed = db.prepare(`
    INSERT INTO role_permissions (role, perm, allowed, source) VALUES (?, ?, ?, 'seed')
    ON CONFLICT(role, perm) DO UPDATE SET
      allowed = excluded.allowed,
      source  = 'seed'
    WHERE role_permissions.source = 'seed'
  `);
  // Fehlende Zeile fuer ein neues Recht/Rolle mit Seed-Default anlegen.
  const insertSeedIfMissing = db.prepare(
    `INSERT OR IGNORE INTO role_permissions (role, perm, allowed, source) VALUES (?, ?, ?, 'seed')`
  );

  db.transaction(() => {
    for (const role of ROLES) {
      insertRole.run(role, FIXED_ROLES.has(role) ? 0 : 1, ROLE_LEVEL[role]);
      const allowedSet = new Set(DEFAULT_MATRIX[role] ?? []);
      for (const perm of PERM_NAMES) {
        const want = allowedSet.has(perm) ? 1 : 0;
        if (isFreshDb) {
          // Frische DB: alles ist Seed.
          insertSeedIfMissing.run(role, perm, want);
        } else {
          // Bestand mit aelterer Version: Seed-Zeilen nachziehen, user-Zeilen
          // schuetzen. Neue (role, perm)-Paare additiv anlegen.
          upsertSeed.run(role, perm, want);
          insertSeedIfMissing.run(role, perm, want);
        }
      }
    }
    setSeedVersion(PERMISSIONS_SEED_VERSION);
  })();

  loaded = true;
  return true;
}

function ensureLoaded() {
  if (!loaded) loadPermissions();
}

// --- API -------------------------------------------------------------------

// Alle erlaubten Rechte einer Rolle als string[].
export function getPermissionsForRole(role) {
  ensureLoaded();
  if (FIXED_ROLES.has(role)) return PERM_NAMES.slice(); // superuser: immer alles
  if (!ROLES.includes(role)) return [];
  const rows = db
    .prepare('SELECT perm FROM role_permissions WHERE role = ? AND allowed = 1')
    .all(role);
  return rows.map((r) => r.perm);
}

// Prueft, ob eine Rolle ein Recht hat. superuser IMMER true.
export function roleHasPerm(role, perm) {
  // Fixe Rollen: immer true, egal was in der DB steht.
  if (FIXED_ROLES.has(role)) return true;
  if (!ROLES.includes(role)) return false;
  if (!PERM_SET.has(perm)) return false;
  ensureLoaded();
  const row = db
    .prepare('SELECT allowed FROM role_permissions WHERE role = ? AND perm = ?')
    .get(role, perm);
  return !!(row && row.allowed);
}

// Ist die Rolle editierbar? (superuser ist fix -> false)
export function isRoleEditable(role) {
  ensureLoaded();
  if (FIXED_ROLES.has(role)) return false;
  if (!ROLES.includes(role)) return false;
  const row = db.prepare('SELECT editable FROM roles_config WHERE role = ?').get(role);
  return !!(row && row.editable);
}

// Setzt ein Recht fuer eine Rolle. Wirft bei superuser oder unbekannter
// Rolle/perm (Schutz vor Selbst-Aussperrung und Tippfehlern).
export function setPermission(role, perm, allowed) {
  ensureLoaded();
  if (!ROLES.includes(role)) throw new Error(`Unbekannte Rolle: ${role}`);
  if (FIXED_ROLES.has(role)) throw new Error(`Rolle "${role}" ist fix und darf nicht geaendert werden`);
  if (!PERM_SET.has(perm)) throw new Error(`Unbekanntes Recht: ${perm}`);
  if (!isRoleEditable(role)) throw new Error(`Rolle "${role}" ist nicht editierbar`);

  // source='user': markiert die Zeile als Betreiber-Entscheidung, die ein
  // spaeterer Re-Seed NIE ueberschreiben darf.
  db.prepare(`
    INSERT INTO role_permissions (role, perm, allowed, source) VALUES (?, ?, ?, 'user')
    ON CONFLICT(role, perm) DO UPDATE SET allowed = excluded.allowed, source = 'user'
  `).run(role, perm, allowed ? 1 : 0);
  return true;
}

// Gesamt-Matrix fuer die spaetere UI.
export function getMatrix() {
  ensureLoaded();
  const matrix = {};
  const editable = {};
  for (const role of ROLES) {
    editable[role] = isRoleEditable(role);
    matrix[role] = {};
    const allowed = new Set(getPermissionsForRole(role));
    for (const perm of PERM_NAMES) {
      matrix[role][perm] = allowed.has(perm);
    }
  }
  return {
    roles: ROLES.slice(),
    permissions: PERMISSIONS.map((p) => ({ ...p })),
    matrix,
    editable,
  };
}

// DB-Verbindung schliessen (fuer Tests/Skripte; im Server nicht noetig).
export function closePermissionsDb() {
  try { db.close(); } catch { /* schon geschlossen */ }
}
