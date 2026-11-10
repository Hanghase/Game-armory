// Tests fuer Start/Stop/Restart eines Docker-Stacks (2026-11-07, v1.3.56).
//
// Ausgangslage: Status und Logs liefen ueber den engen Helfer
// (armory-docker-ctl). Start/Stop lehnte das Panel mit 400 ab, weil der
// Helfer nur `status | ps | logs` kannte. Jetzt kommen dazu:
//
//   start <dienst>   docker compose start <dienst>
//   stop <dienst>    docker compose stop <dienst>
//   restart <dienst> docker compose restart <dienst>
//
// Grenzen, die die Tests festhalten und die NICHT gelockert werden duerfen:
//   - genau EIN Dienst pro Aufruf, muss aus der Whitelist sein
//   - keine freien Argumente, kein "-f", kein Shell-Durchreichen
//   - keine Aktionen wie down/rm/exec/build/run (die zerstoeren oder
//     oeffnen Tueren: `docker exec` im Container ist root im Container)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const REPO = new URL('..', import.meta.url).pathname;
const HELFER = `${REPO}tools/armory-docker-ctl`;

async function quelle() {
  return await readFile(HELFER, 'utf8');
}

// Der Helfer wird mit `bash -n` auf Syntax geprueft und seine Aktionen werden
// gegen einen unlesbaren Compose-Pfad getestet: wir koennen die Aktionen nicht
// wirklich ausfuehren (kein Docker in dieser Pruefung), aber wir koennen
// beweisen, dass die Aktions-Whitelist greift, BEVOR irgendetwas passiert.
// Seit 2026-11-10 (Karte 28) erwartet der Helfer den STACK als erstes
// Argument:  armory-docker-ctl <stack> <aktion> [dienst] [zeilen]
//
// Die Umstellung ist Absicht: der Aufrufer waehlt einen NAMEN, nie einen
// Pfad. Diese zwei Funktionen halten die Absicht sichtbar - `helfer` fuer den
// echten Stack, `helferRoh` fuer Tests, die die Argumente selbst stellen.
function helfer(...args) {
  return helferRoh('nextcloud', ...args);
}

function helferRoh(...args) {
  return spawnSync('bash', [HELFER, ...args], { encoding: 'utf8', timeout: 20000 });
}

test('der Helfer ist syntaktisch gueltig', () => {
  const r = spawnSync('bash', ['-n', HELFER], { encoding: 'utf8' });
  assert.equal(r.status, 0, `bash -n schlaegt fehl: ${r.stderr}`);
});

test('start, stop und restart stehen in der Aktions-Whitelist', async () => {
  const q = await quelle();
  assert.match(q, /ALLOWED_ACTIONS="[^"]*\bstart\b[^"]*"/, 'start fehlt in ALLOWED_ACTIONS');
  assert.match(q, /ALLOWED_ACTIONS="[^"]*\bstop\b[^"]*"/, 'stop fehlt in ALLOWED_ACTIONS');
  assert.match(q, /ALLOWED_ACTIONS="[^"]*\brestart\b[^"]*"/, 'restart fehlt in ALLOWED_ACTIONS');
});

test('eine unbekannte Aktion wird abgewiesen, bevor Docker angefasst wird', () => {
  // `down` wuerde den Stack samt Netzwerk entfernen - nicht erlaubt.
  for (const aktion of ['down', 'rm', 'exec', 'build', 'run', '', 'start;id', '../evil']) {
    const r = helfer(aktion, 'nc-app');
    assert.equal(r.status, 2, `"${aktion}" haette mit 2 abgewiesen werden muessen (status=${r.status})`);
    assert.match(r.stderr, /Unerlaubte Aktion/);
  }
});

test('start ohne Dienstnamen wird abgewiesen', () => {
  const r = helfer('start');
  // Seit 2026-11-10 kommt der Stack zuerst; ohne Dienst ist die Argumentzahl
  // falsch (7). Frueher war es 4, weil die fehlende Dienstliste die erste
  // Pruefung war. Beides ist eine Ablehnung VOR docker - das ist der Punkt.
  assert.equal(r.status, 7, `start ohne Dienst: erwartet 7, kam ${r.status}`);
  assert.match(r.stderr, /Falsche Argumentzahl/);
});

test('ein Dienst ausserhalb der Whitelist wird abgewiesen', () => {
  for (const dienst of ['evil', 'nc-app2', 'nc-app nc-db', '--privileged', '..', 'nc-app/../x']) {
    const r = helfer('stop', dienst);
    assert.equal(r.status, 4, `"${dienst}" haette mit 4 abgewiesen werden muessen (status=${r.status})`);
  }
});

