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
      // Das Entpackte ins Spielverzeichnis setzen, mit Sicherung vorher.
      // Ebenfalls kein Dienstname; eigene Pruefung in validateEinsetzen.
      //
      // Live am 2026-11-09 vergessen: die Armory liess den Auftrag durch,
      // der Agent antwortete "bad-action", und im Panel sah es nach einem
      // Netzproblem aus. Bei einer neuen Aktion sind es VIER Stellen - diese
      // hier ist die zweite.
      'einsetzen',
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
export const OHNE_DIENST = Object.freeze(['status', 'update', 'restart', 'install', 'einsetzen']);

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

// Wohin ein entpacktes Pack kommt. NICHT /tmp: die Unit hat PrivateTmp=yes,
// das Temp des Agenten verschwindet mit dem Dienst (live gemessen 2026-11-09).
// Hier bleibt es liegen, und der Helfer kennt den Pfad als erlaubten Root.
export const PACK_ORDNER = '/var/lib/armory-arsenal/packs/entpackt';

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

// --- Einsetzen: aus dem entpackten Pack wird der Sword --------------------
//
// Bis hierher endet der install-Weg beim Entpacken. Das Pack liegt unter
// PACK_ORDNER, der Sword unter /opt/minecraft/<id> hat davon nichts. Felix am
// 2026-11-09: "ja bitte" - also einsetzen.
//
// Das ist der Schritt mit dem groessten Schaden: ein falsches Pack ueber eine
// bestehende Welt kopiert, und die Welt ist weg. Darum gilt hier:
//   - Quelle MUSS unter EINSETZ_ORDNER liegen (kein Pfad-Ausbruch)
//   - Teile sind Eintraege IM Pack, nie Pfade
//   - die Sicherung laeuft VOR dem Kopieren (siehe sichereVorEinsetzen)

// Wo entpackte Packs liegen. Absichtlich dieselbe Wurzel wie PACK_ORDNER.
export const EINSETZ_ORDNER = PACK_ORDNER;

// Wie viele Eintraege ein Pack hoechstens ersetzen darf. Ein Modpack hat
// mods, config, kubejs, defaultconfigs, scripts, resourcepacks - sechs. 40 ist
// grosszuegig und verhindert trotzdem, dass jemand 10.000 Eintraege schickt.
export const MAX_TEILE = 40;

// Ein Teilname ist ein Eintrag im Pack: "mods", "config", "kubejs". Kein Pfad.
// Gleiche Regel wie im Helfer (valid_pack_name), hier gespiegelt - der Agent
// prueft zuerst, der Helfer nochmal.
export const TEIL_RE = /^[a-zA-Z0-9._-]{1,64}$/;

function teilOk(t) {
  if (typeof t !== 'string') return false;
  if (t === '.' || t === '..') return false;
  if (t.includes('..')) return false;
  if (t.includes('/') || t.includes('\\')) return false;
  return TEIL_RE.test(t);
}

// Liegt der Pfad unter EINSETZ_ORDNER? Nach dem Aufloesen von '..', nicht
// davor - "/a/b/../../etc" besteht die Textpruefung sonst.
function unterEinsetzOrdner(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return false;
  if (p.includes('\0')) return false;
  const wurzel = EINSETZ_ORDNER.endsWith('/') ? EINSETZ_ORDNER : EINSETZ_ORDNER + '/';
  // Textuell: muss mit dem Ordner beginnen und danach noch etwas kommen.
  if (!p.startsWith(wurzel)) return false;
  const rest = p.slice(wurzel.length);
  if (rest.length === 0) return false;
  // Und der Rest darf nicht aus dem Ordner herausfuehren.
  const teile = rest.split('/');
  let tiefe = 0;
  for (const t of teile) {
    if (t === '' || t === '.') continue;
    if (t === '..') {
      tiefe -= 1;
      if (tiefe < 0) return false;  // ueber den Ordner hinaus
      continue;
    }
    tiefe += 1;
  }
  return tiefe > 0;
}

// Wo ein Sword liegen darf. Dieselbe Liste wie im Helfer
// (ALLOWED_ROOTS in /usr/local/bin/armory-install-helper) - der Helfer prueft
// sie nochmal, aber wer die Armory uebernimmt, soll hier schon scheitern.
export const ERLAUBTE_SWORD_WURZELN = ['/opt/minecraft', '/opt/7d2d', '/opt/teamspeak6', '/opt/satisfactory'];

