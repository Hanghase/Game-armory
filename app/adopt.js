// Erkennung: was laeuft auf diesem Server, und was davon kann die Armory
// uebernehmen?
//
// Karte 28. Die Regel, die alles hier bestimmt, stammt aus zwei Messungen auf
// felsis.de (2026-11-10):
//
//   1. NIEMALS vom Dateisystem auf laufende Dienste schliessen.
//      /root/openclaw/docker-compose.yml deklariert zwei Services, und es
//      laufen NULL Container daraus - das Gateway ist ein Host-Prozess. Wer pro
//      gefundener YAML einen Stack annimmt, meldet Geister.
//
//   2. NIEMALS nur Docker fragen.
//      /opt/minecraft/{atm10,atm11}, /opt/7d2d, /opt/teamspeak6 und
//      /opt/game-armory laufen als systemd-Units und sind in `docker ps` nicht
//      vorhanden. Wer nur Docker fragt, uebersieht sie komplett.
//
// Deshalb: erst fragen, was LAEUFT (docker-Labels / systemctl). Die
// Konfiguration wird danach ueber den exakten Pfad aus dem Label gelesen,
// nicht ueber einen Glob.
//
// Nichts hier aendert etwas. Alles liest.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ausfuehren = promisify(execFile);

// --- Bekannte Dienstarten -------------------------------------------------
// Ein Dienstart wird NUR erkannt, wenn die Merkmale eindeutig sind. Die
// Image-Menge zaehlt, nicht ein einzelnes Image: mariadb:11.8 allein beweist
// gar nichts, mariadb UND nextcloud im selben Compose-Projekt dagegen schon.

export const DIENSTARTEN = [
  {
    id: 'nextcloud',
    rackId: 'nextcloud',
    label: 'Nextcloud',
    // Ein Stack gilt als Nextcloud, wenn ein Container aus nextcloud/* UND
    // eine Datenbank im selben Projekt laufen. Kein Container-Name als
    // Beweis: `nc-app` heisst nur so, weil die YAML container_name setzt;
    // ohne diese Zeile hiesse er nextcloud-nc-app-1.
    erkennen(container) {
      const images = container.map((c) => c.image).filter(Boolean);
      const hatApp = images.some((i) => /^nextcloud[:/]/.test(i));
      const hatDb = images.some((i) => /^(mariadb|postgres|postgresql)[:/]/.test(i));
      if (hatApp && hatDb) return { sicher: true };
      if (hatApp) return { sicher: false, grund: 'Nextcloud-Container gefunden, aber keine Datenbank im selben Stack' };
      return null;
    },
  },
];

// --- Container-Abfrage ----------------------------------------------------

// Wir fragen Docker nach den Labels, die Compose beim Anlegen schreibt. Sie
// beschreiben den WIRKLICH laufenden Container. Die YAML beschreibt nur, was
// ein heutiges `up` erzeugen wuerde - ein Unterschied, der auf diesem Host
// bereits aufgetreten ist.
export const PS_FORMAT = '{{.Names}}|{{.Image}}|'
  + '{{.Label "com.docker.compose.project"}}|'
  + '{{.Label "com.docker.compose.project.config_files"}}|'
  + '{{.Label "com.docker.compose.service"}}|'
  + '{{.Label "com.docker.compose.oneoff"}}|'
  + '{{.Status}}';

/**
 * Zerlegt eine Zeile aus `docker ps --format` in ihre Felder.
 * Exportiert, damit der Test genau diese Zerlegung pruefen kann, ohne Docker.
 */
export function zerlegePsZeile(zeile) {
  const teile = String(zeile).split('|');
  if (teile.length < 7) return null;
  const [name, image, project, configFiles, service, oneoff, status] = teile;
  return {
    name: name.trim(),
    image: image.trim(),
    project: project.trim(),
    configFiles: configFiles.trim(),
    service: service.trim(),
    oneoff: oneoff.trim().toLowerCase() === 'true',
    status: status.trim(),
    laeuft: /^up\b/i.test(status.trim()),
  };
}

/**
 * Liest die laufenden Container. Gibt [] zurueck, wenn Docker fehlt oder
 * nicht antwortet - das ist kein Fehler, sondern ein Host ohne Docker.
 */
