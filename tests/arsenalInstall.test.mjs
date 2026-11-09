// Der 'install'-Befehl: entpacken auf dem Arsenal.
//
// Hier geht ein Name an einen Helfer, der als ROOT laeuft und useradd, chown
// und systemd-Units kann. Ein Pfad oder ein Name mit Sonderzeichen waere der
// direkte Weg zu root - darum hat jedes Feld einen Test, der bei Lockerung
// rot wird.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateInstall, PACK_HELFER, SWORD_ID_RE } from '../agent/logic.js';

const GUT = { type: 'install', pullId: 'abc123def456', swordId: 'atm11' };

test('ein sauberer Befehl wird angenommen', () => {
  const r = validateInstall(GUT);
  assert.equal(r.ok, true);
  assert.equal(r.swordId, 'atm11');
});

test('der Helferpfad steht fest im Code', () => {
  // Kein Pfad aus dem Befehl. Ein anderer Helfer waere ein anderer Befehl.
  assert.equal(PACK_HELFER, '/usr/local/bin/armory-install-helper');
});

test('ein Name mit Pfadanteil wird abgelehnt', () => {
  for (const swordId of ['../etc', 'a/b', 'x/..', 'atm11/evil']) {
    assert.equal(validateInstall({ ...GUT, swordId }).ok, false, `akzeptiert: ${swordId}`);
  }
});

test('ein Name mit Sonderzeichen wird abgelehnt', () => {
  // Der Name wird Systembenutzer UND Ordnername. Leerzeichen, Semikolon,
  // Backtick - alles, was in einer Shell oder einem Pfad Aerger macht.
  for (const swordId of ['atm 11', 'atm11;ls', 'atm`id`', 'atm11$(id)', 'ATM11', 'a', '']) {
    assert.equal(validateInstall({ ...GUT, swordId }).ok, false, `akzeptiert: ${swordId}`);
  }
});

test('ein Name mit . beginnt nicht - sonst waere es ein verstecktes Verzeichnis', () => {
  assert.equal(SWORD_ID_RE.test('.atm11'), false);
});

test('eine unbrauchbare pull-Kennung wird abgelehnt', () => {
  for (const pullId of ['', 'ABC', '../x', 'a'.repeat(65), 'zzzz1234', null, 42]) {
    assert.equal(validateInstall({ ...GUT, pullId }).ok, false, `akzeptiert: ${JSON.stringify(pullId)}`);
  }
});

test('etwas, das kein install ist, wird abgelehnt', () => {
  assert.equal(validateInstall({ ...GUT, type: 'pull' }).ok, false);
  assert.equal(validateInstall(null).ok, false);
});

// --- Der Agent ruft den Helfer NUR mit festen Argumenten ------------------
// Dieselbe Pruefung wie bei validateCommand, aber fuer den Install-Schritt:
// "Funktion getestet, Aufrufer ungeprueft" ist der Fehler, der in diesem
// Projekt am haeufigsten war.

const agentQuelle = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');