// Der Arbeitsordner eines Swords. Er kommt aus der Nachricht (die Armory kennt
// ihn aus ihrer Sword-Datei), wird aber hier geprueft:
//   - unter einer erlaubten Wurzel
//   - GENAU eine Ebene tiefer (/opt/minecraft ist der Elternordner aller
//     Swords - dort zu ersetzen traefe alle Instanzen)
//   - kein '..', kein Symlink-verdaechtiger Doppelpfad
export function pruefeArbeitsVerzeichnis(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return false;
  if (p.includes('\0')) return false;
  const sauber = p.split('/');
  let tiefe = 0;
  const teile = [];
  for (const t of sauber) {
    if (t === '' || t === '.') continue;
    if (t === '..') {
      tiefe -= 1;
      if (tiefe < 0) return false;
      teile.pop();
      continue;
    }
    tiefe += 1;
    teile.push(t);
  }
  const normal = '/' + teile.join('/');
  for (const w of ERLAUBTE_SWORD_WURZELN) {
    if (!normal.startsWith(w + '/')) continue;
    const rest = normal.slice(w.length + 1);
    // Genau eine Ebene: "atm11" ja, "atm11/mods" nein, "" nein.
    if (rest.length === 0 || rest.includes('/')) return false;
    return normal;
  }
  return false;
}

export function validateEinsetzen(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'bad-message' };
  if (msg.type !== 'einsetzen') return { ok: false, reason: 'nicht-einsetzen' };

  if (typeof msg.swordId !== 'string' || !SWORD_ID_RE.test(msg.swordId)) {
    return { ok: false, reason: 'bad-sword' };
  }

  const arbeitsVerzeichnis = pruefeArbeitsVerzeichnis(msg.arbeitsVerzeichnis);
  if (!arbeitsVerzeichnis) {
    return { ok: false, reason: 'bad-arbeitsverzeichnis' };
  }

  if (typeof msg.quelle !== 'string' || !unterEinsetzOrdner(msg.quelle)) {
    return { ok: false, reason: 'bad-quelle' };
  }

  if (!Array.isArray(msg.teile)) return { ok: false, reason: 'keine-teile' };
  if (msg.teile.length === 0) return { ok: false, reason: 'keine-teile' };
  if (msg.teile.length > MAX_TEILE * 4) return { ok: false, reason: 'zu-viele-teile' };

  for (const t of msg.teile) {
    if (!teilOk(t)) return { ok: false, reason: 'bad-teil' };
  }

  // Doppelte zusammenfassen: sonst kopiert der Helfer 'mods' dreimal und die
  // Sicherung traegt denselben Eintrag dreimal.
  const teile = [...new Set(msg.teile)];
  if (teile.length > MAX_TEILE) return { ok: false, reason: 'zu-viele-teile' };

  return { ok: true, swordId: msg.swordId, quelle: msg.quelle, arbeitsVerzeichnis, teile };
}

// Sicherung VOR dem Einsetzen. Nicht optional: wer die Welt ueberschreibt,
// ohne vorher zu sichern, hat keine zweite Chance.
//
// Rueckgabe: der Pfad der Sicherung, oder ein Fehler. Ein "keine Sicherung,
// aber weiter" gibt es hier absichtlich NICHT.
export async function sichereVorEinsetzen({ swordId, arbeitsVerzeichnis, helfer, execFileP }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
  const label = `vor-einsetzen-${stamp}`.slice(0, 40);
  const { stdout } = await execFileP(
    helfer,
    ['backup-tar', swordId, label, arbeitsVerzeichnis, 'mods', 'config', 'kubejs', 'defaultconfigs', 'scripts', 'resourcepacks', 'world', 'server.properties'],
    { timeout: 300_000, maxBuffer: 64 * 1024 },
  );
  const m = /^backup ok (\S+)$/m.exec(String(stdout));
  if (!m) {
    // Kein Pfad = keine Sicherung = kein Einsetzen. Der Grund ist ein fester
    // Text, nie der rohe Helfer-Output.
    return { ok: false, grund: 'sicherung-ohne-pfad' };
  }
  return { ok: true, pfad: m[1] };
}

