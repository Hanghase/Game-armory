// Die fuenf Pruefungen beim Uebernehmen (docs/rack-schema.md §12).
//
// Grundsatz: NICHTS anlegen, was nicht vorher geprueft wurde. Ein Sword, der
// auf etwas zeigt, das es nicht gibt, ist schlimmer als kein Sword - man
// merkt es erst, wenn man ihn bedienen will.
//
// Und ausdruecklich: KEIN RATEN. Eine Heuristik fuer "ist das eine normale
// Instanz" wuerde bei fremden Setups falsch liegen. Wenn eine Pruefung nicht
// durchfuehrbar ist, ist das Ergebnis "unbekannt", nicht "ok".

import { execFile } from 'node:child_process';
import { stat, access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { promisify } from 'node:util';

const ausfuehren = promisify(execFile);

export const PRUEFUNGEN = [
  'steuerart',
  'arbeitsverzeichnis',
  'struktur',
  'port',
  'logquelle',
];

// --- einzelne Pruefungen -------------------------------------------------

/**
 * Steuerart: existiert die Compose-Datei / die Unit wirklich?
 * Ein Pfad, den der Betreiber angibt, ist nur dann eine Steuerart, wenn er
 * aufloest und lesbar ist.
 */
export async function pruefeSteuerart(kandidat, deps = {}) {
  const fsRealpath = deps.realpath ?? realpath;
  const fsAccess = deps.access ?? access;

  if (kandidat.quelle === 'docker') {
    if (!Array.isArray(kandidat.quellen) || kandidat.quellen.length === 0) {
      return { ok: false, grund: 'keine Compose-Datei am Container hinterlegt' };
    }
    for (const datei of kandidat.quellen) {
      try {
        const aufgeloest = await fsRealpath(datei);
        await fsAccess(aufgeloest, constants.R_OK);
      } catch {
        return { ok: false, grund: `Compose-Datei nicht lesbar: ${datei}` };
      }
    }
    return { ok: true, wert: kandidat.quellen };
  }

  if (kandidat.quelle === 'systemd') {
    const run = deps.run ?? ausfuehren;
    const unit = kandidat.label;
    try {
      await run('systemctl', ['cat', '--no-pager', unit]);
    } catch {
      return { ok: false, grund: `Unit nicht lesbar: ${unit}` };
    }
    return { ok: true, wert: unit };
  }

  return { ok: false, grund: `unbekannte Quelle: ${kandidat.quelle}` };
}

/**
 * Arbeitsverzeichnis: existiert es, und gehoert es dem Dienst?
 *
 * Wir pruefen NICHT, ob es dem erwarteten User gehoert - wir wissen nicht,
 * wer der Dienst-User ist, und raten waere hier falsch. Wir melden, wer es
 * ist, und der Betreiber entscheidet.
 */
export async function pruefeArbeitsverzeichnis(kandidat, deps = {}) {
  const fsStat = deps.stat ?? stat;
  const pfad = kandidat.arbeitsVerzeichnis;
  if (!pfad) return { ok: false, grund: 'kein Arbeitsverzeichnis angegeben' };
  if (!pfad.startsWith('/')) return { ok: false, grund: 'Arbeitsverzeichnis muss absolut sein' };

  let st;
  try {
    st = await fsStat(pfad);
  } catch {
    return { ok: false, grund: `Arbeitsverzeichnis existiert nicht: ${pfad}` };
  }
  if (!st.isDirectory()) {
    return { ok: false, grund: `Arbeitsverzeichnis ist kein Verzeichnis: ${pfad}` };
  }
  // uid/gid melden, nicht bewerten: ob 979 (armory) oder 980 (atm11) richtig
  // ist, weiss nur der Betreiber.
  return { ok: true, wert: pfad, besitzer: { uid: st.uid, gid: st.gid } };
}

/**
 * Struktur: sind die erwarteten Marker da?
 *
 * Die Marker hingen bisher am Rack-Typ. Ein unbekannter Typ hat keine Marker -
 * dann ist das Ergebnis "unbekannt" und NICHT "ok".
 */
export async function pruefeStruktur(kandidat, deps = {}) {
  const fsStat = deps.stat ?? stat;
  const pfad = kandidat.arbeitsVerzeichnis;
  const marker = kandidat.marker;

  if (!pfad) return { ok: false, grund: 'kein Arbeitsverzeichnis angegeben' };
  if (!Array.isArray(marker) || marker.length === 0) {
    return { ok: false, unbekannt: true,
      grund: 'keine Struktur-Marker fuer diese Dienstart bekannt - nicht pruefbar' };
  }

  const fehlend = [];
  for (const m of marker) {
    try {
      await fsStat(`${pfad}/${m}`);
    } catch {
      fehlend.push(m);
    }
  }
  if (fehlend.length > 0) {
    return { ok: false, grund: `Struktur unvollstaendig, fehlt: ${fehlend.join(', ')}` };
  }
  return { ok: true, wert: marker };
}

/**
 * Port: lauscht wirklich etwas?
 *
 * `ss -tlnp` ist die Wahrheit - nicht die Konfiguration, nicht die Annahme.
 * Live gelernt am 2026-11-10: HTTP 000 auf 8081 hiess "falscher Port", nicht
 * "Dienst kaputt" (8081 gehoert 7DaysToDieServer, die Armory lauscht auf 3000).
 */
export async function pruefePort(kandidat, deps = {}) {
  const run = deps.run ?? ausfuehren;
  const port = Number(kandidat.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, grund: `kein gültiger Port angegeben: ${kandidat.port}` };
  }

  let stdout;
  try {
    ({ stdout } = await run('ss', ['-tln']));
  } catch {
    return { ok: false, unbekannt: true, grund: 'Portliste nicht lesbar (ss fehlgeschlagen)' };
  }

  // Format: State Recv-Q Send-Q Local:Port Peer:* Users:...
  // Wir suchen den Port als Wort am Zeilenende eines Local-Adressfeldes.
  const zeilen = String(stdout ?? '').split('\n');
  const treffer = zeilen.find((z) => {
    const felder = z.trim().split(/\s+/);
    if (felder.length < 4) return false;
    const lokal = felder[3] ?? '';
    const m = /:(\d+)$/.exec(lokal);
    return m && Number(m[1]) === port;
  });

  if (!treffer) return { ok: false, grund: `Port ${port} lauscht nicht` };
  return { ok: true, wert: port };
}

