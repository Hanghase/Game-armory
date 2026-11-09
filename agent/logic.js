// Arsenal-Agent: die Pruef- und Entscheidungslogik, ohne Netz und ohne Prozesse.
//
// Getrennt von run.js (dem Programm), damit die Sicherheitspruefung ohne
// WebSocket und ohne systemctl testbar ist. Genau diese Trennung fehlte beim
// ersten Anlauf (2026-11-09): die Logik lag in derselben Datei wie das
// Programm und war damit nur ueber Umwege pruefbar.
//
// Aufgabe: verbindet sich mit der Armory, haelt die Leitung offen, schickt
// Lebenszeichen und beantwortet Befehle. Kein Port nach aussen, weil die
// Verbindung VON HIER aus aufgebaut wird (docs/arsenale-konzept.md).
//
// Sicherheit:
// - Der Schluessel kommt aus /etc/armory-arsenal/arsenal.json und steht nie in
//   einem Log oder einer Fehlermeldung.
// - Befehle werden gegen eine FESTE WHITELIST geprueft, bevor irgendetwas
//   passiert. Der Agent prueft selbst, was er annimmt - er verlaesst sich
//   NICHT darauf, dass die Armory nur Vernuenftiges schickt. Wer die Armory
//   uebernimmt, kommt so nicht automatisch an alle Arsenale.
// - Es wird nichts aus dem Befehl als Shell ausgefuehrt. Der Name muss ein
//   registrierter Dienst sein, die Aktion eine feste Zeichenkette.

// Erlaubte Aktionen. Mehr nicht - die Liste ist absichtlich kurz.
export const ALLOWED_ACTIONS = Object.freeze([
  'status',
  'start',
  'stop',
  'restart',
]);

// Erlaubte Form eines Dienstnamens (systemd-Unit). Keine Punkte am Anfang,
// keine Leerzeichen, keine Shell-Metazeichen.
export const SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9@._-]{0,63}$/;

// Wie oft sich der Agent meldet, wenn sonst nichts passiert.
export const HEARTBEAT_MS = 30 * 1000;

// Nach dieser Zeit ohne Nachricht gilt die Leitung als tot und wird neu
// aufgebaut. Ohne das merkt der Agent einen stillen Abbruch nie - die
// TCP-Verbindung kann tot sein, ohne dass ein 'close' kommt.
export const IDLE_RECONNECT_MS = 75 * 1000;

// Prueft einen Befehl, bevor er ausgefuehrt wird.
// Rueckgabe: { ok: true, service, action } oder { ok: false, reason }
//
// Wichtig: die Pruefung ist absichtlich streng und schlaegt bei allem fehl,
// was nicht exakt passt. Ein "unbekannte Aktion" ist ein Fehler, kein "dann
// eben status".
export function validateCommand(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'bad-message' };
  if (msg.type !== 'command') return { ok: false, reason: 'not-a-command' };

  const action = msg.action;
  if (typeof action !== 'string' || !ALLOWED_ACTIONS.includes(action)) {
    return { ok: false, reason: 'bad-action' };
  }

  const service = msg.service;
  // status braucht keinen Dienst: es fragt "was laeuft hier" und nicht
  // "was macht Dienst X".
  if (action === 'status') {
    if (service === undefined || service === null) {
      return { ok: true, service: null, action };
    }
  }

  if (typeof service !== 'string' || !SERVICE_RE.test(service)) {
    return { ok: false, reason: 'bad-service' };
  }

  // Zusaetzlich: ein Name mit ".." oder "/" ist keine Unit. Die Regex deckt
  // das schon ab, aber ein zweiter Blick kostet nichts und faengt eine
  // spaetere Lockerung der Regex ab.
  if (service.includes('/') || service.includes('..')) {
    return { ok: false, reason: 'bad-service' };
  }

  return { ok: true, service, action };
}

// Baut die Nachricht fuer den Lebenszeichen-Kanal.
export function heartbeatMessage({ id, version, hostname }) {
  return {
    type: 'heartbeat',
    id,
    version: typeof version === 'string' ? version.slice(0, 40) : null,
    hostname: typeof hostname === 'string' ? hostname.slice(0, 64) : null,
  };
}

// Entscheidet, ob die Leitung neu aufgebaut werden muss.
// `lastMessageAt` ist der Zeitpunkt der letzten beliebigen Nachricht.
export function shouldReconnect({ now, lastMessageAt, idleMs = IDLE_RECONNECT_MS }) {
  if (!Number.isFinite(lastMessageAt)) return true;
  return now - lastMessageAt > idleMs;
}

// Naechste Wartezeit bei Verbindungsfehlern: verdoppelt sich, gedeckelt.
// Ein Agent, der im Sekundentakt neu verbindet, legt die Armory lahm.
export function nextBackoff(current, capMs = 60_000) {
  const start = Number.isFinite(current) && current > 0 ? current : 1000;
  return Math.min(start * 2, capMs);
}
