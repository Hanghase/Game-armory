// Arsenal-Leitungen: die Armory nimmt die Verbindung eines Arsenals an.
//
// Die Richtung ist die des Konzepts: das ARSENAL waehlt den Kontakt. Die
// Armory hoert nur zu. Folge: am Arsenal muss kein Port offen sein.
//
// Ablauf:
//   1. WebSocket auf /ws/arsenal?id=<id>, Schluessel im Header x-arsenal-key
//   2. Pruefung gegen den gespeicherten Hash (nicht gegen die IP)
//   3. Die Leitung bleibt offen; die Armory schickt Befehle durch sie
//   4. Jede Antwort des Arsenals landet ueber den ref beim Wartenden
//
// Was hier NICHT passiert: es wird nichts ausgefuehrt. Die Armory schickt nur
// eine Nachricht und wartet auf die Antwort. Ob der Befehl zulaessig ist,
// prueft das Arsenal selbst nochmal gegen seine eigene Whitelist - beide
// Seiten pruefen, nicht nur eine.

import crypto from 'node:crypto';

import { getArsenal, touchHeartbeat } from './arsenalStore.js';
import { sendeWeiter, schliesseAb } from './arsenalTransferSend.js';
import { verifyHeartbeat } from './arsenals.js';

// Offene Leitungen: arsenalId -> ws
const leitungen = new Map();

// Wartende Antworten: ref -> { resolve, timer }
const wartend = new Map();

// Wie lange auf die Antwort eines Befehls gewartet wird. systemctl kann bei
// einem haengenden Dienst lange brauchen - 30 s sind grosszuegig, aber nicht
// unendlich.
const BEFEHL_TIMEOUT_MS = 30_000;

// Nach dieser Zeit ohne jede Nachricht gilt die Leitung als tot.
const LEITUNG_STILL_MS = 90_000;

// Prueft einen Verbindungswunsch. Rueckgabe wie bei verifyHeartbeat, plus der
// gefundene Datensatz. Die Fehlerart ist absichtlich immer dieselbe:
// "unbekanntes Arsenal" und "falscher Schluessel" duerfen nicht
// unterscheidbar sein, sonst verraet die Antwort, welche IDs existieren.
export function pruefeHandshake({ id, key }) {
  const arsenalId = Number(id);
  if (!Number.isInteger(arsenalId) || arsenalId <= 0) {
    return { ok: false, reason: 'unauthorized', httpStatus: 401 };
  }

  const arsenal = getArsenal(arsenalId);
  const check = verifyHeartbeat({
    presentedKey: key,
    storedHash: arsenal?.key_hash,
    revokedAt: arsenal?.revoked_at,
  });

  if (!check.ok) return { ok: false, reason: 'unauthorized', httpStatus: 401 };
  return { ok: true, arsenal };
}

// Nimmt eine Leitung auf. Eine bestehende Leitung desselben Arsenals wird
// geschlossen - sonst sammeln sich bei jedem Reconnect tote Verbindungen.
export function registriere(arsenalId, ws) {
  const alt = leitungen.get(arsenalId);
  if (alt) {
    try { alt.close(); } catch { /* egal */ }
  }
  leitungen.set(arsenalId, ws);
}

export function abmelden(arsenalId) {
  leitungen.delete(arsenalId);
}

// Die offene Leitung eines Arsenals. Wird fuer das Senden von Stuecken
// gebraucht (die Stuecke sind binaer, sendeBefehl schickt JSON).
export function holeLeitung(arsenalId) {
  const ws = leitungen.get(arsenalId);
  return ws && ws.readyState === 1 ? ws : null;
}

export function istVerbunden(arsenalId) {
  return leitungen.has(arsenalId);
}

export function anzahl() {
  return leitungen.size;
}

// Schickt einen Befehl durch die offene Leitung und wartet auf die Antwort.
// Rueckgabe: true, wenn der Befehl abgeschickt wurde. Die Antwort kommt
// spaeter ueber den ref.
export function sendeBefehl(arsenalId, nachricht) {
  const ws = leitungen.get(arsenalId);
  if (!ws) return false;

  const ref = crypto.randomBytes(8).toString('hex');
  const payload = { ...nachricht, ref };
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    return false;
  }
  return true;
}

