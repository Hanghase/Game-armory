// Game-Armory - ZIP-Uploads
// Nimmt Serverpack-ZIPs aus dem Browser entgegen (multipart), prueft sie
// (ist es ueberhaupt ein Serverpack? keine unsicheren Pfade?) und legt sie in
// data/uploads/ ab. Direkt-Upload-Weg: die Datei wird EINMALIG fuer einen
// Install-/Update-Vorgang verwendet und danach geloescht.
//
// Zusaetzlich raeumt cleanupOldUploads() Dateien weg, die aelter als die
// konfigurierte Frist sind (Sicherheitsnetz gegen volllaufende Platte).

import multer from 'multer';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { validatePackArchive, PackError } from './pack.js';
import { extractCurseForgeVersion } from './installer.js';

export const UPLOADS_DIR = '/opt/game-armory/data/uploads';
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 Tage

export class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

// --- Multer: Datei direkt auf Platte schreiben, Name harmlos machen ----------

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      await mkdir(UPLOADS_DIR, { recursive: true });
      cb(null, UPLOADS_DIR);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    // Wir vergeben selbst einen harmlosen Namen; der Originalname kommt in die
    // Metadaten daneben, damit kein Pfad aus dem Upload durchschlaegt.
    // 2026-10-18: Endung aus dem Originalnamen uebernehmen (nur bekannte!),
    // sonst landet ein .tar.gz als .zip auf der Platte und tar/unzip raten.
    const ext = ARCHIVE_EXTENSIONS.find((e) => e.re.test(file.originalname ?? ''))?.ext ?? '.bin';
    cb(null, `upload-${randomUUID()}${ext}`);
  },
});

// Erlaubte Archivformen fuer Sword-Archiv-Uploads (2026-10-18):
// Modpacks kommen als .zip, native Server (z.B. TeamSpeak 6) als .tar.gz/.tgz.
// Die endgueltige Entscheidung faellt NICHT hier, sondern am Inhalt
// (detectArchiveKind) - die Endung ist nur ein erster Filter.
const ARCHIVE_EXTENSIONS = [
  { ext: '.tar.gz', re: /\.tar\.gz$/i },
  { ext: '.tar.xz', re: /\.tar\.xz$/i },
  { ext: '.tar.bz2', re: /\.tar\.bz2$/i },
  { ext: '.tgz', re: /\.tgz$/i },
  { ext: '.txz', re: /\.txz$/i },
  { ext: '.zip', re: /\.zip$/i },
];

function archiveFilter(req, file, cb) {
  const name = String(file.originalname ?? '').toLowerCase();
  const knownExt = ARCHIVE_EXTENSIONS.some((e) => e.re.test(name));
  // MIME ist bei .tar.gz oft 'application/octet-stream' oder 'application/gzip'.
  const okMime = [
    'application/zip', 'application/x-zip-compressed', 'multipart/x-zip',
    'application/gzip', 'application/x-gzip', 'application/x-tar', 'application/x-compressed-tar',
    'application/x-xz', 'application/x-bzip2',
    'application/octet-stream',
  ];
  if (!knownExt && !okMime.includes(file.mimetype)) {
    return cb(new UploadError('Nur .zip, .tar.gz, .tar.xz, .tar.bz2, .tgz oder .txz werden akzeptiert.', 415));
  }
  cb(null, true);
}

export const uploadMiddleware = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: archiveFilter,
}).single('file');

// --- Metadaten je Upload ----------------------------------------------------

function metaPath(id) {
  return join(UPLOADS_DIR, `${id}.json`);
}

async function writeMetadata(id, data) {
  await writeFile(metaPath(id), JSON.stringify(data, null, 2), 'utf8');
}

export async function readUpload(id) {
  if (!/^[a-f0-9-]{36}$/i.test(String(id ?? ''))) {
    throw new UploadError('Ungueltige Upload-ID');
  }
  let meta;
  try {
    meta = JSON.parse(await readFile(metaPath(id), 'utf8'));
  } catch {
    throw new UploadError('Upload nicht gefunden', 404);
  }
  // Datei muss noch existieren.
  try {
    await stat(meta.path);
  } catch {
    throw new UploadError('Upload-Datei fehlt auf der Platte', 404);
  }
  return meta;
}

