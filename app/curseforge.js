// Game-Armory - CurseForge API Client
// Holt Modpack-Informationen und Datei-Downloads von der CurseForge-API.
// Der API-Key wird aus den Armory-Settings gelesen (nie aus der Umgebung).
//
// API-Doku: https://docs.curseforge.com/ (v1)

import { getSetting } from './settings.js';

const API_BASE = 'https://api.curseforge.com/v1';
const GAME_ID_MINECRAFT = 432;
const CLASS_ID_MODPACK = 4471;

export class CurseForgeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'CurseForgeError';
    this.status = status;
  }
}

function apiKey() {
  const key = getSetting('curseforge_api_key');
  if (!key) {
    throw new CurseForgeError(
      'Kein CurseForge-API-Key hinterlegt. Bitte in den Einstellungen setzen.',
      null,
    );
  }
  return key;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'x-api-key': apiKey(),
      'Accept': 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.message ?? '';
    } catch { /* Antwort war kein JSON */ }
    throw new CurseForgeError(
      `CurseForge-API-Fehler ${res.status}${detail ? `: ${detail}` : ''}`,
      res.status,
    );
  }
  return res.json();
}

// Modpack per Suchbegriff finden (Name/Slug), Standard: nur Minecraft-Modpacks.
export async function searchModpacks(query, { pageSize = 10 } = {}) {
  const params = new URLSearchParams({
    gameId: String(GAME_ID_MINECRAFT),
    classId: String(CLASS_ID_MODPACK),
    searchFilter: query,
    pageSize: String(pageSize),
  });
  const data = await api(`/mods/search?${params}`);
  return (data.data ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    slug: m.slug,
    summary: m.summary,
    downloadCount: m.downloadCount,
    logo: m.logo?.thumbnailUrl ?? null,
  }));
}

// Einzelnes Modpack anhand der Projekt-ID laden.
export async function getMod(modId) {
  const data = await api(`/mods/${modId}`);
  const m = data.data;
  return { id: m.id, name: m.name, slug: m.slug, summary: m.summary };
}

// Alle Dateien (Versionen) eines Modpacks auflisten.
export async function getFiles(modId, { pageSize = 30, index = 0 } = {}) {
  const params = new URLSearchParams({
    pageSize: String(pageSize),
    index: String(index),
  });
  const data = await api(`/mods/${modId}/files?${params}`);
  return (data.data ?? []).map((f) => ({
    id: f.id,
    displayName: f.displayName,
    fileName: f.fileName,
    releaseType: f.releaseType, // 1=release, 2=beta, 3=alpha
    fileDate: f.fileDate,
    fileLength: f.fileLength,
    downloadUrl: f.downloadUrl ?? null,
    gameVersions: f.gameVersions ?? [],
  }));
}

// Die neueste Server-Datei ("server pack") eines Modpacks finden.
// CurseForge liefert für Modpacks zusaetzliche Server-Packs ueber
// /mods/{id}/files?gameVersion=... - wir filtern auf Dateien, deren Name
// auf einen Serverpack hindeutet, und nehmen sonst die neueste Release-Datei.
export async function findLatestServerFile(modId, { includeBeta = false } = {}) {
  const files = await getFiles(modId, { pageSize: 50 });
  const usable = files.filter((f) => includeBeta || f.releaseType === 1);
  if (usable.length === 0) {
    throw new CurseForgeError('Keine passende Release-Datei gefunden (evtl. nur Beta/Alpha).', null);
  }
  // Neueste zuerst (fileDate ist ein ISO-String).
  usable.sort((a, b) => String(b.fileDate).localeCompare(String(a.fileDate)));
  return usable[0];
}

// Download-URL fuer eine Datei aufloesen (falls die Dateiliste keine liefert).
export async function getDownloadUrl(modId, fileId) {
  const data = await api(`/mods/${modId}/files/${fileId}/download-url`);
  return data.data;
}

// Server-Datei herunterladen und nach `destPath` schreiben.
// Es wird KEIN Key an den Download-Host gesendet - CurseForge-Downloads
// laufen ueber CDN-URLs ohne Auth.
export async function downloadFile(url, destPath) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'game-armory/0.1' },
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!res.ok) {
    throw new CurseForgeError(`Download fehlgeschlagen: HTTP ${res.status}`, res.status);
  }
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const { Readable } = await import('node:stream');
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
  return destPath;
}

export function isConfigured() {
  return Boolean(getSetting('curseforge_api_key'));
}

// Prueft einen beliebigen Key LIVE gegen die Core-API, ohne ihn zu speichern.
// Nutzt den leichtesten Endpunkt (GET /v1/games), der nur gueltige Auth braucht.
// Rueckgabe: { ok: true } oder { ok: false, error, status }.
export async function verifyApiKey(candidate) {
  const key = String(candidate ?? '').trim();
  if (!key) return { ok: false, error: 'Kein Key uebergeben', status: null };

  let res;
  try {
    res = await fetch(`${API_BASE}/games?index=0&pageSize=1`, {
      headers: { 'x-api-key': key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, error: `Netzwerk-/Timeout-Fehler: ${err.message}`, status: null };
  }

  if (res.ok) return { ok: true, status: res.status };

  // Wichtig: CurseForge unterscheidet zwei Key-Typen.
  //  - Application API Key  -> fuer api.curseforge.com/v1 (WAS DIE ARMORY BRAUCHT)
  //  - Studio API Key       -> fuer die Studios-Plattform (funktioniert hier NICHT)
  // Studio-Keys haben typisch die Form $2a$<cost>$<salt><hash> (60 Zeichen).
  // Ein 403 kann zudem vom CloudFront-Edge kommen, bevor Auth stattfindet.
  const isStudioLike = /^\$2[aby]\$\d{2}\$/.test(key);

  if (res.status === 403) {
    return {
      ok: false,
      status: 403,
      studioLike: isStudioLike,
      error: isStudioLike
        ? 'Das sieht nach einem CurseForge-Studio-Key aus. Die Armory braucht einen APPLICATION-API-Key '
          + '(Beantragung noetig, Bearbeitung dauert ca. 14 Tage).'
        : 'CurseForge hat den Request abgelehnt (403). Falls es ein gueltiger Application-Key ist, '
          + 'kann die Blockade vom CurseForge-CDN kommen (nicht vom Key).',
      hint: 'Application-Key beantragen: https://support.curseforge.com/support/solutions/articles/9000208346-about-the-curseforge-api-and-how-to-apply-for-a-key '
          + '(Bearbeitung dauert ca. 14 Tage). Nicht zu verwechseln mit dem Studio-Key. '
          + 'Bis dahin funktioniert der ZIP-Upload-Weg ohne Key.',
    };
  }
  if (res.status === 401) {
    return { ok: false, status: 401, error: 'Nicht autorisiert (401). Key pruefen.' };
  }
  return { ok: false, status: res.status, error: `Unerwartete API-Antwort: HTTP ${res.status}` };
}