/**
 * Log-Quelle: Datei oder journald erreichbar?
 */
export async function pruefeLogquelle(kandidat, deps = {}) {
  const run = deps.run ?? ausfuehren;
  const fsAccess = deps.access ?? access;
  const logs = kandidat.logs;

  if (!logs || !logs.type) return { ok: false, grund: 'keine Log-Quelle bekannt' };

  if (logs.type === 'file') {
    if (!logs.path) return { ok: false, grund: 'Log-Datei nicht angegeben' };
    try {
      await fsAccess(logs.path, constants.R_OK);
    } catch {
      return { ok: false, grund: `Log-Datei nicht lesbar: ${logs.path}` };
    }
    return { ok: true, wert: logs.path };
  }

  if (logs.type === 'journald') {
    if (!logs.unit) return { ok: false, grund: 'Log-Unit nicht angegeben' };
    try {
      await run('journalctl', ['-u', logs.unit, '-n', '1', '--no-pager', '-q']);
    } catch {
      return { ok: false, grund: `journald nicht lesbar fuer: ${logs.unit}` };
    }
    return { ok: true, wert: logs.unit };
  }

  if (logs.type === 'docker') {
    // Ein docker-Log ist erreichbar, wenn der Container laeuft - das steht
    // schon im Kandidaten. Hier nur die Angabe pruefen.
    if (!logs.service) return { ok: false, grund: 'Log-Dienst nicht angegeben' };
    return { ok: true, wert: logs.service };
  }

  return { ok: false, grund: `unbekannte Log-Art: ${logs.type}` };
}

// --- Gesamturteil -------------------------------------------------------

/**
 * Fuehrt alle fuenf Pruefungen aus.
 *
 * Gibt zurueck:
 *   {
 *     ok: true|false,
 *     pruefungen: { steuerart: {ok, grund, wert}, ... },
 *     offen: [namen der nicht bestandenen Pruefungen]
 *   }
 *
 * Ein "unbekannt" zaehlt NICHT als bestanden. Nur fuenf mal ok ist ok.
 */
export async function pruefeAdoption(kandidat, deps = {}) {
  const pruefungen = {};

  pruefungen.steuerart = await pruefeSteuerart(kandidat, deps);
  pruefungen.arbeitsverzeichnis = await pruefeArbeitsverzeichnis(kandidat, deps);
  pruefungen.struktur = await pruefeStruktur(kandidat, deps);
  pruefungen.port = await pruefePort(kandidat, deps);
  pruefungen.logquelle = await pruefeLogquelle(kandidat, deps);

  const offen = PRUEFUNGEN.filter((name) => pruefungen[name].ok !== true);
  return { ok: offen.length === 0, pruefungen, offen };
}