export async function deleteUpload(id) {
  let meta;
  try {
    meta = await readUpload(id);
  } catch {
    return false;
  }
  await rm(meta.path, { force: true });
  await rm(metaPath(id), { force: true });
  return true;
}

// --- Hauptfunktion: eine hochgeladene Datei registrieren --------------------

// file = multer-Dateiobjekt. Prueft das Archiv und legt Metadaten ab.
// 2026-10-18: formatneutral (ZIP oder Tarball). Die Inhaltspruefung richtet
// sich nach dem Rack des Ziels - ein Modpack muss mods/ haben, ein TeamSpeak-
// Release tsserver. Ohne rackId gilt der Minecraft-Standardsatz.
export async function registerUpload(file, user, rack = null) {
  if (!file) throw new UploadError('Keine Datei empfangen');

  // id ohne Endung: upload-<uuid>.zip / .tar.gz / .tgz
  const id = file.filename.replace(/^upload-/, '').replace(/\.(tar\.gz|tar\.xz|tar\.bz2|tgz|txz|zip|bin)$/i, '');
  const archivePath = file.path;
  const originalName = file.originalname ?? 'upload';

  let check;
  try {
    check = await validatePackArchive(archivePath, rack);
  } catch (err) {
    await rm(archivePath, { force: true });
    throw new UploadError(`Archiv ungueltig: ${err.message}`);
  }

  if (!check.ok) {
    await rm(archivePath, { force: true });
    const expected = check.expected?.length
      ? check.expected.join(', ')
      : 'mods, libraries oder startserver.sh';
    const rackNote = rack?.name ? ` nach ${rack.name}` : '';
    throw new UploadError(
      `Das Archiv sieht nicht wie ein Serverpack${rackNote} aus. Erwartet wird mindestens eines von: ${expected}.`,
    );
  }

  const meta = {
    id,
    originalName,
    path: archivePath,
    bytes: file.size,
    uploadedAt: Date.now(),
    uploadedBy: user?.username ?? null,
    kind: check.kind ?? null,
    rackId: rack?.id ?? null,
    zipCheck: check,
    // Version aus dem Original-Dateinamen (z.B. "ServerFiles-8.1.zip" -> "8.1").
    // Dient als Pack-Version beim Install; null, wenn nicht erkennbar.
    packVersion: extractCurseForgeVersion({ fileName: originalName }),
  };
  // Metadaten schreiben. Schlaegt das fehl, MUSS das Archiv mit weg: die
  // Bereinigung findet ihre Kandidaten ausschliesslich ueber die JSON-Dateien
  // (listUploads/cleanupOldUploads), ein Archiv ohne Metadaten liegt also fuer
  // immer auf der Platte und belegt Speicher, ohne im Panel aufzutauchen.
  try {
    await writeMetadata(id, meta);
  } catch (err) {
    await rm(archivePath, { force: true });
    await rm(metaPath(id), { force: true });
    throw new UploadError(`Upload konnte nicht registriert werden: ${err.message}`);
  }
  return meta;
}

// --- Liste + Aufraeumen -----------------------------------------------------

export async function listUploads() {
  let files;
  try {
    files = await readdir(UPLOADS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    try {
      out.push(JSON.parse(await readFile(join(UPLOADS_DIR, f), 'utf8')));
    } catch { /* defekte Metadaten ignorieren */ }
  }
  return out.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

// Entfernt Uploads, die aelter als ttlMs sind. Rueckgabe: Anzahl geloescht.
export async function cleanupOldUploads(ttlMs = UPLOAD_TTL_MS) {
  const uploads = await listUploads();
  const cutoff = Date.now() - ttlMs;
  let removed = 0;
  for (const u of uploads) {
    if (u.uploadedAt < cutoff) {
      await rm(u.path, { force: true });
      await rm(metaPath(u.id), { force: true });
      removed += 1;
    }
  }
  return removed;
}

export { createReadStream, PackError };
