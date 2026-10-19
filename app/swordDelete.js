// Game-Armory - Sword entfernen (deinstallieren)
// Entfernt einen installierten Server vollstaendig und sauber:
//   1) Server stoppen (RCON-Save via systemd-ExecStop) und warten, bis inaktiv
//   2) service disablen, Unit loeschen
//   3) RAM-Cache neu laden (loadSwords) -> Sword verschwindet sofort
//   4) Sword-Datei, RCON-Passwort, Log-Ordner entfernen
//   5) Service-User entfernen (nur wenn KEIN anderes Sword ihn nutzt)
//   6) Optional: Ordner loeschen. Sonst bleibt er als "Reste" liegen.
//
// Sicherheit: Loeschen ist destruktiv. Der Server MUSS gestoppt sein, bevor der
// Ordner entfernt wird - sonst kann die Welt beschaedigt werden.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { getSwords, loadSwords } from './swords.js';
import { serviceStatus, serviceAction } from './control.js';
import {
  systemctl, MINECRAFT_ROOT, SWORDS_DIR, DATA_DIR, SYSTEMD_DIR, InstallerError,
} from './installer.js';

const execFileAsync = promisify(execFile);

export class SwordDeleteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SwordDeleteError';
  }
}

function serviceNameFor(id) {
  return `${id}.service`;
}

async function waitInactive(service, { timeoutMs = 90_000, pollMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await serviceStatus(service);
    if (!st.running) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

// Prueft, ob ein User noch von einem anderen Sword verwendet wird. Das ist der
// Fall, wenn eine andere Sword-Datei denselben control.user nennt. Da wir den
// User ueblicherweise = Sword-ID vergeben, ist das nur ein Sicherheitsnetz.
function userUsedByOtherSword(id, user) {
  return getSwords().some((s) => s.id !== id && s.control?.user === user);
}

export async function removeSword(id, { deleteFiles = true, log = () => {} } = {}) {
  const swords = getSwords();
  const sword = swords.find((s) => s.id === id);
  if (!sword) throw new SwordDeleteError(`Sword nicht gefunden: ${id}`);

  const service = sword.control?.service ?? serviceNameFor(id);
  const serviceUser = sword.control?.user ?? id;
  const workingDir = sword.control?.workingDir ?? join(MINECRAFT_ROOT, id);

  // 1) Stoppen, falls aktiv.
  const st = await serviceStatus(service);
  if (st.running) {
    log(`[delete] Server laeuft (${st.state}) - wird gestoppt ...`);
    const stop = await serviceAction(service, 'stop');
    if (!stop.ok) log(`[delete] Stop-Warnung: ${stop.error}`);
    const gone = await waitInactive(service);
    if (!gone) {
      throw new SwordDeleteError(
        `Server ${service} liess sich nicht stoppen (laeuft noch). Abbruch, nichts geloescht.`,
      );
    }
    log('[delete] Server gestoppt.');
  } else {
    log(`[delete] Server ist nicht aktiv (${st.state}).`);
  }

  // 2) Service disablen + Unit entfernen.
  const dis = await systemctl(['disable', service]);
  if (!dis.ok) log(`[delete] disable-Warnung: ${dis.stderr || dis.error}`);
  await rm(join(SYSTEMD_DIR, service), { force: true });
  const reload = await systemctl(['daemon-reload']);
  if (!reload.ok) log(`[delete] daemon-reload-Warnung: ${reload.stderr || reload.error}`);
  log('[delete] systemd-Unit entfernt.');

  // 3) Sword-Datei + RCON + Log.
  await rm(join(SWORDS_DIR, `${id}.sword.json`), { force: true });
  await rm(join(DATA_DIR, `${id}-rcon.password`), { force: true });
  await rm(`/var/log/${id}`, { recursive: true, force: true });
  log('[delete] Sword-Datei, RCON-Passwort, Logs entfernt.');

  // 4) RAM-Cache aktualisieren -> Sword ist sofort weg (auch ohne Neustart).
  await loadSwords();
  log('[delete] Sword-Cache neu geladen.');

  // 5) User entfernen (nur wenn frei). --force, damit Home nicht blockiert.
  let userRemoved = false;
  if (!userUsedByOtherSword(id, serviceUser)) {
    const del = await run('userdel', ['--force', serviceUser]);
    userRemoved = del.ok;
    if (!del.ok && !/does not exist|no such user/i.test(del.stderr + del.error)) {
      log(`[delete] userdel-Warnung: ${del.stderr || del.error}`);
    } else {
      log(`[delete] Service-User ${serviceUser} entfernt.`);
    }
  } else {
    log(`[delete] User ${serviceUser} wird von einem anderen Sword genutzt - bleibt erhalten.`);
  }

  // 6) Ordner.
  let filesRemoved = false;
  if (deleteFiles) {
    await rm(workingDir, { recursive: true, force: true });
    filesRemoved = true;
    log(`[delete] Ordner entfernt: ${workingDir}`);
  } else {
    log(`[delete] Ordner bleibt erhalten: ${workingDir}`);
  }

  return {
    id,
    service,
    workingDir,
    stoppedService: true,
    unitRemoved: true,
    swordFileRemoved: true,
    userRemoved,
    filesRemoved,
    workingDirKept: !deleteFiles,
  };
}

// --- Hilfen ----------------------------------------------------------------

async function run(cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args);
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '', error: err.message };
  }
}

export { InstallerError };
