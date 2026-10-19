// Game-Armory - Versionsvergleich ("ist der Server aktuell?")
//
// Warum: installedVersion sagt, was laeuft. Es fehlte die Gegenprobe - gibt es
// eine neuere Version? Ohne sie kann das Panel keine gruene Nummer zeigen.
//
// Quellen pro Rack-Typ (alle OHNE API-Key, ausser CurseForge):
//   steam        -> lokaler appmanifest-buildid + Steam UpToDateCheck (kein Key)
//   url (github) -> /repos/:owner/:repo/tags (kein Key)
//                   Tags, nicht Releases: ein Tag ist der ausgelieferte Stand,
//                   ein Release nur die Verpackung. Projekte ohne Release
//                   lieferten ueber /releases/latest ein 404.
//   curseforge   -> braucht x-api-key; ohne Key wird ehrlich "unbekannt" gemeldet
//   manual       -> Soll-Version, vom Menschen im Panel eingetragen
//
// Grundsatz: NIE raten. Ist die Quelle nicht konfiguriert oder nicht
// erreichbar, kommt state="unknown" mit einem lesbaren Grund zurueck.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSetting } from './settings.js';

export const CHECK_TIMEOUT_MS = 20_000;

// --- Hilfen ---------------------------------------------------------------

function withTimeout(promise, ms = CHECK_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Zeitueberschreitung')), ms).unref?.()),
  ]);
}