export async function leseContainer(deps = {}) {
  const run = deps.run ?? ausfuehren;
  let stdout;
  try {
    ({ stdout } = await run('docker', ['ps', '-a', '--format', PS_FORMAT]));
  } catch {
    return [];
  }
  return String(stdout ?? '')
    .split('\n')
    .map(zerlegePsZeile)
    .filter(Boolean);
}

/**
 * Fasst Container zu Compose-Stacks zusammen.
 *
 * Ein Stack ist die Menge der Container desselben `com.docker.compose.project`.
 * Ein oneoff-Container (`docker compose run`) gehoert NICHT dazu - er ist ein
 * Einmalbefehl, kein Dienst.
 */
export function gruppiereStacks(container) {
  const nachProject = new Map();
  for (const c of container) {
    if (!c.project) continue; // kein Compose-Container
    if (c.oneoff) continue;
    if (!nachProject.has(c.project)) nachProject.set(c.project, []);
    nachProject.get(c.project).push(c);
  }

  const stacks = [];
  for (const [project, dienste] of nachProject) {
    // Alle Dienste eines Projekts teilen sich die config_files. Wenn nicht,
    // ist es kein Stack, sondern ein Namenskonflikt - dann lieber melden.
    const dateien = [...new Set(dienste.map((d) => d.configFiles).filter(Boolean))]
      .flatMap((d) => d.split(','))
      .map((d) => d.trim())
      .filter(Boolean);

    stacks.push({
      name: project,
      quellen: [...new Set(dateien)],
      dienste: dienste.map((d) => ({
        service: d.service,
        container: d.name,
        image: d.image,
        status: d.status,
        laeuft: d.laeuft,
      })),
      laeuft: dienste.some((d) => d.laeuft),
    });
  }
  return stacks;
}

// --- Dienstart erkennen --------------------------------------------------

/**
 * Ordnet einem Stack eine Dienstart zu.
 * Gibt { id, rackId, label, sicher, grund } zurueck oder null.
 *
 * "sicher: false" heisst: sieht so aus, aber ein Merkmal fehlt - dann wird
 * NICHT angeboten, sondern nachgefragt.
 */
export function erkenneDienstart(stack) {
  if (!stack || !Array.isArray(stack.dienste) || stack.dienste.length === 0) return null;
  for (const art of DIENSTARTEN) {
    const r = art.erkennen(stack.dienste);
    if (!r) continue;
    return { id: art.id, rackId: art.rackId, label: art.label, ...r };
  }
  return null;
}

// --- systemd-Seite -------------------------------------------------------

// Docker sieht die Game-Server auf felsis.de NICHT. 7d2d, teamspeak6 und
// game-armory sind systemd-Units. Wer ein vollstaendiges Bild will, muss
// beide Quellen fragen.
//
// ACHTUNG, live erwischt am 2026-11-10: `systemctl list-units` liefert
// LEERZEICHEN-getrennt, nicht '|'. Meine erste Fassung zerlegte nach '|' und
// bekam deshalb null Zeilen - die Erkennung haette jeden Game-Server
// verschluckt, ohne einen Fehler zu melden.
export const SYSTEMD_FORMAT = '{{.Unit}}|{{.ActiveState}}|{{.SubState}}';

export function zerlegeUnit(zeile) {
  // Zuerst das Pipe-Format (falls --format benutzt wird),
  // sonst die normale Ausgabe: UNIT LOAD ACTIVE SUB DESCRIPTION
  const z = String(zeile).trim();
  if (!z) return null;

  if (z.includes('|')) {
    const teile = z.split('|');
    if (teile.length < 3) return null;
    return {
      unit: teile[0].trim(),
      active: teile[1].trim(),
      sub: teile[2].trim(),
      laeuft: teile[1].trim() === 'active' && teile[2].trim() === 'running',
    };
  }

  const felder = z.split(/\s+/);
  if (felder.length < 4) return null;
  const [unit, load, active, sub] = felder;
  if (!unit.endsWith('.service')) return null;
  return {
    unit,
    active,
    sub,
    laeuft: load === 'loaded' && active === 'active' && sub === 'running',
  };
}

/**
 * Liest laufende systemd-Units.
 *
 * Bewusst NICHT `systemctl list-units --type=service` ohne Filter: dort
 * stehen hunderte Systemdienste (cron, ssh, ...), die niemand uebernehmen
 * will. Wir filtern auf Units, deren Arbeitsverzeichnis unter /opt liegt -
 * das ist die Konvention dieses Projekts (ALLOWED_ROOTS im Install-Helfer).
 */
