// Das Arsenal zieht eine Datei von der Armory - der Teil mit Platte und Leitung.
//
// Getrennt von agent/transfer.js, weil dort die Entscheidungen stehen und
// hier das Schreiben. Die Entscheidungen muessen ohne Netz und ohne Dateien
// testbar sein, sonst prueft man sie nie.
//
// DER ABLAUF:
//   1. der Agent bekommt { type:'pull', id, gesamt, sha256, ziel }
//   2. er oeffnet die Zieldatei und sagt "bereit"
//   3. die Armory schickt Stuecke (binär, mit offset)
//   4. jedes Stueck wird geschrieben und der Fortschritt in den Auftrag gelegt
//   5. am Ende: Pruefsumme. Stimmt sie nicht, wird die Datei GELOESCHT
//      und der Auftrag scheitert - nicht "irgendwie weiter".

import { createWriteStream } from 'node:fs';
import { mkdir, rm, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { erstelleEmpfaenger, pruefeDatei } from './transfer.js';

// Ein laufender Pull. Die Armory schickt Stuecke zu einer Kennung.
const pulls = new Map();

export function startePull({ id, gesamt, sha256, ziel }, { auftraege, auftragId, meldung = () => {} } = {}) {
  if (!id || typeof id !== 'string') throw new Error('id fehlt');
  if (!ziel || typeof ziel !== 'string') throw new Error('ziel fehlt');

  const empfaenger = erstelleEmpfaenger({ gesamt, sha256 });
  const teil = `${ziel}.teil`;
  let strom;

  pulls.set(id, {
    id,
    ziel,
    teil,
    empfaenger,
    auftragId,
    auftraege,
    meldung,
    bereit: false,
    strom: null,
  });

  return {
    id,
    // Die Armory bekommt die erste Antwort: "leg los".
    // Erst nach dem Oeffnen, sonst schreibt das erste Stueck ins Nichts.
    oeffne: async () => {
      const p = pulls.get(id);
      if (!p) throw new Error('Pull unbekannt');
      await mkdir(dirname(ziel), { recursive: true });
      // In eine .teil-Datei schreiben und am Ende umbenennen: eine halb
      // geschriebene Datei unter dem echten Namen sieht wie eine fertige aus.
      p.strom = createWriteStream(teil);
      await new Promise((res, rej) => {
        p.strom.once('open', res);
        p.strom.once('error', rej);
      });
      p.bereit = true;
      return { gesamt: empfaenger.stand().gesamt };
    },
  };
}

// Ein Stueck empfangen und schreiben. Rueckgabe geht an die Armory.
export async function nimmStueck(id, { offset, daten } = {}) {
  const p = pulls.get(id);
  if (!p) return { ok: false, grund: 'pull-unbekannt' };
  if (!p.bereit) return { ok: false, grund: 'nicht-bereit' };

  // Erst pruefen, dann schreiben. Ein abgelehntes Stueck darf nicht in der
  // Datei landen - sonst ist die Datei kaputt, obwohl wir es gemerkt haben.
  const r = p.empfaenger.nimm({ offset, daten });
  if (!r.ok) return r;

  await new Promise((res, rej) => {
    p.strom.write(daten, (err) => (err ? rej(err) : res()));
  });

  const stand = p.empfaenger.stand();
  if (p.auftraege && p.auftragId) {
    p.auftraege.setzeFortschritt(p.auftragId, {
      prozent: stand.prozent,
      meldung: `${stand.empfangen} von ${stand.gesamt} Bytes`,
    });
  }
  return { ok: true, empfangen: stand.empfangen, gesamt: stand.gesamt };
}

// Fertig: schliessen, pruefen, umbenennen - oder wegwerfen.
export async function beendePull(id) {
  const p = pulls.get(id);
  if (!p) return { ok: false, grund: 'pull-unbekannt' };

  try {
    if (p.strom) {
      await new Promise((res, rej) => p.strom.end((err) => (err ? rej(err) : res())));
    }

    if (!p.empfaenger.istFertig()) {
      // Nicht "fast fertig" durchwinken. Eine halbe ZIP installiert sich
      // nicht, und der Fehler waere spaeter nicht mehr zuzuordnen.
      await rm(p.teil, { force: true });
      pulls.delete(id);
      return { ok: false, grund: 'unvollstaendig', stand: p.empfaenger.stand() };
    }

    const stimmt = await pruefeDatei(p.teil, p.empfaenger.erwarteteSumme);
    if (!stimmt) {
      await rm(p.teil, { force: true });
      pulls.delete(id);
      return { ok: false, grund: 'pruefsumme-falsch' };
    }

    // Erst jetzt bekommt die Datei ihren echten Namen.
    await rename(p.teil, p.ziel);
    const s = await stat(p.ziel);
    pulls.delete(id);
    return { ok: true, ziel: p.ziel, groesse: s.size };
  } catch (err) {
    await rm(p.teil, { force: true }).catch(() => {});
    pulls.delete(id);
    return { ok: false, grund: 'schreibfehler', fehler: String(err.message ?? err) };
  }
}

// Bricht ab (Verbindung weg, Armory sagt ab). Raeumt die .teil-Datei weg -
// sonst sammeln sich halbe Downloads auf der Platte.
export async function brichAb(id) {
  const p = pulls.get(id);
  if (!p) return false;
  try {
    p.strom?.destroy();
  } catch { /* egal */ }
  await rm(p.teil, { force: true }).catch(() => {});
  pulls.delete(id);
  return true;
}

export function offenePulls() {
  return [...pulls.keys()];
}