async function fetchJson(url, headers = {}, ms = CHECK_TIMEOUT_MS) {
  const res = await withTimeout(fetch(url, {
    headers: { 'User-Agent': 'game-armory/0.1', Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(ms),
  }), ms + 2_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Vergleich zweier Versionsangaben. Rueckgabe:
//   "equal" | "differ" | "unknown"
// Bewusst KEIN semver-Parsing: Pack-Versionen sind oft "8.3", "0.12.0-beta",
// Steam-Builds sind Zahlen. Wir vergleichen normalisiert (trim, lowercase,
// fuehrendes "v" strippen - GitHub-Tags heissen "v6.0.0-beta13.1", installiert
// ist oft "6.0.0-beta13.1").
function normalizeVersion(v) {
  return String(v).trim().toLowerCase().replace(/^v(?=\d)/, '');
}

// Sieht der Tag wie eine Version aus? Erlaubt:
//   1.2.3   v1.2.3   1.2   8.3   12345678 (Steam-Builds)
//   1.2.3-beta.1   v2.0.0-rc.1   0.12.0-beta
// Nicht erlaubt (und damit "unknown" statt einer falschen Aussage):
//   v6.0.0/beta8   (Schraegstrich - Pfad, kein Versionstrenner)
//   release-2.3.1  (Praefix vor der Zahl)
//   atm10-1.2.3    (Projektname im Tag)
export function isVersionLike(v) {
  if (!v) return false;
  const basis = String(v).trim().replace(/^[vV](?=\d)/, '');
  return /^\d+(\.\d+)*(-[A-Za-z0-9._]+)?$/.test(basis);
}

export function compareVersions(installed, available) {
  if (!installed || !available) return 'unknown';
  const a = normalizeVersion(installed);
  const b = normalizeVersion(available);
  if (a === b) return 'equal';

  // Rein numerische Builds (Steam) numerisch vergleichen, nicht als String.
  const na = a.match(/^\d+$/);
  const nb = b.match(/^\d+$/);
  if (na && nb) return Number(a) === Number(b) ? 'equal' : 'differ';

  return 'differ';
}

// --- Steam ----------------------------------------------------------------
// Lokal: appmanifest_<appid>.acf -> "buildid"
// Remote: ISteamApps/UpToDateCheck (kein Key fuer die einfache Abfrage)
export async function readSteamBuildId(appmanifestPath) {
  try {
    const raw = await readFile(appmanifestPath, 'utf8');
    const m = raw.match(/"buildid"\s+"(\d+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function checkSteam({ appId, appmanifestPath }) {
  const localBuild = await readSteamBuildId(appmanifestPath);
  if (!appId) {
    return { state: 'unknown', reason: 'keine appId im Rack', installed: localBuild ?? null };
  }
  if (!localBuild) {
    return { state: 'unknown', reason: `appmanifest nicht lesbar (${appmanifestPath})`, installed: null };
  }

  // Befund 2026-10-18 (live gemessen): ISteamApps/UpToDateCheck liefert fuer
  // App 294420 IMMER up_to_date=false und version_is_listable=false - egal
  // welche version man schickt. Ohne required_version gibt es keinen Ziel-Build,
  // also ist daraus KEIN "outdated" ableitbar. Wir melden ehrlich "unknown",
  // statt eine Behauptung zu erfinden. Die lokale Build-ID zeigen wir trotzdem.
  try {
    const url = `https://api.steampowered.com/ISteamApps/UpToDateCheck/v1/?appid=${encodeURIComponent(appId)}&version=${encodeURIComponent(localBuild)}`;
    const j = await fetchJson(url);
    const r = j?.response ?? {};
    if (r.required_version) {
      const cmp = compareVersions(localBuild, String(r.required_version));
      return {
        state: cmp === 'equal' ? 'current' : 'outdated',
        installed: `steam build ${localBuild}`,
        available: `steam build ${r.required_version}`,
        source: 'steam-uptodate',
      };
    }
    return {
      state: 'unknown',
      reason: r.version_is_listable === false
        ? 'Steam gibt dieses App nicht fuer Abfragen frei (version_is_listable=false)'
        : 'Steam liefert keinen Ziel-Build',
      installed: `steam build ${localBuild}`,
      source: 'steam-uptodate',
    };
  } catch (err) {
    return { state: 'unknown', reason: `Steam nicht erreichbar: ${err.message}`, installed: `steam build ${localBuild}` };
  }
}

// --- GitHub-Releases ------------------------------------------------------
// repo: "owner/name" (aus rack.source.url ableitbar)
// repo: "owner/name". Akzeptiert BEIDE Formen, die in der Praxis vorkommen:
//   "https://github.com/teamspeak/teamspeak6-server"  (Rack-URL)
//   "teamspeak/teamspeak6-server"                    (Sword-projectId)
// Vorher wurde nur die URL-Form erkannt - dadurch meldete ts6 faelschlich
// "kein GitHub-Repo im Rack".
export function repoFromUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  const m = s.match(/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (m) return `${m[1]}/${m[2].replace(/\.git$/, '')}`;
  // Kurzform "owner/repo" (genau ein Schraegstrich, keine Leerzeichen/Protokoll)
  const short = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (short) return `${short[1]}/${short[2].replace(/\.git$/, '')}`;
  return null;
}

// Tags lesen, nicht Releases.
//
// Warum: Viele Projekte setzen Tags, aber legen kein Release dazu an. Ein Tag
// ist der Stand, den man ausliefert - das Release ist nur die Verpackung drum
// herum. /releases/latest liefert in dem Fall 404, und die Pruefung meldete
// "unbekannt", obwohl die Version da war.
//
// /tags listet beide Faelle: Tag mit Release und Tag ohne. Wir nehmen den
// ersten Eintrag; GitHub sortiert nach Committer-Datum, der erste ist also der
// neueste Tag. Sortiert wird nachher noch einmal gegen `installed`.
export async function checkGithub({ repo, installed }) {
  if (!repo) return { state: 'unknown', reason: 'kein GitHub-Repo im Rack', installed: installed ?? null };
  try {
    const tags = await fetchJson(`https://api.github.com/repos/${repo}/tags`, {
      Accept: 'application/vnd.github+json',
    });
    // Ein Tag ist kein Vertrag. Projekte benennen Tags um (TeamSpeak 6:
    // v6.0.0-beta13.1 -> v6.0.0/beta8). Danach passt das Format nicht mehr zur
    // installierten Version, und ein String-Vergleich wuerde "outdated"
    // melden, obwohl nichts veraltet ist. Lieber "unknown" mit Grund.
    if (!Array.isArray(tags) || tags.length === 0) {
      return { state: 'unknown', reason: 'keine Tags im Repository', installed: installed ?? null };
    }
    const tag = tags[0]?.name ?? null;
    if (!tag) return { state: 'unknown', reason: 'Tag ohne Namen', installed: installed ?? null };

    // Der Tag muss ein Versionsformat haben, sonst ist kein Vergleich moeglich.
    // Beispiel TeamSpeak 6: v6.0.0-beta13.1 wurde umbenannt zu v6.0.0/beta8.
    // Ein String-Vergleich wuerde hier "outdated" melden, obwohl installiert
    // und verfuegbar dieselbe Version sind. "weiss nicht" ist die Wahrheit.
    if (!isVersionLike(tag)) {
      return {
        state: 'unknown',
        reason: `Tag-Format nicht auswertbar: ${tag}`,
        installed: installed ?? null,
        available: tag,
      };
    }
    const cmp = compareVersions(installed, tag);
    return {
      state: cmp === 'equal' ? 'current' : 'outdated',
      installed: installed ?? null,
      available: tag,
      source: 'github-tag',
    };
  } catch (err) {
    // 404 heisst hier: privates Repository oder falscher Name. Das ist ein
    // anderer Zustand als "GitHub nicht erreichbar", und der Betreiber soll
    // den Unterschied sehen.
    const msg = String(err.message ?? '');
    if (msg.includes('HTTP 404')) {
      return { state: 'unknown', reason: 'Repository nicht oeffentlich lesbar (privat oder falscher Name)', installed: installed ?? null };
    }
    if (msg.includes('HTTP 403')) {
      return { state: 'unknown', reason: 'GitHub-Rate-Limit erreicht - spaeter erneut pruefen', installed: installed ?? null };
    }
    return { state: 'unknown', reason: `GitHub nicht erreichbar: ${msg}`, installed: installed ?? null };
  }
}

// --- CurseForge -----------------------------------------------------------
// Braucht den API-Key. Fehlt er, ist das KEIN Fehler, sondern ein Zustand.
export async function checkCurseForge({ projectId, installed }) {
  if (!projectId) {
    return { state: 'unknown', reason: 'keine projectId im Rack', installed: installed ?? null };
  }
  if (!getSetting('curseforge_api_key')) {
    return {
      state: 'unknown',
      reason: 'CurseForge-API-Key fehlt (Antrag offen) - Soll-Version manuell pflegen',
      installed: installed ?? null,
    };
  }
  try {
    const j = await fetchJson(`https://api.curseforge.com/v1/mods/${encodeURIComponent(projectId)}/files?pageSize=1`, {
      'x-api-key': getSetting('curseforge_api_key'),
    });
    const latest = j?.data?.[0];
    if (!latest) return { state: 'unknown', reason: 'keine Dateien im Projekt', installed: installed ?? null };
    const fileVersion = latest.displayName ?? latest.fileName ?? null;
    // Wie bei GitHub: ein Dateiname ist keine Version. "AllTheMods10-8.3.zip"
    // oder "atm10-server-1.2.3.jar" wuerde beim String-Vergleich "outdated"
    // melden, obwohl die Version passt. Dann lieber "weiss nicht".
    if (!isVersionLike(fileVersion)) {
      return {
        state: 'unknown',
        reason: `Dateiname nicht als Version lesbar: ${fileVersion}`,
        installed: installed ?? null,
        available: fileVersion,
      };
    }
    return {
      state: compareVersions(installed, fileVersion) === 'equal' ? 'current' : 'outdated',
      installed: installed ?? null,
      available: fileVersion,
      source: 'curseforge',
    };
  } catch (err) {
    return { state: 'unknown', reason: `CurseForge: ${err.message}`, installed: installed ?? null };
  }
}

// --- Manuell --------------------------------------------------------------
// Der Mensch traegt die Soll-Version ein; wir vergleichen nur.
export function checkManual({ expected, installed }) {
  if (!expected) {
    return { state: 'unknown', reason: 'keine Soll-Version eingetragen', installed: installed ?? null };
  }
  // Der einzige Fall, den der Mensch selbst eingetippt hat - hier ist das
  // Format absichtlich freier. Trotzdem: steht dort etwas, das keine Version
  // ist, waere "outdated" eine Aussage ueber nichts. Dann "unknown".
  if (!isVersionLike(expected)) {
    return {
      state: 'unknown',
      reason: `Soll-Version nicht als Version lesbar: ${expected}`,
      installed: installed ?? null,
      available: expected,
    };
  }
  return {
    state: compareVersions(installed, expected) === 'equal' ? 'current' : 'outdated',
    installed: installed ?? null,
    available: expected,
    source: 'manual',
  };
}

// --- Dispatcher -----------------------------------------------------------
// Entscheidet anhand des Sword/Rack, welche Quelle gilt. Reihenfolge:
//   1) update.source == 'steam'      -> Steam
//   2) update.source == 'url'        -> GitHub
//   3) update.source == 'curseforge' -> CurseForge (oder manual, wenn kein Key)
//   4) sonst                         -> manual
//
// sword: das geladene Sword-Objekt
// rack:  optional, das Rack (fuer appId/source-Details)
// installDir: Pfad der Instanz (fuer appmanifest)
export async function checkSwordVersion(sword, { rack = null, installDir = null } = {}) {
  const src = sword?.update ?? {};
  const installed = sword?.installedVersion ?? null;
  const type = src.source ?? rack?.source?.type ?? null;

  if (type === 'steam') {
    const appId = src.appId ?? rack?.source?.appId ?? null;
    const root = installDir ? join(installDir, 'steamapps', `appmanifest_${appId}.acf`) : null;
    if (!root) return { state: 'unknown', reason: 'Installationspfad unbekannt', installed };
    return { ...(await checkSteam({ appId, appmanifestPath: root })), checkedAt: Date.now() };
  }

  if (type === 'url') {
    const repo = repoFromUrl(src.url ?? rack?.source?.url);
    return { ...(await checkGithub({ repo, installed })), checkedAt: Date.now() };
  }

  if (type === 'curseforge') {
    const projectId = src.projectId ?? rack?.source?.projectId ?? null;
    const hasKey = Boolean(getSetting('curseforge_api_key'));
    if (!hasKey) {
      // Ohne Key: auf die manuell gepflegte Soll-Version zurueckfallen.
      const manual = src.availableVersion ?? null;
      if (manual) return { ...checkManual({ expected: manual, installed }), checkedAt: Date.now() };
    }
    return { ...(await checkCurseForge({ projectId, installed })), checkedAt: Date.now() };
  }

  const manual = src.availableVersion ?? null;
  return { ...checkManual({ expected: manual, installed }), checkedAt: Date.now() };
}
