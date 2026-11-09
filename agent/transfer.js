// Das Arsenal ZIEHT eine Datei von der Armory - die Empfangsseite.
//
// Hier stehen die Entscheidungen: welches Stueck passt, wann ist die Datei
// fertig, stimmt die Pruefsumme. Das Schreiben auf die Platte und das
// Sprechen ueber die Leitung liegt in agent/transferRun.js.
//
// DER GRUND FUER DIE STRENGE:
//   Ein halb geschriebener Download sieht wie ein fertiger aus, wenn niemand
//   nachsieht. Dann installiert das Arsenal eine kaputte ZIP, und alle suchen
//   am falschen Ende ("kein gueltiges Archiv"). Darum:
//     - Stuecke muessen lueckenlos und in der richtigen Reihenfolge kommen
//     - doppelte Stuecke werden erkannt, nicht doppelt gezaehlt
//     - "fertig" heisst exakt am Ende, nicht "fast"
//     - die Pruefsumme entscheidet, nicht der Byte-Zaehler

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// Empfaenger fuer eine angekuendigte Datei.
//   gesamt: Groesse in Bytes (von der Armory angekuendigt)
//   sha256: erwartete Pruefsumme
export function erstelleEmpfaenger({ gesamt, sha256 } = {}) {
  if (!Number.isInteger(gesamt) || gesamt <= 0) {
    throw new Error(`ungueltige Groesse: ${gesamt}`);
  }
  let empfangen = 0;
  const empfangen_offsets = new Set();

  return {
    // Nimmt ein Stueck an oder lehnt es ab.
    // Rueckgabe: { ok: true, empfangen } oder { ok: false, grund }
    nimm({ offset, daten } = {}) {
      if (!Number.isInteger(offset) || offset < 0) {
        return { ok: false, grund: 'offset-unbrauchbar' };
      }
      if (!daten || typeof daten.length !== 'number') {
        return { ok: false, grund: 'keine-daten' };
      }

      // Ueber das Ende hinaus? Nicht "abschneiden" - ablehnen. Ein
      // abgeschnittenes Stueck wuerde die Pruefsumme spaeter kippen, und
      // dann sucht jemand an der falschen Stelle.
      if (offset + daten.length > gesamt) {
        return { ok: false, grund: 'ueber-das-ende' };
      }

      // Doppelt? Bei einer wackeligen Leitung kommt ein Stueck schon mal
      // zweimal. Stillschweigend zu addieren zerlegt den Zaehler - und am
      // Ende schlaegt die Pruefsumme fehl, ohne dass jemand weiss warum.
      if (empfangen_offsets.has(offset)) {
        return { ok: false, grund: 'schon-da' };
      }

      // Luecke? Ein verspaetetet Stueck mitten in die Datei zu schreiben
      // macht Muell aus etwas, das schon fast fertig war.
      if (offset !== empfangen) {
        return { ok: false, grund: 'offset-falsch' };
      }

      empfangen_offsets.add(offset);
      empfangen += daten.length;
      return { ok: true, empfangen };
    },

    stand() {
      return { empfangen, gesamt, prozent: Math.floor((empfangen / gesamt) * 100) };
    },

    // Exakt am Ende, nicht "fast". 99 von 100 Bytes ist keine fertige Datei.
    istFertig() {
      return empfangen === gesamt;
    },

    erwarteteSumme: sha256 ?? null,
  };
}

// Stimmt die Datei mit ihrer Pruefsumme ueberein?
// Stueckweise gelesen: eine 2-GB-Datei am Stueck zu lesen ist der Unterschied
// zwischen "laeuft" und "kein Speicher".
export async function pruefeDatei(pfad, erwartet) {
  if (typeof erwartet !== 'string' || !/^[0-9a-f]{64}$/i.test(erwartet)) {
    return false; // Ohne brauchbare Erwartung kann nichts bestaetigt werden.
  }
  try {
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => {
      const strom = createReadStream(pfad);
      strom.on('data', (stueck) => hash.update(stueck));
      strom.on('end', resolve);
      strom.on('error', reject);
    });
    return hash.digest('hex').toLowerCase() === erwartet.toLowerCase();
  } catch {
    // Fehlende Datei ist ein Fehler, kein "stimmt schon".
    return false;
  }
}
