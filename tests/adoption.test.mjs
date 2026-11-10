// Pruefungen fuer das Uebernehmen (Karte 28).
//
// Diese Tests fassen NICHTS an: kein Docker, kein systemd, kein echtes /opt.
// Alles laeuft ueber injizierte Abhaengigkeiten (deps.run / deps.stat / ...),
// das ist das Muster aus tests/dockerAction.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  zerlegePsZeile,
  gruppiereStacks,
  erkenneDienstart,
  istServerUnit,
  zerlegeUnit,
  findeKandidaten,
  PS_FORMAT,
} from '../app/adopt.js';

import {
  pruefeSteuerart,
  pruefeArbeitsverzeichnis,
  pruefeStruktur,
  pruefePort,
  pruefeLogquelle,
  pruefeAdoption,
  PRUEFUNGEN,
} from '../app/adoptpruefung.js';

// --- Docker-Auswertung ---------------------------------------------------

// Echte Ausgabe von felsis.de, am 2026-11-10 mit genau diesem Format geholt.
const ECHTE_ZEILEN = [
  'nc-app|nextcloud:stable-apache|nextcloud|/opt/nextcloud/docker-compose.yml|nc-app|false|Up 25 hours',
  'nc-db|mariadb:11.8|nextcloud|/opt/nextcloud/docker-compose.yml|nc-db|false|Up 25 hours',
  'nc-redis|redis:8-alpine|nextcloud|/opt/nextcloud/docker-compose.yml|nc-redis|false|Up 25 hours',
];

test('eine docker-ps-Zeile wird in ihre Felder zerlegt', () => {
  const c = zerlegePsZeile(ECHTE_ZEILEN[0]);
  assert.equal(c.name, 'nc-app');
  assert.equal(c.image, 'nextcloud:stable-apache');
  assert.equal(c.project, 'nextcloud');
  assert.equal(c.configFiles, '/opt/nextcloud/docker-compose.yml');
  assert.equal(c.service, 'nc-app');
  assert.equal(c.oneoff, false);
  assert.equal(c.laeuft, true);
});

test('eine gestoppte Zeile gilt nicht als laufend', () => {
  const c = zerlegePsZeile('nc-app|nextcloud:x|nextcloud|/opt/x.yml|nc-app|false|Exited (0) 2 hours ago');
  assert.equal(c.laeuft, false);
});

test('eine kaputte Zeile ergibt null statt eines halben Objekts', () => {
  assert.equal(zerlegePsZeile('nc-app|nextcloud:x'), null);
  assert.equal(zerlegePsZeile(''), null);
});

test('Container desselben Projekts werden zu einem Stack', () => {
  const container = ECHTE_ZEILEN.map(zerlegePsZeile);
  const stacks = gruppiereStacks(container);

  assert.equal(stacks.length, 1);
  assert.equal(stacks[0].name, 'nextcloud');
  assert.equal(stacks[0].dienste.length, 3);
  assert.deepEqual(stacks[0].dienste.map((d) => d.service), ['nc-app', 'nc-db', 'nc-redis']);
  assert.equal(stacks[0].laeuft, true);
  assert.deepEqual(stacks[0].quellen, ['/opt/nextcloud/docker-compose.yml']);
});

test('ein oneoff-Container gehoert nicht zum Stack', () => {
  const container = [
    zerlegePsZeile(ECHTE_ZEILEN[0]),
    zerlegePsZeile('nc-run|nextcloud:x|nextcloud|/opt/nextcloud/docker-compose.yml|nc-app|true|Up 2 minutes'),
  ];
  const stacks = gruppiereStacks(container);
  assert.equal(stacks[0].dienste.length, 1, 'der Einmalbefehl darf nicht als Dienst zaehlen');
});

test('ein Container ohne Compose-Projekt bildet keinen Stack', () => {
  const container = [zerlegePsZeile('lose|busybox|||lose|false|Up 1 hour')];
  const stacks = gruppiereStacks(container);
  assert.equal(stacks.length, 0);
});

test('mehrere Projekte ergeben mehrere Stacks', () => {
  const container = [
    ...ECHTE_ZEILEN.map(zerlegePsZeile),
    zerlegePsZeile('www|nginx:1|website|/srv/www/compose.yml|web|false|Up 3 hours'),
  ];
  const stacks = gruppiereStacks(container);
  assert.equal(stacks.length, 2);
  assert.deepEqual(stacks.map((s) => s.name).sort(), ['nextcloud', 'website']);
});

// --- Dienstart erkennen --------------------------------------------------