test('ein drittes Argument (freie Kommandozeile) wird abgewiesen', () => {
  // Schutz gegen "restart nc-app --force-recreate" oder angehaengte Flags.
  //
  // ERSTER VERSUCH WAR ZU SCHWACH: geprueft wurde nur rc != 0. Das fing auch
  // den Compose-Fehler ("no such service") ein - die Mutationsprobe blieb
  // gruen, obwohl die Pruefung ausgebaut war. Jetzt wird der EIGENE Code 7
  // verlangt, also die eindeutige Ablehnung durch den Helfer.
  //
  // Seit 2026-11-10 ist die Argumentzahl aktionsabhaengig geprueft: restart
  // nimmt genau `stack aktion dienst`, also drei. Alles darueber ist 7.
  const r = helfer('restart', 'nc-app', '--force-recreate');
  assert.equal(r.status, 7,
    `ueberzaehlige Argumente muessen mit 7 abgewiesen werden, kam ${r.status}`);

  // Und mit --force-recreate als ZWEITEM Dienst (der Fall, den der alte Test
  // in "harmlos aussehend" abdeckte):
  const r2 = helfer('start', 'nc-app', 'nc-db');
  assert.equal(r2.status, 7, 'zwei Dienste in einem Aufruf muessen 7 sein');
});

test('ein harmlos aussehendes Zahlenargument wird abgewiesen', () => {
  // 20 koennte als Zeilenzahl (logs) oder Timeout (stop) durchrutschen.
  // Bei stop/restart nimmt der Helfer KEINE vierte Angabe.
  assert.equal(helfer('stop', 'nc-app', '20').status, 7,
    'ein Zahlenargument darf nicht als Timeout durchrutschen');
});

