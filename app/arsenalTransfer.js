// Uebertragung einer ZIP von der Armory zum Arsenal.
//
// DER WEG: das Arsenal ZIEHT. Nicht die Armory schiebt. Wer zieht, bestimmt
// das Tempo, und der Agent bleibt der, der anruft - am Arsenal ist kein Port
// offen (Konzept 2026-11-09).
//
// WARUM STUECKE UND NICHT EINE NACHRICHT:
//   - eine WebSocket-Nachricht liegt komplett im Speicher, auf BEIDEN Seiten.
//     2 GB im Heap ist bei einem kleinen Arsenal ein Abschuss.
//   - bricht die Leitung bei 90 %, muss man wieder aufsetzen koennen.
//   - der Fortschritt muss sichtbar sein, sonst sitzt jemand 7 Minuten vor
//     einem Balken, der sich nicht bewegt.
//
// Hier stehen die Entscheidungen und das Rechnen - kein Netz, kein Schreiben.
// Das Anhaengen an die Leitung liegt in app/arsenalTransferRun.js.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// 64 KiB je Stueck. Klein genug, dass eine einzelne Nachricht niemanden
// umbringt, gross genug, dass der Aufwand je Stueck nicht dominiert.
// Bei 2 GB sind das 32768 Stuecke - bei 50 Mbit/s etwa 100 Stuecke je Sekunde.
export const STUECK_BYTES = 64 * 1024;

// So viele Stuecke duerfen unbetaetigt draussen sein. Ohne Deckel wuerde das
// Senden den Empfaenger ueberholen und den Speicher fluten.
export const FENSTER_STUECKE = 16;

// Zerlegt eine Datei der Laenge `gesamt` in Stuecke.
// Das LETZTE Stueck bekommt den Rest, nicht die volle Groesse: sonst liest
// die Schleife ueber das Dateiende hinaus und schreibt Muell.
export function planeStuecke(gesamt, stueck = STUECK_BYTES) {
  if (!Number.isInteger(gesamt) || gesamt < 0) return [];
  if (!Number.isInteger(stueck) || stueck <= 0) return [];
  const teile = [];
  for (let offset = 0; offset < gesamt; offset += stueck) {
    teile.push({ offset, laenge: Math.min(stueck, gesamt - offset) });
  }
  return teile;
}

// SHA-256 einer Datei, stueckweise gelesen. Eine 2-GB-Datei am Stueck zu
// lesen ist der Unterschied zwischen "laeuft" und "kein Speicher".
export async function sha256VonDatei(pfad) {
  const hash = createHash('sha256');
  return await new Promise((resolve, reject) => {
    const strom = createReadStream(pfad);
    strom.on('data', (stueck) => hash.update(stueck));
    strom.on('end', () => resolve(hash.digest('hex')));
    strom.on('error', reject);
  });
}

// Ist der Transfer wirklich durch?
// Der gefaehrliche Fall: 90 % da, Verbindung weg, irgendwo steht "fertig",
// und das Arsenal installiert eine halbe ZIP. Darum: exakt gleich, nicht ">=".
export function istVollstaendig({ empfangen, gesamt } = {}) {
  return Number.isInteger(empfangen) && Number.isInteger(gesamt)
    && gesamt > 0 && empfangen === gesamt;
}

// Wie weit ist es? 0..100, ganzzahlig, nie ueber 100.
export function fortschrittProzent({ empfangen, gesamt } = {}) {
  if (!Number.isFinite(empfangen) || !Number.isFinite(gesamt) || gesamt <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((empfangen / gesamt) * 100)));
}