test('der Agent ruft den Helfer mit extract-pack und fester Argumentfolge', () => {
  // PACK_HELFER ist eine Konstante, keine Zeichenkette im Aufruf - deshalb
  // ohne schliessendes Anfuehrungszeichen pruefen. Der Punkt ist die feste
  // Argumentfolge als ARRAY (kein Shell-String).
  // Der Aufruf steht jetzt mehrzeilig (Zielordner als eigenes Argument), darum
  // ohne Zeilenkopplung pruefen: execFileP(PACK_HELFER, ... 'extract-pack'
  assert.match(
    agentQuelle,
    /execFileP\(\s*PACK_HELFER,\s*\[\s*'extract-pack'/,
    'extract-pack wird nicht (oder nicht mit festen Argumenten) aufgerufen',
  );
});

test('install steht VOR validateCommand im Verteiler', () => {
  // Sonst landet 'install' bei validateCommand, das es nicht kennt und
  // ablehnt - der Befehl kaeme nie beim Helfer an. Die Funktion waere
  // getestet und gruen, der Aufrufweg tot.
  const iInstall = agentQuelle.indexOf("msg.type === 'install'");
  const iCmd = agentQuelle.indexOf('validateCommand(msg)');
  assert.ok(iInstall > 0, 'install wird im Verteiler nicht behandelt');
  assert.ok(iInstall < iCmd, 'install wird erst nach validateCommand geprueft');
});

test('der Agent baut keine Shell um den Helfer', () => {
  const aufruf = agentQuelle.slice(agentQuelle.indexOf("'extract-pack'"));
  const bisEnde = aufruf.slice(0, aufruf.indexOf(']'));
  assert.doesNotMatch(bisEnde, /exec\(|spawn\(|`.*\$\{.*\}`[^,]*,?\s*\]/, 'Shell im Helferaufruf');
});

// --- Der Pfad kommt aus dem PULL, nicht aus einer eigenen Rechnung --------
// Fehler in 1.5.4: `install` baute den Pfad selbst als
//   `${ZIEL_WURZEL}/${pullId}.zip`
// Der Pull legt die Datei aber unter dem Namen ab, den die ARMORY schickt
// ('atm11-server.zip'). Mit der pullId waere daraus
//   /var/lib/armory-arsenal/packs/16d9a6bb....zip
// geworden - eine Datei, die es nie gab. Der Helfer haette
// "ZIP nicht lesbar" gemeldet, und die Ursache waere zwei Ebenen tiefer.

test('install baut den Pfad NICHT aus der pullId', () => {
  const i = agentQuelle.indexOf('async function entpackeDatei');
  assert.ok(i > 0, 'entpackeDatei fehlt');
  const rumpf = agentQuelle.slice(i, agentQuelle.indexOf('\n  // --- Verbindung', i));
  assert.doesNotMatch(
    rumpf,
    /\$\{ZIEL_WURZEL\}[^\n]*pullId[^\n]*\.zip/,
    'der Pfad wird aus der pullId gebaut statt aus dem gemerkten Pull-Ziel',
  );
});

test('install schlaegt das Ziel des Pulls nach', () => {
  const i = agentQuelle.indexOf('async function entpackeDatei');
  const rumpf = agentQuelle.slice(i, agentQuelle.indexOf('\n  // --- Verbindung', i));
  assert.match(rumpf, /gezogeneDatei|zielVonPull|ziele\.get|merkeZiel/i, 'kein Nachschlagen des Pull-Ziels');
});

test('das Ziel wird beim Abschluss des Pulls gemerkt', () => {
  // Ohne Merken ist der install-Befehl nach dem Pull wertlos: der Eintrag in
  // laufendePulls wird bei beende() geloescht.
  assert.match(agentQuelle, /gezogeneDatei\.set\(/, 'kein Merken des Ziels');
  assert.match(agentQuelle, /gezogeneDatei\.delete\(/, 'das Ziel wird nie aufgeraeumt');
});

test('ein unbekannter pullId liefert einen klaren Grund', () => {
  const i = agentQuelle.indexOf('async function entpackeDatei');
  const rumpf = agentQuelle.slice(i, agentQuelle.indexOf('\n  // --- Verbindung', i));
  assert.match(rumpf, /unbekannt|nicht-gezogen|kein-pull/i, 'unbekannter pullId wird nicht benannt');
});

// --- install als ACTION im command, nicht als eigener Typ -----------------
// Der Weg ueber die Leitung ist { type:'command', action, ... } mit einer
// festen Aktionsliste auf BEIDEN Seiten (Route und Agent). Ein zweiter
// Nachrichtentyp daneben waere ein zweiter Weg, den die Route nicht kennt -
// und damit ein Weg, der im Panel nicht existiert.

test('install steht in den erlaubten Aktionen des Agenten', async () => {
  const { ALLOWED_ACTIONS } = await import('../agent/logic.js');
  assert.ok(ALLOWED_ACTIONS.includes('install'), 'install fehlt in ALLOWED_ACTIONS');
});

test('install braucht KEINEN Dienstnamen, sondern pullId und swordId', async () => {
  const { OHNE_DIENST } = await import('../agent/logic.js');
  assert.ok(OHNE_DIENST.includes('install'), 'install verlangt faelschlich einen Dienst');
});

test('validateCommand reicht pullId und swordId fuer install durch', async () => {
  const { validateCommand } = await import('../agent/logic.js');
  const r = validateCommand({
    type: 'command', action: 'install',
    pullId: 'cc8c7fdc1de778162f61b4822d79d714', swordId: 'atm11',
  });
  assert.equal(r.ok, true, `abgelehnt: ${r.reason}`);
  assert.equal(r.pullId, 'cc8c7fdc1de778162f61b4822d79d714');
  assert.equal(r.swordId, 'atm11');
});

test('install ohne pullId wird abgelehnt', async () => {
  const { validateCommand } = await import('../agent/logic.js');
  for (const pullId of [undefined, null, '', 'XYZ', '../x']) {
    const r = validateCommand({ type: 'command', action: 'install', pullId, swordId: 'atm11' });
    assert.equal(r.ok, false, `akzeptiert: ${JSON.stringify(pullId)}`);
  }
});

test('install ohne brauchbaren swordId wird abgelehnt', async () => {
  const { validateCommand } = await import('../agent/logic.js');
  for (const swordId of [undefined, '', '../etc', 'a b', 'ATM11']) {
    const r = validateCommand({
      type: 'command', action: 'install',
      pullId: 'cc8c7fdc1de778162f61b4822d79d714', swordId,
    });
    assert.equal(r.ok, false, `akzeptiert: ${JSON.stringify(swordId)}`);
  }
});

test('die ROUTE kennt install ebenfalls', async () => {
  // Zwei Seiten eines Protokolls. Was der Agent kann und die Route nicht,
  // ist im Panel nicht erreichbar - und umgekehrt eine offene Weiterleitung.
  const route = await readFile(new URL('../app/arsenalRoutes.js', import.meta.url), 'utf8');
  const m = /const ERLAUBTE_AKTIONEN = \[([^\]]*)\]/.exec(route);
  assert.ok(m, 'ERLAUBTE_AKTIONEN nicht gefunden');
  assert.ok(m[1].includes("'install'"), `install fehlt in der Aktionsliste der Route: ${m[1]}`);
});

test('die Route reicht pullId und swordId weiter, nicht als Dienst', async () => {
  // "Zwei Seiten eines Protokolls" heisst: was die Route weiterreicht, muss
  // beim Agenten ankommen. Ein {action:'install'} ohne pullId waere dort
  // 'bad-pull' - im Panel saehe das wie ein Serverfehler aus.
  const route = await readFile(new URL('../app/arsenalRoutes.js', import.meta.url), 'utf8');
  const i = route.indexOf("action === 'install'");
  assert.ok(i > 0, 'die Route hat keinen install-Zweig');
  const rumpf = route.slice(i, i + 900);
  assert.match(rumpf, /pullId/, 'pullId wird nicht weitergereicht');
  assert.match(rumpf, /swordId/, 'swordId wird nicht weitergereicht');
  assert.doesNotMatch(rumpf, /service/, 'install schleust sich ueber den Dienst-Pfad');
});

// --- Der Benutzer muss VOR dem Entpacken da sein -------------------------
// Live gemessen am 2026-11-09:
//   install atm11: fehlgeschlagen - chown: invalid user: 'atm11:atm11'
// Der Helfer legt keinen Benutzer an (bewusst: Benutzerverwaltung ist mehr
// als entpacken). Also muss der Agent es tun - VORHER, wie installer.js auf
// der Armory (Zeile 623). Ohne diese Reihenfolge scheitert jeder erste
// Install auf einem frischen Arsenal, und zwar mit einer Meldung, die nach
// Rechteproblem klingt statt nach fehlendem Schritt.

test('der Agent legt den Benutzer VOR dem Entpacken an', () => {
  const i = agentQuelle.indexOf('async function entpackeDatei');
  assert.ok(i > 0, 'entpackeDatei fehlt');
  const rumpf = agentQuelle.slice(i, agentQuelle.indexOf('\n  // --- Verbindung', i));

  const iUser = rumpf.indexOf("'useradd'");
  const iPack = rumpf.indexOf("'extract-pack'");
  assert.ok(iUser > 0, 'useradd wird nicht aufgerufen - der erste Install scheitert');
  assert.ok(iPack > 0, 'extract-pack fehlt');
  assert.ok(iUser < iPack, 'useradd kommt NACH extract-pack - dann ist der Benutzer zu spaet da');
});

test('useradd laeuft ueber den Helfer, nicht ueber die Shell', () => {
  const i = agentQuelle.indexOf('async function entpackeDatei');
  const rumpf = agentQuelle.slice(i, agentQuelle.indexOf('\n  // --- Verbindung', i));
  const zeile = rumpf.slice(rumpf.indexOf("'useradd'") - 60, rumpf.indexOf("'useradd'") + 40);
  assert.match(zeile, /execFileP\(PACK_HELFER|execFileP\(\s*PACK_HELFER/, `kein fester Helferaufruf: ${zeile}`);
});

test('ein bereits vorhandener Benutzer ist kein Fehler', () => {
  // Der Helfer antwortet "user exists" mit Exit 0. Der Agent darf daraus
  // keinen Abbruch machen - sonst liesse sich derselbe Sword nie neu
  // installieren.
  const i = agentQuelle.indexOf('async function entpackeDatei');
  const rumpf = agentQuelle.slice(i, agentQuelle.indexOf('\n  // --- Verbindung', i));
  assert.match(rumpf, /user exists|bestand|existiert/i, 'vorhandener Benutzer wird nicht behandelt');
});

// --- Das entpackte Pack darf NICHT in einem privaten /tmp liegen ---------
// Live gemessen am 2026-11-09: der Agent meldete "entpackt nach
// /tmp/armory-pack-zAiNmD", und keine Sekunde spaeter war der Ordner weg.
// Ursache: die Unit hat PrivateTmp=yes. Der Agent sieht ein EIGENES /tmp,
// das mit dem Dienst verschwindet - beim naechsten Neustart waere der
// entpackte Sword weg, ohne dass jemand es merkt.
//
// Der Helfer allein ist unschuldig: von Hand aufgerufen liegt der Ordner
// da und gehoert atm11. Der Fehler ist der ORT.

test('der Agent entpackt unter das Packverzeichnis, nicht nach /tmp', () => {
  const i = agentQuelle.indexOf('async function entpackeDatei');
  const rumpf = agentQuelle.slice(i, agentQuelle.indexOf('\n  // --- Verbindung', i));
  // extract-pack bekommt ein Zielverzeichnis als drittes Argument.
  const m = /'extract-pack',\s*p\.swordId,\s*ziel,\s*([A-Za-z_]+)/.exec(rumpf);
  assert.ok(m, 'extract-pack-Aufruf mit Zielordner nicht gefunden');
  assert.equal(m[1], 'PACK_ORDNER', `falsches Packverzeichnis: ${m[1]}`);
  assert.doesNotMatch(rumpf, /'extract-pack',\s*p\.swordId,\s*ziel\s*\]/, 'kein Zielordner - landet im privaten /tmp');
});

test('der Agent warnt, wenn PrivateTmp das Aufraeumen verursacht', () => {
  // Ein stiller Verlust ist schlimmer als ein Fehler: der Sword laege bis zum
  // naechsten Neustart da und waere dann weg.
  const i = agentQuelle.indexOf('async function entpackeDatei');
  const rumpf = agentQuelle.slice(i, agentQuelle.indexOf('\n  // --- Verbindung', i));
  assert.match(rumpf, /bestand|liegt|bleibt|dauerhaft/i, 'kein Hinweis, dass der Ordner dauerhaft bleiben muss');
});
