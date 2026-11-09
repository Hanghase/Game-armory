// Die Armory schickt die Stuecke - ueber die offene Leitung des Arsenals.
//
// Getrennt von app/arsenalTransferRun.js: dort stehen die Entscheidungen
// (welches Stueck, wie bremsen, wann haengt es), hier steht das Schreiben in
// die Leitung und das Lesen von der Platte. Ohne diese Trennung waeren die
// Entscheidungen nur mit einem echten WebSocket pruefbar - und damit nie.
//
// DER ABLAUF:
//   1. sendePull()      -> Armory schickt { type:'pull', ... }, Arsenal antwortet "bereit"
//   2. bei "bereit"     -> sendeWeiter() liest Stuecke und schickt sie
//   3. bei "pull-fertig"-> Pruefung durch das Arsenal (dort schon geschehen), Auftrag fertig
//   4. bei "pull-abbruch" oder Stillstand -> aufraeumen, Auftrag scheitern lassen
//
// WAS HIER NICHT PASSIERT: es wird nichts umbenannt, nichts entpackt,
// nichts installiert. Das ist Sache des Agenten bzw. des Install-Helfers.
// Ein Fehler beim Senden darf keine halbe Installation hinterlassen.

import { open } from 'node:fs/promises';
import {
  erstellePull, naechstesStueck, darfSenden, haengtSeit, pullAnsage,
  FENSTER_STUECKE, PULL_STILL_MS,
} from './arsenalTransferRun.js';
import { sha256VonDatei, planeStuecke, STUECK_BYTES } from './arsenalTransfer.js';

// Laufende Pulls: Kennung -> { pull, datei, leitung, auftragId }
const pulls = new Map();

// Ein Stueck: 8 Bytes Kopf (offset, laenge), dann die Daten.
// Muss zu agent/run.js passen - dort steht dieselbe Form beim Lesen.
function rahmen(offset, daten) {
  const kopf = Buffer.alloc(8);
  kopf.writeUInt32BE(offset, 0);
  kopf.writeUInt32BE(daten.length, 4);
  return Buffer.concat([kopf, daten]);
}

// Prueft die Datei, BEVOR etwas rausgeht.
//
// Eine falsche Pruefsumme erst am Arsenal zu merken heisst: 2 GB umsonst
// uebertragen, und der Fehler sieht nach Netz aus statt nach Platte.
export async function sendePull({ arsenalId, dateiPfad, name, leitung, auftragId = null }) {
  if (!leitung || leitung.readyState !== 1) {
    return { ok: false, grund: 'arsenal-offline' };
  }

  let groesse;
  let sha256;
  try {
    const { stat } = await import('node:fs/promises');
    const s = await stat(dateiPfad);
    groesse = s.size;
    if (!Number.isInteger(groesse) || groesse <= 0) {
      return { ok: false, grund: 'datei-leer' };
    }
    sha256 = await sha256VonDatei(dateiPfad);
  } catch (err) {
    return { ok: false, grund: 'datei-unlesbar', fehler: String(err.message ?? err).slice(0, 200) };
  }

  const id = (await import('node:crypto')).randomBytes(16).toString('hex');
  const pull = erstellePull({ id, gesamt: groesse, sha256, name, arsenalId, auftragId });

  pulls.set(id, { pull, dateiPfad, leitung, auftragId, offen: null, unbetaetigt: 0 });

  try {
    leitung.send(JSON.stringify(pullAnsage(pull)));
  } catch (err) {
    pulls.delete(id);
    return { ok: false, grund: 'senden-fehlgeschlagen', fehler: String(err.message ?? err).slice(0, 200) };
  }

  return { ok: true, id, gesamt: groesse, sha256 };
}

// Das Arsenal hat "bereit" gesagt: jetzt Stuecke schicken.
export async function sendeWeiter(id) {
  const eintrag = pulls.get(id);
  if (!eintrag) return { ok: false, grund: 'pull-unbekannt' };

  eintrag.pull.bereit = true;
  eintrag.pull.letzteAktion = Date.now();

  // Datei oeffnen und offen halten: bei tausenden Stuecken jedes einzeln zu
  // oeffnen ist der Unterschied zwischen 2 Sekunden und 2 Minuten.
  if (!eintrag.offen) {
    try {
      eintrag.offen = await open(eintrag.dateiPfad, 'r');
    } catch (err) {
      return brichAb(id, 'datei-nicht-zu-oeffnen');
    }
  }

  while (darfSenden(eintrag.pull, eintrag.unbetaetigt, FENSTER_STUECKE)) {
    const stueck = naechstesStueck(eintrag.pull, STUECK_BYTES);
    if (!stueck) break;

    const puffer = Buffer.allocUnsafe(stueck.laenge);
    const { bytesRead } = await eintrag.offen.read(puffer, 0, stueck.laenge, stueck.offset);
    if (bytesRead !== stueck.laenge) {
      // Die Datei ist kuerzer als beim Pruefen. Nicht "irgendwie weiter" -
      // das Arsenal wuerde ewig auf fehlende Bytes warten.
      return brichAb(id, 'datei-kuerzer-geworden');
    }

    try {
      eintrag.leitung.send(rahmen(stueck.offset, puffer));
    } catch (err) {
      return brichAb(id, 'senden-fehlgeschlagen');
    }

    eintrag.pull.gesendet += stueck.laenge;
    eintrag.unbetaetigt += 1;
    eintrag.pull.letzteAktion = Date.now();
  }

  return { ok: true, gesendet: eintrag.pull.gesendet, gesamt: eintrag.pull.gesamt };
}

// Das Arsenal meldet den Stand - das Fenster wieder oeffnen.
export function quittiere(id) {
  const eintrag = pulls.get(id);
  if (!eintrag) return false;
  eintrag.unbetaetigt = Math.max(0, eintrag.unbetaetigt - 1);
  eintrag.pull.letzteAktion = Date.now();
  return true;
}

// Fertig: aufraeumen. Die Pruefsumme hat das ARSENAL geprueft - es hat die
// Datei, es kann sie am besten lesen. Die Armory vertraut dieser Meldung nur,
// weil das Arsenal sie nur nach eigener Pruefung schickt.
export async function schliesseAb(id, { erfolg, grund = null, groesse = null }) {
  const eintrag = pulls.get(id);
  if (!eintrag) return null;
  pulls.delete(id);
  await eintrag.offen?.close().catch(() => {});
  return {
    id,
    erfolg,
    grund,
    groesse,
    auftragId: eintrag.auftragId,
    arsenalId: eintrag.pull.arsenalId,
  };
}

// Abbruch: Leitung melden, aufraeumen.
export async function brichAb(id, grund) {
  const eintrag = pulls.get(id);
  if (!eintrag) return { ok: false, grund: 'pull-unbekannt' };

  try {
    eintrag.leitung.send(JSON.stringify({ type: 'pull-abbruch', id, grund }));
  } catch { /* Leitung ist ohnehin weg */ }

  await eintrag.offen?.close().catch(() => {});
  pulls.delete(id);
  return { ok: false, grund, aufgeraeumt: true };
}

// Nach einem Stillstand aufraeumen. Wird vom Aufraeumer aufgerufen.
export async function raeumeHaengendeAuf(now = Date.now()) {
  const weg = [];
  for (const [id, eintrag] of pulls) {
    if (haengtSeit(eintrag.pull, now, PULL_STILL_MS)) {
      await brichAb(id, 'stillstand');
      weg.push(id);
    }
  }
  return weg;
}

export function offenePulls() {
  return [...pulls.keys()];
}
