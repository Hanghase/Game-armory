// Game-Armory - Gegenprobe fuer das Selbst-Update (2026-10-19)
//
// Warum ein eigenes Modul: Die Pruefung braucht den Helfer (git fetch) und
// soll im Hintergrund laufen. Sie darf den Serverstart nie blockieren und
// niemals werfen - ein gescheiterter Abgleich ist ein Zustand ("unknown"),
// kein Absturz.
//
// Ablage: Setting 'self_update_state' als JSON. Ein Setting statt einer
// eigenen Tabelle, weil genau EIN Zustand existiert (die Armory selbst).

import { getSetting, setSetting, getNumericSetting } from './settings.js';
import { checkSelfUpdate } from './selfUpdate.js';

// Liest den zuletzt gespeicherten Zustand. Nie null: ist nichts gespeichert
// oder unlesbar, kommt ein ehrliches "unknown" zurueck.
export function getSelfUpdateState() {
  let raw = null;
  try {
    raw = getSetting('self_update_state');
  } catch {
    raw = null;
  }
  if (!raw) {
    return { state: 'unknown', installed: null, available: null, reason: 'Noch nicht geprueft', checkedAt: null };
  }
  try {
    const parsed = JSON.parse(raw);
    const state = ['current', 'outdated', 'unknown'].includes(parsed.state) ? parsed.state : 'unknown';
    return {
      state,
      installed: parsed.installed ?? null,
      available: parsed.available ?? null,
      reason: parsed.reason ?? null,
      checkedAt: Number.isFinite(parsed.checkedAt) ? parsed.checkedAt : null,
      // Gesetzt, wenn die aktuelle Aussage aus einem frueheren Lauf stammt und
      // die neueste Pruefung gescheitert ist (2026-10-19).
      lastGoodAt: Number.isFinite(parsed.lastGoodAt) ? parsed.lastGoodAt : null,
    };
  } catch {
    return { state: 'unknown', installed: null, available: null, reason: 'Zustand unlesbar', checkedAt: null };
  }
}

function saveSelfUpdateState(s) {
  try {
    setSetting('self_update_state', JSON.stringify(s));
  } catch (err) {
    console.warn(`[armory] Selbst-Update-Zustand nicht speicherbar: ${err.message}`);
  }
}

// Eine Pruefung ausfuehren und ablegen. Optionales Protokoll fuer Aufrufer,
// die den Verlauf sehen wollen (Panel-Knopf).
export async function runSelfUpdateCheck({ log = console.log } = {}) {
  const result = await checkSelfUpdate();

  // Letzten guten Stand bewahren (2026-10-19): Ein einzelner Netz-Aussetzer
  // soll nicht aus "aktuell" ein "unbekannt" machen. Wenn die Pruefung
  // scheitert und wir vorher eine belastbare Aussage hatten, bleibt diese
  // stehen - ergaenzt um den Grund und darum, wann sie galt.
  if (result.state === 'unknown') {
    const previous = getSelfUpdateState();
    const wasGood = previous.state === 'current' || previous.state === 'outdated';
    if (wasGood && previous.checkedAt) {
      const carried = {
        ...previous,
        reason: result.reason,
        staleSince: previous.checkedAt,
        checkedAt: Date.now(),
        lastGoodAt: previous.checkedAt,
      };
      saveSelfUpdateState(carried);
      log(`[armory] Selbst-Update-Pruefung: ${result.reason} - letzte gute Aussage `
        + `(${previous.state}, ${new Date(previous.checkedAt).toLocaleString('de-DE')}) bleibt stehen`);
      return carried;
    }
  }

  saveSelfUpdateState(result);
  const bits = [`${result.state}`];
  if (result.installed) bits.push(`installiert ${result.installed}`);
  if (result.available) bits.push(`verfuegbar ${result.available}`);
  if (result.reason) bits.push(result.reason);
  log(`[armory] Selbst-Update-Pruefung: ${bits.join(', ')}`);
  return result;
}

// Intervall in Minuten (0 = nur manuell). Default 1440 = einmal am Tag.
export function selfUpdateCheckMinutes() {
  try {
    return getNumericSetting('self_update_check_minutes');
  } catch {
    return 0;
  }
}
