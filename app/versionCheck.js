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
    new Promise((_, reject) => setTimeout(() => reject(new Error('Zeitüberschreitung')), ms).unref?.()),
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
        ? 'Steam gibt dieses App nicht für Abfragen frei (version_is_listable=false)'
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

// Releases lesen, nicht Tags (2026-11-26).
//
// Vorgeschichte: Die Pruefung las /tags, weil viele Projekte Tags ohne Release
// anlegen und /releases/latest dann 404 liefert. Fuer TeamSpeak 6 war das aber
// genau falsch herum: der Repo fuehrt seine Tags um (v6.0.0-beta14 ->
// v6.0.0/beta8). Der erste Tag hatte damit ein Format, das nicht als Version
// lesbar ist ("/"), und die Pruefung meldete dauerhaft "unknown" - obwohl das
// echte Release v6.0.0-beta14 da war. Installiert und verfuegbar waren am
// 2026-11-26 sogar dieselbe Version.
//
// Der Updater (updater.js getLatestGithubRelease) holt seit dem Binary-Update
// seine Version aus /releases?per_page=1, und die Route schickt Rack und repo
// mit (installRoutes.js). Die Pruefung nimmt jetzt dieselbe Quelle - sonst
// zeigt das Panel "unbekannt", waehrend der Update-Knopf korrekt "schon
// aktuell" sagt.
//
// /releases/latest wird weiter NICHT benutzt: der TS6-Repo markiert Releases
// nicht als latest, dort kommt 404.
export async function checkGithub({ repo, installed }) {
  if (!repo) return { state: 'unknown', reason: 'kein GitHub-Repo im Rack', installed: installed ?? null };
  try {
    const releases = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=5`, {
      Accept: 'application/vnd.github+json',
    });
    // Neuestes Release mit lesbarem Tag nehmen, nicht stur das erste: ein
    // Release mit unlesbarem Tag wuerde sonst die ganze Pruefung blockieren.
    const release = (Array.isArray(releases) ? releases : [])
      .find((r) => r && typeof r.tag_name === 'string' && isVersionLike(r.tag_name));
    const first = Array.isArray(releases) ? releases[0]?.tag_name ?? null : null;

    if (!release) {
      // Nichts Lesbares gefunden. Zwei ehrliche Gruende unterscheiden, damit
      // der Betreiber weiss, wo er schauen muss.
      if (Array.isArray(releases) && releases.length === 0) {
        return { state: 'unknown', reason: 'keine Releases im Repository (nur Tags)', installed: installed ?? null };
      }
      if (Array.isArray(releases) && releases.length > 0) {
        return {
          state: 'unknown',
          reason: `Tag-Format nicht auswertbar: ${first ?? 'unbekannt'}`,
          installed: installed ?? null,
          available: first,
        };
      }
      return { state: 'unknown', reason: 'GitHub-Antwort ohne Release-Liste', installed: installed ?? null };
    }

    const tag = release.tag_name;
    // Der Tag muss ein Versionsformat haben, sonst ist kein Vergleich moeglich
    // (siehe isVersionLike oben).
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
      source: 'github-release',
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
      return { state: 'unknown', reason: 'GitHub-Rate-Limit erreicht - später erneut prüfen', installed: installed ?? null };
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

// --- Docker (Container-Images) --------------------------------------------
// Quelle: Docker Hub. Gefragt wird nach TAGS, nicht nach einem Manifest -
// dieselbe Ueberlegung wie bei GitHub: `stable-apache` ist ein beweglicher
// Zeiger, `35.0.3-apache` ist ein Stand.
//
// Warum der Umweg ueber die Hub-API und nicht `docker pull`:
//   * die Pruefung laeuft in einem Timer, ein Pull wuerde Images ueber Nacht
//     die Platte fuellen;
//   * `docker manifest inspect` braucht eine Registry-Anmeldung und ist
//     langsam; die Hub-API antwortet ohne Key in unter einer Sekunde.
//
// Gelesen wird der Tag-Stamm (siehe dockerTagFamily): aus `nextcloud:35.0.2-apache`
// wird der Stamm `nextcloud` + Suffix `-apache`, gesucht wird nach
// `35.0.3-apache`. Der bewegliche Tag (`stable-apache`) wird ausgeschlossen,
// weil er keine Version nennt - er taugt zum Installieren, nicht zum Pruefen.
export function parseImageRef(image) {
  if (!image) return null;
  const s = String(image).trim();
  const ohneDigest = s.split('@')[0];
  const ohneRegistry = ohneDigest.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '');
  const letzterSlash = ohneRegistry.lastIndexOf('/');
  const nameTeil = letzterSlash >= 0 ? ohneRegistry.slice(letzterSlash + 1) : ohneRegistry;
  const userTeil = letzterSlash >= 0 ? ohneRegistry.slice(0, letzterSlash) : 'library';
  const [repo, tag = 'latest'] = nameTeil.split(':');
  if (!repo) return null;
  return { user: userTeil, repo, tag };
}

// Zerlegt einen Tag in Versionsstamm und Suffix: "35.0.3-apache" ->
// { base: "35.0.3", suffix: "-apache" }, "34-apache" -> { base: "34", suffix: "-apache" }.
// Null, wenn der Tag nicht mit einer Zahl beginnt (dann ist es ein Alias wie
// "stable" oder "apache").
export function dockerTagFamily(tag) {
  const m = String(tag ?? '').match(/^(\d+(?:\.\d+)*)(.*)$/);
  if (!m) return null;
  return { base: m[1], suffix: m[2] };
}

export async function checkDocker({ image, installed }) {
  const ref = parseImageRef(image);
  if (!ref) return { state: 'unknown', reason: 'kein Image im Sword/Rack genannt', installed: installed ?? null };
  const eigen = dockerTagFamily(ref.tag);
  if (!eigen) {
    return {
      state: 'unknown',
      reason: `Image-Tag ist kein Versionsstand (${ref.tag}) - Prüfung braucht einen Tag wie 35.0.2-apache`,
      installed: installed ?? null,
    };
  }
  try {
    // 100 ist das Maximum pro Seite bei der Hub-API. Mehr braucht es nicht:
    // bei Nextcloud sind selbst mit allen Nebenversionen unter 40 Tags aktuell.
    const j = await fetchJson(
      `https://hub.docker.com/v2/repositories/${ref.user}/${ref.repo}/tags?page_size=100`,
      { Accept: 'application/json' },
    );
    const tags = Array.isArray(j?.results) ? j.results.map((t) => t?.name).filter(Boolean) : [];
    if (tags.length === 0) {
      return { state: 'unknown', reason: 'Docker Hub lieferte keine Tags', installed: installed ?? null };
    }
    // Kandidaten: gleicher Suffix (-apache), Versionsstamm vorhanden, und die
    // Hauptnummer muss passen (35er Image sucht 35er Tags, nicht 34er).
    const eigeneMajor = eigen.base.split('.')[0];
    const kandidaten = tags
      .map((name) => ({ name, fam: dockerTagFamily(name) }))
      .filter((c) => c.fam && c.fam.suffix === eigen.suffix && c.fam.base.split('.')[0] === eigeneMajor);
    if (kandidaten.length === 0) {
      return {
        state: 'unknown',
        reason: `kein Tag mit Muster *${eigen.suffix} und Hauptversion ${eigeneMajor} in Docker Hub gefunden`,
        installed: installed ?? null,
      };
    }
    // Numerisch sortieren, nicht alphabetisch: "35.0.10" > "35.0.9", aber
    // als String waere es kleiner. Genau dieser Vergleich entscheidet, was
    // "das Neueste" ist.
    const cmpBase = (a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    };
    kandidaten.sort((a, b) => cmpBase(b.fam.base, a.fam.base));
    const neuester = kandidaten[0];
    const state = compareVersions(installed, neuester.fam.base) === 'equal' ? 'current' : 'outdated';
    return {
      state,
      installed: installed ?? null,
      available: neuester.name,
      source: 'docker-hub',
    };
  } catch (err) {
    return { state: 'unknown', reason: `Docker Hub nicht erreichbar: ${err.message}`, installed: installed ?? null };
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
//   2) update.source == 'github'     -> GitHub
//   3) update.source == 'docker'     -> Docker Hub
//   4) update.source == 'curseforge' -> CurseForge (oder manual, wenn kein Key)
//   5) sonst                         -> manual
//
// sword: das geladene Sword-Objekt
// rack:  optional, das Rack (fuer appId/source-Details)
// installDir: Pfad der Instanz (fuer appmanifest)
export async function checkSwordVersion(sword, { rack = null, installDir = null } = {}) {
  const src = sword?.update ?? {};
  const installed = sword?.installedVersion ?? null;
  // 2026-11-26: Der Erstinstaller schreibt GitHub-Racks mit source "url" (der
  // TS6-Sword stand live so). Der Dispatcher kannte kein "url" und fiel in den
  // manual-Zweig - Pruefung "unbekannt", waehrend der Updater den Release
  // laengst kannte. "url" PLUS eine Rack-Quelle heisst: das Rack weiss, woher
  // die Version kommt. Dann gilt das Rack, sonst manual.
  let type = src.source ?? rack?.source?.type ?? null;
  if (type === 'url' && rack?.source?.type) type = rack.source.type;

  if (type === 'steam') {
    const appId = src.appId ?? rack?.source?.appId ?? null;
    const root = installDir ? join(installDir, 'steamapps', `appmanifest_${appId}.acf`) : null;
    if (!root) return { state: 'unknown', reason: 'Installationspfad unbekannt', installed };
    return { ...(await checkSteam({ appId, appmanifestPath: root })), checkedAt: Date.now() };
  }

  if (type === 'github') {
    const repo = repoFromUrl(src.url ?? rack?.source?.url);
    return { ...(await checkGithub({ repo, installed })), checkedAt: Date.now() };
  }

  if (type === 'docker') {
    // Image: Sword zuerst (konkreter Stand wie 35.0.2-apache), dann Rack.
    const image = src.image ?? rack?.source?.image ?? null;
    return { ...(await checkDocker({ image, installed })), checkedAt: Date.now() };
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