test('die Compose-Datei kommt aus der Tabelle, nie aus einem Argument', async () => {
  const q = await quelle();

  // Seit 2026-11-10 steht der Pfad NICHT mehr als feste Zuweisung im Skript,
  // sondern in der Stack-Tabelle. Das ist die Erweiterung fuer Karte 28 - aber
  // die Sicherheitseigenschaft ist dieselbe und wird hier festgehalten:
  // der Pfad kommt aus dem Skript, niemals aus der Kommandozeile.
  assert.match(q, /^STACKS="/m, 'die Stack-Tabelle fehlt');
  assert.match(q, /nextcloud\|\/opt\/nextcloud\/docker-compose\.yml\|/,
    'der Nextcloud-Stack muss in der Tabelle stehen');

  // Er darf NIE aus der Aufrufer-Eingabe kommen. Erster Testversuch war hier
  // falsch: das Muster sprang auf `compose -f "$COMPOSE_FILE"` an, also auf
  // den richtigen Code - ein Test, der immer rot ist, prueft nichts.
  // Jetzt gezielt: kein "$1"/"$2"/"${1}"/"${2}" auf der Compose-Zeile, und
  // die Hilfsfunktion uebergibt ausschliesslich die Variable.
  const composeZeilen = q.split('\n').filter((z) => /compose\s+-f/.test(z) && !/^\s*#/.test(z));
  assert.ok(composeZeilen.length > 0, 'die compose-Hilfsfunktion fehlt');
  for (const z of composeZeilen) {
    assert.match(z, /compose\s+-f\s+"\$COMPOSE_FILE"/,
      `Compose-Datei kommt nicht aus $COMPOSE_FILE: ${z.trim()}`);
    assert.ok(!/\$\{?[123]\}?/.test(z),
      `Compose-Datei darf nicht aus einem Argument kommen: ${z.trim()}`);
  }

  // Und der Stackname selbst darf nur ueber pruefe_stack in COMPOSE_FILE
  // muenden - der Pfad wird aus der Tabelle gelesen, nicht zusammengebaut.
  assert.match(q, /COMPOSE_FILE="\$\(stack_datei "\$stack"\)"/,
    'COMPOSE_FILE muss aus stack_datei kommen');
});

test('die Whitelist prueft exakt, nicht als Teilstring', async () => {
  // Regression: der alte case-Vergleich gegen " nc-app nc-db nc-redis " liess
  // "nc-app nc-db" durch - docker compose bekam daraus ZWEI Dienste.
  //
  // Seit 2026-11-10 geht der Aufruf ueber helferRoh, damit der Stack mitgeht.
  for (const dienst of ['nc-app nc-db', 'nc-app  ', ' nc-app', 'nc-app\tnc-db']) {
    const r = helferRoh('nextcloud', 'stop', dienst);
    assert.equal(r.status, 4,
      `"${dienst}" kam durch die Whitelist (rc=${r.status}) - das waere freie Kommandozeile`);
  }
});

// --- Anwendung: dockerAction + Endpunkt ---------------------------------------
//
// Hier wird NICHT der Helfer ausgefuehrt (das waere ein echter Eingriff in den
// Nextcloud-Stack). Die Aufrufform wird mit injiziertem `run` geprueft - das
// ist derselbe Weg, den dockerStatus/dockerLogs schon nutzen.

test('dockerAction ruft den Helfer mit Aktion und Dienst auf', async () => {
  const { dockerAction } = await import('../app/control.js');
  const aufrufe = [];
  const run = async (prog, args) => { aufrufe.push([prog, ...args]); return { stdout: 'nc-app\n' }; };

  const r = await dockerAction({ compose: '/opt/nextcloud/docker-compose.yml' },
    'nc-app', 'restart', { run });

  assert.equal(r.ok, true);
  // Seit 2026-11-10 steht der Stackname VOR der Aktion. Der Pfad geht nie
  // mit - das bleibt die Sicherheitseigenschaft, nur mit einem Namen davor.
  assert.deepEqual(aufrufe[0],
    ['sudo', '-n', '/usr/local/bin/armory-docker-ctl', 'nextcloud', 'restart', 'nc-app']);
});

test('dockerAction lehnt eine unerlaubte Aktion OHNE Prozessstart ab', async () => {
  const { dockerAction } = await import('../app/control.js');
  const aufrufe = [];
  const run = async (prog, args) => { aufrufe.push(args); return { stdout: '' }; };

  const r = await dockerAction({ compose: '/opt/nextcloud/docker-compose.yml' },
    'nc-app', 'down', { run });

  assert.equal(r.ok, false);
  assert.equal(aufrufe.length, 0, 'fuer "down" darf kein Prozess starten');
  assert.match(r.error, /Nicht erlaubt|unerlaubt/i);
});

test('dockerAction lehnt einen Dienst ohne compose-Bezug ab', async () => {
  const { dockerAction } = await import('../app/control.js');
  const aufrufe = [];
  const run = async (prog, args) => { aufrufe.push(args); return { stdout: '' }; };

  const r = await dockerAction({ compose: '/opt/nextcloud/docker-compose.yml' },
    'nc-app nc-db', 'stop', { run });
  assert.equal(r.ok, false);
  assert.equal(aufrufe.length, 0, 'ein Dienst mit Leerzeichen darf keinen Prozess starten');
});

test('dockerAction meldet einen Fehler des Helfers als ok:false', async () => {
  const { dockerAction } = await import('../app/control.js');
  const run = async () => {
    const e = new Error('Command failed');
    e.stderr = 'Dienst nicht erlaubt: nc-app2';
    throw e;
  };
  const r = await dockerAction({ compose: '/opt/nextcloud/docker-compose.yml' },
    'nc-app', 'stop', { run });
  assert.equal(r.ok, false);
  assert.match(r.error, /Dienst nicht erlaubt/);
});

test('der compose-Pfad muss gueltig sein, sonst kein Aufruf', async () => {
  const { dockerAction } = await import('../app/control.js');
  const aufrufe = [];
  const run = async (prog, args) => { aufrufe.push(args); return { stdout: '' }; };
  const r = await dockerAction({ compose: '../../etc/passwd' }, 'nc-app', 'start', { run });
  assert.equal(r.ok, false);
  assert.equal(aufrufe.length, 0);
});

test('die sudoers-Beschreibung nennt start/stop/restart', async () => {
  // Die Regel selbst ist unveraendert (der Pfad bleibt derselbe), aber der
  // Kommentar dort sprach von "KEIN start/stop/restart" - das waere jetzt eine
  // falsche Aussage an der Stelle, wo jemand die Rechte prueft.
  const r = spawnSync('sudo', ['-n', 'cat', '/etc/sudoers.d/armory'],
    { encoding: 'utf8', timeout: 10000 });
  const text = r.stdout || '';
  assert.ok(text.includes('/usr/local/bin/armory-docker-ctl'),
    'die sudoers-Regel fuer den Docker-Helfer fehlt');
  assert.ok(!/KEIN start\/stop\/restart/.test(text),
    'der sudoers-Kommentar behauptet noch, start/stop/restart seien gesperrt');
  assert.match(text, /start\s*\|\s*stop\s*\|\s*restart|start \| stop \| restart/,
    'der Kommentar sollte die Aktionen nennen, die jetzt erlaubt sind');
});

test('start wird OHNE --timeout aufgerufen, stop/restart MIT', async () => {
  // Live erwischt am 2026-11-07: `docker compose start --timeout 20` bricht ab
  // mit "unknown flag: --timeout" - das Flag kennt nur stop und restart.
  // Ein Testlauf kann das nicht ausfuehren (echter Stack), deshalb wird die
  // Aufrufform im Skript geprueft: der start-Zweig darf kein --timeout haben.
  const q = await quelle();
  // Schnitt bis zum `exit 0` des start-Zweigs, nicht bis zum ersten "--timeout":
  // der erste Versuch lief bis in den Kommentar der stop-Zeile und schlug
  // darum immer fehl (ein Test, der immer rot ist, prueft nichts).
  const a = q.indexOf('if [[ "$action" == "start" ]]');
  assert.ok(a > 0, 'der start-Zweig fehlt');
  const b = q.indexOf('exit 0', a);
  const startZweig = q.slice(a, b + 6);
  assert.ok(startZweig.length > 0, 'der start-Zweig fehlt');
  assert.match(startZweig, /compose start "\$service"/,
    'start muss ohne Zusatzflags aufgerufen werden');
  assert.ok(!/--timeout/.test(startZweig),
    'im start-Zweig darf kein --timeout stehen (kennt docker compose start nicht)');

  // und der stop/restart-Pfad hat es weiterhin
  assert.match(q, /compose "\$action" --timeout 20 "\$service"/,
    'stop/restart soll weiterhin ein Timeout setzen');
});

// --- Reihenfolge beim starten --------------------------------------------------
//
// Live erwischt am 2026-11-07: `start` rief nc-app zuerst auf, nc-db und
// nc-redis danach. Nextcloud oeffnete schon, bevor die Datenbank lief ->
// "Connection refused" und HTTP 500 fuer ~20 Sekunden.
//
// docker-compose sagt es selbst: nc-app hat depends_on [nc-db, nc-redis].
// Beim START muss also die Abhaengigkeit zuerst hoch, beim STOPP umgekehrt.

test('beim Starten stehen Datenbank und Cache vor der Anwendung', async () => {
  const { dockerReihenfolge } = await import('../app/control.js');
  const dienste = ['nc-app', 'nc-db', 'nc-redis'];

  assert.deepEqual(dockerReihenfolge(dienste, 'start'),
    ['nc-db', 'nc-redis', 'nc-app'],
    'start muss die Abhaengigkeiten zuerst hochfahren');

  assert.deepEqual(dockerReihenfolge(dienste, 'stop'),
    ['nc-app', 'nc-db', 'nc-redis'],
    'stop muss die Anwendung zuerst runterfahren');

  // restart: pro Dienst Neustart, die Reihenfolge ist dann unkritisch,
  // aber Abhaengigkeiten weiterhin zuerst (die App startet gegen eine
  // bereits laufende DB).
  assert.deepEqual(dockerReihenfolge(dienste, 'restart'),
    ['nc-db', 'nc-redis', 'nc-app']);
});

test('unbekannte Dienste bleiben drin, nur nach hinten sortiert', async () => {
  const { dockerReihenfolge } = await import('../app/control.js');
  // Ein Stack mit anderem Namen darf nicht verschwinden - sonst wuerde ein
  // kuenftiger zweiter Docker-Stack gar nicht gestartet.
  const r = dockerReihenfolge(['app', 'db'], 'start');
  assert.equal(r.length, 2, 'kein Dienst darf verloren gehen');
  assert.deepEqual([...r].sort(), ['app', 'db']);
});

test('der Endpunkt benutzt die Reihenfolge wirklich', async () => {
  // Die Tests oben pruefen nur dockerReihenfolge selbst. Die Mutationsprobe
  // ("for (const dienst of dienste)") blieb damit GRUEN - genau die Luecke,
  // in die ich am 2026-11-07 schon einmal getappt bin (dockerStatus gruen,
  // Panel rot). Hier wird der Quelltext der Route geprueft: die Schleife im
  // docker-Zweig muss durch dockerReihenfolge laufen.
  const { readFile } = await import('node:fs/promises');
  const q = await readFile(new URL('../app/server.js', import.meta.url), 'utf8');
  const zweig = q.slice(q.indexOf("if (controlKind(sword) === 'docker')"));
  const schleife = zweig.slice(0, zweig.indexOf('clearPendingRestart'));
  assert.match(schleife, /for \(const dienst of dockerReihenfolge\(/,
    'der docker-Zweig muss ueber dockerReihenfolge laufen, nicht roh ueber dienste');
});