test('Nextcloud wird aus App + Datenbank im selben Stack erkannt', () => {
  const stacks = gruppiereStacks(ECHTE_ZEILEN.map(zerlegePsZeile));
  const art = erkenneDienstart(stacks[0]);
  assert.ok(art, 'Nextcloud muss erkannt werden');
  assert.equal(art.id, 'nextcloud');
  assert.equal(art.sicher, true);
});

test('ein einsamer mariadb-Container wird NICHT als Nextcloud erkannt', () => {
  // Genau die Falle aus dem Spaehbericht: mariadb:11.8 allein beweist nichts.
  const stack = {
    name: 'dbonly',
    dienste: [{ service: 'db', image: 'mariadb:11.8', laeuft: true }],
  };
  assert.equal(erkenneDienstart(stack), null);
});

test('ein einsamer redis-Container wird NICHT als Nextcloud erkannt', () => {
  const stack = { name: 'cache', dienste: [{ service: 'r', image: 'redis:8-alpine', laeuft: true }] };
  assert.equal(erkenneDienstart(stack), null);
});

test('Nextcloud ohne Datenbank wird als UNSICHER gemeldet, nicht abgelehnt', () => {
  const stack = {
    name: 'halb',
    dienste: [{ service: 'app', image: 'nextcloud:stable-apache', laeuft: true }],
  };
  const art = erkenneDienstart(stack);
  assert.ok(art, 'die App wurde gefunden und soll gemeldet werden');
  assert.equal(art.sicher, false);
  assert.match(art.grund, /keine Datenbank/);
});

test('der Container-Name allein entscheidet nichts', () => {
  // Ein fremder Stack nennt seinen Container nc-app - das darf NICHT
  // ausreichen. Nur das Image zaehlt.
  const stack = {
    name: 'fremd',
    dienste: [{ service: 'nc-app', image: 'eigenes-app:1.0', laeuft: true }],
  };
  assert.equal(erkenneDienstart(stack), null);
});

test('eine Unit-Zeile wird zerlegt', () => {
  const u = zerlegeUnit('atm11.service|active|running');
  assert.equal(u.unit, 'atm11.service');
  assert.equal(u.laeuft, true);
});

test('eine gescheiterte Unit gilt nicht als laufend', () => {
  const u = zerlegeUnit('atm11.service|failed|failed');
  assert.equal(u.laeuft, false);
});

test('Systemdienste werden als Server-Kandidat ausgeschlossen', () => {
  assert.equal(istServerUnit({ unit: 'cron.service' }), false);
  assert.equal(istServerUnit({ unit: 'ssh.service' }), false);
  assert.equal(istServerUnit({ unit: 'systemd-journald.service' }), false);
  assert.equal(istServerUnit({ unit: 'atm11.service' }), true);
  assert.equal(istServerUnit({ unit: 'teamspeak6.service' }), true);
});

test('findeKandidaten liefert Docker-Stacks und systemd-Units getrennt', async () => {
  const run = async (prog) => {
    if (prog === 'docker') return { stdout: ECHTE_ZEILEN.join('\n') };
    if (prog === 'systemctl') {
      return { stdout: 'atm11.service|active|running\ncron.service|active|running' };
    }
    return { stdout: '' };
  };
  const k = await findeKandidaten({ run });

  const docker = k.filter((x) => x.quelle === 'docker');
  const systemd = k.filter((x) => x.quelle === 'systemd');

  assert.equal(docker.length, 1);
  assert.equal(docker[0].id, 'nextcloud');
  assert.equal(docker[0].sicher, true);

  assert.equal(systemd.length, 1, 'cron darf nicht als Kandidat auftauchen');
  assert.equal(systemd[0].id, 'atm11');
  assert.equal(systemd[0].rackId, null, 'die Dienstart einer Unit ist nicht ableitbar');
  assert.equal(systemd[0].sicher, false);
});

test('ohne Docker und ohne systemd kommt eine leere Liste, kein Fehler', async () => {
  const run = async () => { throw new Error('nicht vorhanden'); };
  const k = await findeKandidaten({ run });
  assert.deepEqual(k, []);
});

test('das Abfrageformat fragt nach den Compose-Labels', () => {
  // Wenn jemand das Format aendert, sollen die Labels nicht stillschweigend
  // verschwinden - ohne sie ist die Erkennung wertlos.
  assert.match(PS_FORMAT, /com\.docker\.compose\.project/);
  assert.match(PS_FORMAT, /com\.docker\.compose\.service/);
  assert.match(PS_FORMAT, /config_files/);
  assert.match(PS_FORMAT, /oneoff/);
});

