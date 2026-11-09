// Auftraege (Jobs) auf dem Arsenal.
//
// DER GRUND (Felix, 2026-11-09): "koennen wir Fehler und Sucess nicht alle
// 30 sekunden mit uebermitteln lassen ... so verhindern wir dumme
// sperrzeiten". Genau das ist die Loesung:
//
//   Ein Befehl darf 30 s dauern. Ein Install dauert Minuten.
//   Also kein langer Befehl, sondern ein AUFTRAG:
//
//     1. "install" kommt an -> sofort Antwort "laeuft, jobId X"
//     2. der Auftrag laeuft weiter
//     3. jedes Lebenszeichen (30 s) traegt den Stand mit
//     4. Ergebnis kommt mit dem naechsten Lebenszeichen - auch ein Fehler
//
// Kein neues Modell, kein zusaetzlicher Kanal: der Herzschlag, der sowieso
// alle 30 s geht, traegt es. Ein Lebenszeichen mit leerer Auftragsliste ist
// ein paar Byte.
//
// Das hier ist reine Verwaltung - kein Netz, keine Prozesse. Damit ist es
// ohne laufenden Server testbar.

import { randomBytes } from 'node:crypto';

export const ZUSTAENDE = Object.freeze(['offen', 'laeuft', 'fertig', 'fehlgeschlagen']);

// Der Takt des Lebenszeichens (Felix, 2026-11-09):
//   "im Idle oder normalem Tagesgeschaeft 30 Sekunden, bei installs oder
//    server verschieben alle 15 Sekunden bis fertig"
//
// Der Takt haengt am ZUSTAND DER ARBEIT, nicht an einer Einstellung. Ein
// ruhiges Arsenal soll die Armory nicht anfassen; ein laufender Auftrag soll
// sich zuegig anfuehlen.
export const TAKT_LEERLAUF_MS = 30_000;
export const TAKT_AKTIV_MS = 15_000;

// Wie viele Auftraege eine Liste behaelt. Ein Agent, der monatelang laeuft,
// wuerde sonst Speicher ohne Ende sammeln. Die neuesten bleiben.
const MAX_AUFTRAEGE = 20;

export function erstelleAuftragsliste({ max = MAX_AUFTRAEGE } = {}) {
  // Map haelt die Einfuegereihenfolge. Beim Kuerzen fallen die aeltesten weg.
  const auftraege = new Map();

  function anlegen({ art, titel = null } = {}) {
    const id = randomBytes(8).toString('hex');
    const job = {
      id,
      art: art ?? 'unbekannt',
      titel,
      zustand: 'offen',
      prozent: 0,
      meldung: null,
      fehler: null,
      gestartet: Date.now(),
      beendet: null,
    };
    auftraege.set(id, job);
    kuerzen();
    return { ...job };
  }

  function kuerzen() {
    while (auftraege.size > max) {
      const aeltest = auftraege.keys().next().value;
      auftraege.delete(aeltest);
    }
  }

  function hole(id) {
    const j = auftraege.get(id);
    return j ? { ...j } : null;
  }

  function alle() {
    return [...auftraege.values()].map((j) => ({ ...j }));
  }

  function setzeFortschritt(id, { prozent, meldung } = {}) {
    const j = auftraege.get(id);
    if (!j) return null;
    // Ein abgeschlossener Auftrag wird NIE wieder offen. Sonst kann ein
    // spaeter eintreffender Fortschritt ein Ergebnis ueberschreiben.
    if (j.zustand === 'fertig' || j.zustand === 'fehlgeschlagen') return { ...j };
    if (j.zustand === 'offen') j.zustand = 'laeuft';
    if (Number.isFinite(prozent)) {
      j.prozent = Math.max(0, Math.min(100, Math.round(prozent)));
    }
    if (typeof meldung === 'string' && meldung !== '') j.meldung = meldung;
    return { ...j };
  }

  function beende(id, { erfolg = true, meldung = null, fehler = null } = {}) {
    const j = auftraege.get(id);
    if (!j) return null;
    // Ein zweites Ende darf ein Ergebnis nicht umdrehen.
    if (j.zustand === 'fertig' || j.zustand === 'fehlgeschlagen') return { ...j };
    j.zustand = erfolg ? 'fertig' : 'fehlgeschlagen';
    // Auch ein Fehler ist "durch" - nur anders. Wer 0 % bei einem Fehler
    // stehen laesst, sieht im Panel einen Balken, der nie ankommt.
    j.prozent = 100;
    j.beendet = Date.now();
    if (typeof meldung === 'string' && meldung !== '') j.meldung = meldung;
    if (!erfolg) j.fehler = fehler ?? meldung ?? 'unbekannter Fehler';
    return { ...j };
  }

  // Was ins naechste Lebenszeichen kommt.
  //
  // Laufende Auftraege: immer mit (das ist der Fortschritt).
  // Abgeschlossene: genau EINMAL (das Ergebnis). Meldet der Agent "fertig"
  // bei jedem Herzschlag neu, blinkt im Panel jede Minute dieselbe Meldung.
  // Nach bestaetige() ist er weg.
  function fuerHerzschlag() {
    return [...auftraege.values()]
      .filter((j) => j.zustand === 'offen' || j.zustand === 'laeuft' || !j.gemeldet)
      .map((j) => ({
        id: j.id,
        art: j.art,
        titel: j.titel,
        zustand: j.zustand,
        prozent: j.prozent,
        meldung: j.meldung,
        fehler: j.fehler,
      }));
  }

  // Die Armory hat das Ergebnis gesehen. Ab jetzt nicht mehr mitschicken.
  // Nur Ergebnisse fallen weg - ein laufender Auftrag bleibt.
  function bestaetige(id) {
    const j = auftraege.get(id);
    if (!j) return false;
    if (j.zustand === 'fertig' || j.zustand === 'fehlgeschlagen') {
      j.gemeldet = true;
    }
    return true;
  }

  // Eine laufende Arbeit ist "offen" oder "laeuft". Beides zaehlt.
  //
  // BEWUSST nicht mit der Zahl der Auftraege skaliert: bei fuenf Auftraegen
  // alle 3 s zu fragen waere genau das, was vermieden werden soll. 15 s ist
  // die Untergrenze.
  function taktMs() {
    for (const j of auftraege.values()) {
      if (j.zustand === 'offen' || j.zustand === 'laeuft') return TAKT_AKTIV_MS;
    }
    return TAKT_LEERLAUF_MS;
  }

  return { anlegen, hole, alle, setzeFortschritt, beende, fuerHerzschlag, bestaetige, taktMs };
}