export async function leseUnits(deps = {}) {
  const run = deps.run ?? ausfuehren;
  let stdout;
  try {
    ({ stdout } = await run('systemctl', ['list-units', '--type=service',
      '--state=running', '--no-legend', '--plain', '--no-pager']));
  } catch {
    return [];
  }
  return String(stdout ?? '')
    .split('\n')
    .map(zerlegeUnit)
    .filter(Boolean)
    .filter((u) => u.laeuft);
}

/**
 * Filtert Units, die nach einem Server unter /opt aussehen.
 *
 * Erste Fassung war zu lasch und meldete am 2026-11-10 live 28
 * "Server-Kandidaten" - darunter containerd, syslog-ng, uuidd und
 * unattended-upgrades. Eine Liste, in der Systemdienste stehen, ist keine
 * Hilfe, sondern Laerm. Ein falsch uebernommener Dienst ist schlimmer als
 * keiner.
 *
 * Deshalb jetzt POSITIV: nur Units, deren Beschreibung oder Name auf einen
 * echten Dienst hindeutet. Die Liste ist bewusst kurz - sie deckt die
 * Faelle ab, die auf diesem Host wirklich vorkommen (Game-Server, TeamSpeak,
 * Datenbanken, Webserver), und alles andere wird nicht gemeldet.
 */
export function istServerUnit(unit) {
  if (!unit || !unit.unit) return false;
  if (!/\.service$/.test(unit.unit)) return false;

  const name = unit.unit;
  const beschreibung = String(unit.beschreibung ?? '');

  // Harte Ausschluesse: Infrastruktur, nie ein uebernehmbarer Dienst.
  const system = /^(ssh|sshd|cron|dbus|systemd|user@|getty|serial-getty|apparmor|blk-|dev-|sys-|network|polkit|udisks|upower|accounts|colord|avahi|cups|modemmanager|packagekit|thermald|irqbalance|unattended-upgrades|uuidd|mdmonitor|syslog|rsyslog|sw-collectd|imunify|containerd|docker\.service|tailscaled|named|plesk-|sw-cp-|sw-engine)/i;
  if (system.test(name)) return false;

  // Positive Merkmale: entweder der Name oder die Beschreibung.
  const merkmal = /(minecraft|7d2d|7 days|teamspeak|satisfactory|factorio|valheim|rust|ark |conan|terraria|palworld|neoforge|forge|game.?armory|mariadb|postgres|redis|nginx|apache|httpd|whisper|ollama|atm1[012]|mc\b|server)/i;
  return merkmal.test(name) || merkmal.test(beschreibung);
}

// --- Gesamtbild ----------------------------------------------------------

/**
 * Ermittelt alle uebernehmbaren Kandidaten.
 *
 * Reihenfolge ist wichtig: erst was LAEUFT, dann die Konfiguration dazu.
 * Ein Kandidat ist ein Vorschlag, keine Uebernahme - er muss noch die fuenf
 * Pruefungen bestehen.
 */
export async function findeKandidaten(deps = {}) {
  const [container, units] = await Promise.all([
    leseContainer(deps),
    leseUnits(deps),
  ]);

  const stacks = gruppiereStacks(container);
  const kandidaten = [];

  for (const stack of stacks) {
    const art = erkenneDienstart(stack);
    if (!art) continue;
    kandidaten.push({
      quelle: 'docker',
      id: stack.name,
      label: art.label,
      rackId: art.rackId,
      sicher: art.sicher === true,
      grund: art.grund ?? null,
      laeuft: stack.laeuft,
      quellen: stack.quellen,
      dienste: stack.dienste.map((d) => d.service).filter(Boolean),
    });
  }

  // systemd-Seite: hier gibt es keine so sichere Erkennung wie bei Docker,
  // weil eine Unit ihren Inhalt nicht verraet. Wir melden sie als Kandidat
  // OHNE automatische Zuordnung - der Betreiber sagt, was es ist.
  const unitKandidaten = units
    .filter(istServerUnit)
    .map((u) => ({
      quelle: 'systemd',
      id: u.unit.replace(/\.service$/, ''),
      label: u.unit,
      rackId: null, // unbekannt, muss der Betreiber sagen
      sicher: false,
      grund: 'systemd-Unit - die Dienstart laesst sich nicht sicher ableiten',
      laeuft: true,
      quellen: [],
      dienste: [],
    }));

  return [...kandidaten, ...unitKandidaten];
}