// Schickt einen Befehl und liefert die Antwort (Promise).
// Wird fuer die Routen gebraucht: der Klick im Panel soll ein Ergebnis haben.
export function frageArsenal(arsenalId, { action, service }) {
  const ws = leitungen.get(arsenalId);
  if (!ws) return Promise.resolve({ ok: false, error: 'arsenal-offline' });

  const ref = crypto.randomBytes(8).toString('hex');
  const payload = { type: 'command', action, ref, ...(service ? { service } : {}) };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wartend.delete(ref);
      resolve({ ok: false, error: 'timeout' });
    }, BEFEHL_TIMEOUT_MS);

    wartend.set(ref, { resolve, timer });

    try {
      ws.send(JSON.stringify(payload));
    } catch {
      clearTimeout(timer);
      wartend.delete(ref);
      resolve({ ok: false, error: 'send-failed' });
    }
  });
}

// Verarbeitet eine eingehende Nachricht eines Arsenals.
// Rueckgabe: true, wenn sie verarbeitet wurde.
export function verarbeiteNachricht(arsenalId, roh) {
  let msg;
  try {
    msg = JSON.parse(String(roh));
  } catch {
    return false;
  }

  if (msg?.type === 'heartbeat') {
    // Ein Lebenszeichen ueber die offene Leitung ist genauso viel wert wie
    // eines ueber HTTP - also denselben Eintrag fortschreiben.
    const version = typeof msg.version === 'string' ? msg.version.slice(0, 40) : null;
    touchHeartbeat({ id: arsenalId, version });
    return true;
  }

  // Ein Pull laeuft: "bereit" oeffnet das Fenster, "pull-fertig" beendet ihn,
  // "pull-abbruch" raeumt auf. Kennung statt ref, weil ein Pull viele
  // Nachrichten hat - ein ref gilt genau einer Antwort.
  if (msg?.type === 'bereit' && typeof msg.id === 'string') {
    // Die Stuecke gehen asynchron raus. Ein blockierendes await hier wuerde
    // den Nachrichtenempfang anhalten - und das naechste "stand" kaeme nie.
    sendeWeiter(msg.id).catch(() => {});
    return true;
  }

  if (msg?.type === 'pull-fertig' && typeof msg.id === 'string') {
    schliesseAb(msg.id, { erfolg: true, groesse: Number.isInteger(msg.groesse) ? msg.groesse : null })
      .then((ergebnis) => { if (ergebnis) meldePullErgebnis(ergebnis); })
      .catch(() => {});
    return true;
  }

  if (msg?.type === 'pull-abbruch' && typeof msg.id === 'string') {
    schliesseAb(msg.id, { erfolg: false, grund: String(msg.grund ?? 'unbekannt').slice(0, 60) })
      .then((ergebnis) => { if (ergebnis) meldePullErgebnis(ergebnis); })
      .catch(() => {});
    return true;
  }

  if (msg?.type === 'result' && typeof msg.ref === 'string') {
    const w = wartend.get(msg.ref);
    if (!w) return false;
    clearTimeout(w.timer);
    wartend.delete(msg.ref);
    w.resolve({ ok: Boolean(msg.ok), output: msg.output ?? null, error: msg.error ?? null });
    return true;
  }

  return false;
}

// Beim Schliessen: Leitung raeumen und offene Befehle nicht ewig warten lassen.
export function leitungWeg(arsenalId) {
  abmelden(arsenalId);
  // Offene Anfragen koennen nicht mehr beantwortet werden. Sie werden NICHT
  // global abgebrochen - andere Arsenale koennen weiterlaufen.
}

// Ein Ergebnis eines Pulls melden. Die Route haengt hier eine Funktion ein,
// damit der Auftrag im Panel auf "fertig" geht - arsenalSocket kennt die
// Auftragsliste nicht und soll sie nicht kennen.
let beiPullErgebnisMelder = null;

export function aufPullErgebnis(fn) {
  beiPullErgebnisMelder = typeof fn === 'function' ? fn : null;
}

function meldePullErgebnis(ergebnis) {
  try {
    beiPullErgebnisMelder?.(ergebnis);
  } catch {
    // Ein Fehler im Melder darf den Socket nicht mitreissen.
  }
}

export { LEITUNG_STILL_MS, BEFEHL_TIMEOUT_MS };
