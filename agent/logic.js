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
  // Das Fernupdate des Arsenals selbst. Kein Dienstname: es betrifft genau
  // diesen Rechner, nicht eine Unit darauf.
    'update',
    // Ein gezogenes Paket auf diesem Arsenal entpacken. Kein Dienstname,
    // sondern pullId + swordId - eigene Pruefung in validateInstall.
    'install',
]);

// Aktionen, die KEINEN Dienstnamen brauchen.
//
// restart stand hier frueher NICHT und bedeutete "starte Dienst X neu". Seit
// 2026-11-09 bedeutet es am Arsenal "starte den Agenten selbst neu" (Felix:
// der Agent haengt, ich will ihn ohne SSH neu starten). Die Bedeutung hat
// sich geaendert, nicht die Zeichenkette - darum steht der Grund hier.
// Ein restart MIT Dienstnamen bleibt trotzdem erlaubt: wer bewusst eine Unit
// auf dem Arsenal neu starten will, soll das koennen (die Route bietet es
// nicht an, der Weg ueber die Leitung bleibt aber offen).
export const OHNE_DIENST = Object.freeze(['status', 'update', 'restart', 'install']);

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

  // install traegt zwei EIGENE Felder statt eines Dienstnamens. Der Zweig
  // steht vor der Dienstpruefung, weil ein fehlender Dienst sonst als
  // 'bad-service' zurueckkaeme - ein Grund, der den wahren Fehler verdeckt.
  if (action === 'install') {
    const p = validateInstall({ type: 'install', pullId: msg.pullId, swordId: msg.swordId });
    if (!p.ok) return { ok: false, reason: p.reason };
    return { ok: true, action, pullId: p.pullId, swordId: p.swordId, service: null };
  }

  const service = msg.service;
  // status und update brauchen keinen Dienst: status fragt "was laeuft hier",
  // update betrifft das Arsenal selbst.
  if (OHNE_DIENST.includes(action)) {
    if (service === undefined || service === null) {
      return { ok: true, service: null, action };
    }
  }

  // Ein restart MIT Dienst bleibt ein Dienst-Neustart - aber nur, wenn der
  // Name die Pruefung unten besteht. Hier wird nichts durchgewinkt.


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

// --- Ziehen einer Datei ----------------------------------------------------
//
// Das Arsenal ZIEHT (docs/arsenale-konzept.md): die Armory schickt nicht, das
// Arsenal holt. Der Befehl 'pull' sagt nur, WAS geholt werden soll. Die
// Stuecke kommen danach als Binaernachrichten, nicht als JSON - eine ZIP als
// base64 waere ein Drittel mehr Verkehr und dreimal so viel Speicher.
//
// Diese Funktion prueft NUR die Ansage. Ein zweiter Blick auf jedes Feld,
// weil hier ein Pfad drinsteht: ein Pfad aus dem Netz ist der klassische Weg
// fuer "schreib mir mal was nach /etc".

export const MAX_PULL_BYTES = 4 * 1024 ** 3; // 4 GiB - groesser ist kein Modpack

// Erlaubte Ziele. Das Arsenal legt Packs in sein eigenes Verzeichnis; ein
// Ziel ausserhalb waere ein Schreibzugriff irgendwohin.
export const ZIEL_WURZEL = '/var/lib/armory-arsenal/packs';

export function validatePull(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'bad-message' };
  if (msg.type !== 'pull') return { ok: false, reason: 'nicht-pull' };

  // Die Kennung ordnet spaetere Stuecke zu. Muss eine Hexkennung sein, damit
  // sie nie als Pfad oder Dateiname missverstanden werden kann.
  if (typeof msg.id !== 'string' || !/^[a-f0-9]{8,64}$/.test(msg.id)) {
    return { ok: false, reason: 'bad-id' };
  }

  const { gesamt, sha256, name } = msg;
  if (!Number.isInteger(gesamt) || gesamt <= 0 || gesamt > MAX_PULL_BYTES) {
    return { ok: false, reason: 'bad-groesse' };
  }
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) {
    return { ok: false, reason: 'bad-pruefsumme' };
  }

  // Der Dateiname kommt vom Server. Er darf NICHTS ueber den Ort bestimmen:
  // kein Schraegstrich, kein .., kein Punkt am Anfang. Der Ordner wird hier
  // festgelegt, nie uebernommen.
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
    return { ok: false, reason: 'bad-name' };
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.')) {
    return { ok: false, reason: 'bad-name' };
  }
  // Steuerzeichen im Namen (z.B. \x00) wuerden im Dateisystem abgeschnitten
  // und koennten auf einen anderen Namen zeigen, als geprueft wurde.
  if (/[\x00-\x1f\x7f]/.test(name)) return { ok: false, reason: 'bad-name' };

  return {
    ok: true,
    id: msg.id,
    gesamt,
    sha256: sha256.toLowerCase(),
    ziel: `${ZIEL_WURZEL}/${name}`,
    auftragId: typeof msg.auftragId === 'string' ? msg.auftragId : null,
  };
}

// --- Entpacken nach dem Ziehen --------------------------------------------
//
// Das Arsenal hat die ZIP. Jetzt entpacken - aber NICHT "irgendwohin".
//
// Der Helfer armory-install-helper laeuft als root und kann Dinge, die der
// Agent nicht koennen soll (useradd, chown, systemd-Units). Ihn mit einem
// Pfad aus dem Netz zu fuettern waere der direkte Weg zu root. Darum wird
// hier geprueft: nur Dateien aus UNSEREM Pack-Ordner, nur ein Name ohne Pfad.
//
// Der Helfer selbst prueft zusaetzlich (er ist die letzte Instanz), aber der
// Agent prueft zuerst - wer die Armory uebernimmt, kommt so nicht automatisch
// an root auf allen Arsenalen.

export const PACK_HELFER = '/usr/local/bin/armory-install-helper';

// Wie ein Sword heissen darf. Gleiche Regel wie beim Helfer: mindestens zwei
// Zeichen, keine Sonderzeichen. Ein Name ist auch ein Systembenutzer.
export const SWORD_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function validateInstall(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'bad-message' };
  if (msg.type !== 'install') return { ok: false, reason: 'nicht-install' };

  // Welche gezogene Datei? Die Kennung kommt aus dem pull, den WIR gemacht
  // haben. Ein Dateiname aus dem Befehl waere ein Pfad.
  if (typeof msg.pullId !== 'string' || !/^[a-f0-9]{8,64}$/.test(msg.pullId)) {
    return { ok: false, reason: 'bad-pull' };
  }

  // Der Name des Swords - wird zum Systembenutzer und zum Ordner.
  if (typeof msg.swordId !== 'string' || !SWORD_ID_RE.test(msg.swordId)) {
    return { ok: false, reason: 'bad-sword' };
  }
  // Die Pruefung oben ist bereits vollstaendig: [a-z0-9-] laesst weder '/'
  // noch '.' durch, damit auch kein '..'. Eine zweite Schranke hier waere
  // toter Code - und ein Test dafuer waere ein Test, der nie rot werden kann.
  //
  // Das ist ABSICHTLICH so und wurde am 2026-11-09 nachgemessen: die Mutation
  // "Zusatzpruefung entfernen" blieb gruen, weil sie nie gegriffen hat. Wer
  // die Regex spaeter lockert, muss hier wieder eine Schranke einziehen -
  // darum steht der Hinweis hier und nicht nur im Kopf.


  return { ok: true, pullId: msg.pullId, swordId: msg.swordId };
}
