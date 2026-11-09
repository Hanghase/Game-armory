// Die Armory SENDET - aber nur, weil das Arsenal zieht.
//
// Das klingt nach Wortklauberei und ist der Kern: der Agent fragt an ("bereit"),
// die Armory antwortet mit Stuecken. Die Armory schiebt niemandem etwas hin,
// was nicht angefordert wurde. Wer die Armory uebernimmt, kann einem Arsenal
// damit nichts andrehen, was es nicht selbst angefordert hat.
//
// Hier stehen die Entscheidungen - welches Stueck kommt als naechstes, wann
// ist der Pull fertig, was passiert bei Abbruch. Kein Netz, kein Dateihandle:
// das liegt in app/arsenalTransferRun.js.
//
// Der Ablauf:
//   1. Armory schickt { type:'pull', id, gesamt, sha256, name }
//   2. Arsenal antwortet { type:'bereit', id }
//   3. Armory schickt Stuecke (binaer, 8 Bytes Kopf)
//   4. Arsenal antwortet nichts - es schreibt und meldet am Ende
//   5. Arsenal meldet { type:'pull-fertig' } oder { type:'pull-abbruch' }

// Wie viele Stuecke hoechstens unbetaetigt draussen sein duerfen.
//
// Ohne Deckel schreibt die Schleife die ganze Datei in den Sendepuffer: bei
// 2 GB auf einem schwachen Arsenal ist das ein Speicher-Abschuss auf BEIDEN
// Seiten. Der Deckel ist die Bremse.
export const FENSTER_STUECKE = 8;

// Nach dieser Zeit ohne Lebenszeichen gilt der Pull als haengend. Ein Pull,
// der nie fertig wird, muss aufgeraeumt werden - sonst bleibt der Auftrag
// ewig "laeuft" und der Takt bleibt auf 15 s.
export const PULL_STILL_MS = 90_000;

// Der Zustand eines laufenden Pulls auf der Armory-Seite.
//
// Bewusst als reine Daten + Funktionen: so ist jede Entscheidung ohne
// WebSocket und ohne Datei pruefbar.
export function erstellePull({ id, gesamt, sha256, name, arsenalId, auftragId = null }) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8,64}$/.test(id)) {
    throw new Error('pull: unbrauchbare Kennung');
  }
  if (!Number.isInteger(gesamt) || gesamt <= 0) {
    throw new Error('pull: unbrauchbare Groesse');
  }
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error('pull: unbrauchbare Pruefsumme');
  }
  if (typeof name !== 'string' || !name) {
    throw new Error('pull: unbrauchbarer Name');
  }
  return {
    id,
    gesamt,
    sha256: sha256.toLowerCase(),
    name,
    arsenalId,
    auftragId,
    gesendet: 0, // wie viele Bytes schon raus sind
    bereit: false, // hat das Arsenal "bereit" gesagt?
    letzteAktion: Date.now(),
  };
}

// Welches Stueck kommt als naechstes? null heisst: alles raus.
//
// Die Rueckgabe traegt Offset UND Laenge. Ohne die Laenge muesste der Sender
// aus "wie viel ist schon gesendet" rechnen - und beim letzten Stueck daneben
// liegen, weil dort der Rest kleiner ist als ein volles Stueck.
export function naechstesStueck(pull, stueckBytes = 64 * 1024) {
  if (!pull || !pull.bereit) return null;
  if (pull.gesendet >= pull.gesamt) return null;
  const laenge = Math.min(stueckBytes, pull.gesamt - pull.gesendet);
  return { offset: pull.gesendet, laenge };
}

// Kann noch etwas raus, ohne den Puffer zu fluten?
export function darfSenden(pull, unbetaetigt, fenster = FENSTER_STUECKE) {
  if (!pull || !pull.bereit) return false;
  if (pull.gesendet >= pull.gesamt) return false;
  return unbetaetigt < fenster;
}

// Haengt der Pull? Ohne diese Pruefung bleibt ein abgebrochener Pull ewig
// "laeuft", und niemand merkt, dass das Arsenal nie fertig wird.
export function haengtSeit(pull, now = Date.now(), stillMs = PULL_STILL_MS) {
  if (!pull) return false;
  return now - pull.letzteAktion > stillMs;
}

// Baut die Ansage an das Arsenal.
//
// Das ZIEL steht NICHT drin. Das Arsenal legt selbst fest, wohin es schreibt
// (siehe agent/logic.js ZIEL_WURZEL) - sonst waere die Namenspruefung dort
// umgehbar, und ein Pfad aus dem Netz koennte nach /etc zeigen.
export function pullAnsage(pull) {
  return {
    type: 'pull',
    id: pull.id,
    gesamt: pull.gesamt,
    sha256: pull.sha256,
    name: pull.name,
    ...(pull.auftragId ? { auftragId: pull.auftragId } : {}),
  };
}