// --- Fuenf Pruefungen ----------------------------------------------------

const KANDIDAT = {
  quelle: 'docker',
  id: 'nextcloud',
  quellen: ['/opt/nextcloud/docker-compose.yml'],
  arbeitsVerzeichnis: '/opt/nextcloud',
  port: 8088,
  logs: { type: 'docker', service: 'nc-app' },
  marker: ['docker-compose.yml'],
};

test('alle fuenf Pruefungen bestanden ergibt ok:true', async () => {
  const deps = {
    realpath: async (p) => p,
    access: async () => {},
    stat: async () => ({ isDirectory: () => true, uid: 979, gid: 979 }),
    run: async (prog) => {
      if (prog === 'ss') return { stdout: 'State Recv-Q Send-Q Local Peer\nLISTEN 0 511 127.0.0.1:8088 0.0.0.0:*' };
      return { stdout: '' };
    },
  };
  const r = await pruefeAdoption(KANDIDAT, deps);
  assert.equal(r.ok, true, `offen: ${r.offen.join(', ')}`);
  assert.deepEqual(r.offen, []);
});

test('Port lauscht nicht: die Adoption scheitert', async () => {
  const deps = {
    realpath: async (p) => p,
    access: async () => {},
    stat: async () => ({ isDirectory: () => true, uid: 979, gid: 979 }),
    run: async () => ({ stdout: 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*' }),
  };
  const r = await pruefeAdoption(KANDIDAT, deps);
  assert.equal(r.ok, false);
  assert.ok(r.offen.includes('port'));
  assert.match(r.pruefungen.port.grund, /lauscht nicht/);
});

test('Compose-Datei fehlt: die Adoption scheitert', async () => {
  const deps = {
    realpath: async () => { throw new Error('ENOENT'); },
    access: async () => {},
    stat: async () => ({ isDirectory: () => true, uid: 1, gid: 1 }),
    run: async () => ({ stdout: 'LISTEN 0 511 127.0.0.1:8088 0.0.0.0:*' }),
  };
  const r = await pruefeAdoption(KANDIDAT, deps);
  assert.equal(r.ok, false);
  assert.ok(r.offen.includes('steuerart'));
});

test('Arbeitsverzeichnis fehlt: die Adoption scheitert', async () => {
  const deps = {
    realpath: async (p) => p,
    access: async () => {},
    stat: async (p) => {
      if (p === '/opt/nextcloud') throw new Error('ENOENT');
      return { isDirectory: () => true, uid: 1, gid: 1 };
    },
    run: async () => ({ stdout: 'LISTEN 0 511 127.0.0.1:8088 0.0.0.0:*' }),
  };
  const r = await pruefeAdoption(KANDIDAT, deps);
  assert.equal(r.ok, false);
  assert.ok(r.offen.includes('arbeitsverzeichnis'));
});

test('ohne Struktur-Marker ist das Ergebnis UNBEKANNT, nicht ok', async () => {
  // Genau die Falle: "ich weiss es nicht" darf nie als "in Ordnung" zaehlen.
  const ohneMarker = { ...KANDIDAT, marker: [] };
  const deps = {
    realpath: async (p) => p,
    access: async () => {},
    stat: async () => ({ isDirectory: () => true, uid: 1, gid: 1 }),
    run: async () => ({ stdout: 'LISTEN 0 511 127.0.0.1:8088 0.0.0.0:*' }),
  };
  const r = await pruefeAdoption(ohneMarker, deps);
  assert.equal(r.ok, false, 'unbekannt darf nie als bestanden gelten');
  assert.ok(r.offen.includes('struktur'));
  assert.equal(r.pruefungen.struktur.unbekannt, true);
});

test('fehlende Struktur wird mit Namen genannt', async () => {
  const deps = {
    realpath: async (p) => p,
    access: async () => {},
    stat: async (p) => {
      if (p === '/opt/nextcloud/docker-compose.yml') throw new Error('ENOENT');
      return { isDirectory: () => true, uid: 1, gid: 1 };
    },
    run: async () => ({ stdout: 'LISTEN 0 511 127.0.0.1:8088 0.0.0.0:*' }),
  };
  const r = await pruefeAdoption(KANDIDAT, deps);
  assert.match(r.pruefungen.struktur.grund, /docker-compose\.yml/);
});

test('Log-Datei nicht lesbar: die Adoption scheitert', async () => {
  const deps = {
    realpath: async (p) => p,
    access: async (p) => { if (p.endsWith('.log')) throw new Error('EACCES'); },
    stat: async () => ({ isDirectory: () => true, uid: 1, gid: 1 }),
    run: async () => ({ stdout: 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*' }),
  };
  const r = await pruefeLogquelle({
    ...KANDIDAT, port: 3000, logs: { type: 'file', path: '/var/log/x.log' },
  }, deps);
  assert.equal(r.ok, false);
  assert.match(r.grund, /nicht lesbar/);
});

test('ein Port ohne Nummer wird abgelehnt, nicht geraten', async () => {
  const r = await pruefePort({ port: 'achttausend' }, { run: async () => ({ stdout: '' }) });
  assert.equal(r.ok, false);
  assert.match(r.grund, /kein gültiger Port/);
});

test('ss nicht lesbar ist UNBEKANNT, nicht bestanden', async () => {
  const r = await pruefePort({ port: 8088 }, { run: async () => { throw new Error('kein ss'); } });
  assert.equal(r.ok, false);
  assert.equal(r.unbekannt, true);
});

test('Port-Treffer braucht die genaue Nummer, kein Praefix', async () => {
  // 8088 darf NICHT durch eine Zeile mit 80880 bestehen.
  const r = await pruefePort({ port: 8088 }, {
    run: async () => ({ stdout: 'LISTEN 0 511 127.0.0.1:80880 0.0.0.0:*' }),
  });
  assert.equal(r.ok, false, '80880 ist nicht 8088');
});

test('es gibt genau fuenf Pruefungen und jede wird ausgefuehrt', async () => {
  assert.deepEqual(PRUEFUNGEN, ['steuerart', 'arbeitsverzeichnis', 'struktur', 'port', 'logquelle']);
  const deps = {
    realpath: async (p) => p,
    access: async () => {},
    stat: async () => ({ isDirectory: () => true, uid: 1, gid: 1 }),
    run: async () => ({ stdout: 'LISTEN 0 511 127.0.0.1:8088 0.0.0.0:*' }),
  };
  const r = await pruefeAdoption(KANDIDAT, deps);
  for (const name of PRUEFUNGEN) {
    assert.ok(name in r.pruefungen, `${name} fehlt im Bericht`);
  }
});

// --- Nachträglich am 2026-11-10: zwei live gefundene Fehler ----------------
//
// Beide wären durch die Tests oben NICHT aufgefallen, weil die Testdaten
// schon im Pipe-Format waren und der Filter nie gegen echte Hosts lief.

test('systemctl-Ausgabe mit Leerzeichen wird zerlegt', () => {
  // GEMESSEN: `systemctl list-units` liefert LEERZEICHEN-getrennt, nicht '|'.
  // Meine erste Fassung zerlegte nach '|' und bekam 0 Zeilen - die Erkennung
  // hätte jeden Game-Server verschluckt, ohne einen Fehler zu melden.
  const echt = 'atm11.service              loaded active running All the Mods11 Minecraft Server (Game-Armory)';
  const u = zerlegeUnit(echt);
  assert.ok(u, 'eine echte systemctl-Zeile muss erkannt werden');
  assert.equal(u.unit, 'atm11.service');
  assert.equal(u.laeuft, true);
});

test('eine gestoppte systemctl-Zeile gilt nicht als laufend', () => {
  const u = zerlegeUnit('atm11.service loaded inactive dead All the Mods11');
  assert.equal(u.laeuft, false);
});

test('Infrastruktur-Units werden nicht als Server gemeldet', () => {
  // GEMESSEN: mit einem zu laschen Filter kamen 28 "Kandidaten" heraus,
  // darunter containerd, syslog-ng, uuidd und unattended-upgrades.
  for (const u of ['containerd.service', 'syslog-ng.service', 'uuidd.service',
    'unattended-upgrades.service', 'mdmonitor.service', 'tailscaled.service',
    'serial-getty@ttyS1.service', 'sw-cp-server.service']) {
    assert.equal(istServerUnit({ unit: u }), false, `${u} darf kein Server-Kandidat sein`);
  }
});

test('echte Dienste werden gemeldet', () => {
  for (const u of ['atm11.service', 'atm10.service', '7d2d.service',
    'teamspeak6.service', 'mariadb.service', 'redis-server.service']) {
    assert.equal(istServerUnit({ unit: u }), true, `${u} sollte ein Kandidat sein`);
  }
});

test('die Beschreibung kann einen Dienst ausmachen, wenn der Name nichts sagt', () => {
  // Eine Unit wie `server1.service` ist ohne Beschreibung nicht einzuordnen -
  // mit "Minecraft Server" schon.
  assert.equal(istServerUnit({ unit: 'mc1.service', beschreibung: 'Minecraft Server' }), true);
});
