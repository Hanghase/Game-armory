// Game-Armory - Mailversand (SMTP)
// Jeder Betreiber hinterlegt seine EIGENEN SMTP-Daten (Ionos, Brevo, eigener
// Server - alles was SMTP spricht). nodemailer ist anbieterunabhaengig: ein
// spaeterer Anbieterwechsel aendert nur die Settings, nicht diesen Code.
//
// Sicherheit: smtp_pass wird ausschliesslich hier serverseitig gelesen und
// niemals an das Frontend ausgeliefert (siehe settings.js maskSecret).

import nodemailer from 'nodemailer';
import { getSetting } from './settings.js';

export class MailError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MailError';
    this.code = code ?? null;
  }
}

// Liest die SMTP-Konfiguration typisiert aus den Settings.
// Rueckgabe: { enabled, host, port, secure, user, pass, fromName, fromAddress }
export function getMailConfig() {
  const host = getSetting('smtp_host');
  const portRaw = getSetting('smtp_port');
  const user = getSetting('smtp_user');
  const pass = getSetting('smtp_pass');
  return {
    enabled: getSetting('smtp_enabled') === 'true',
    host: host || null,
    port: portRaw ? Number.parseInt(portRaw, 10) : (getSetting('smtp_secure') === 'true' ? 465 : 587),
    secure: getSetting('smtp_secure') === 'true',
    user: user || null,
    pass: pass || null,
    fromName: getSetting('smtp_from_name') || 'Game-Armory',
    fromAddress: getSetting('smtp_from_address') || null,
  };
}

// Ist der Versand einsatzbereit? (Master-Schalter an UND Pflichtfelder gesetzt)
export function isMailReady() {
  const c = getMailConfig();
  if (!c.enabled) return false;
  if (!c.host || !c.port || !c.fromAddress) return false;
  // Server ohne Auth (seltener Fall, z.B. interner Relay) erlaubt: user/pass leer.
  if ((c.user && !c.pass) || (!c.user && c.pass)) return false;
  return true;
}

// Baut einen Transport. Wirft MailError, wenn die Konfiguration unvollstaendig ist.
function buildTransport(cfg) {
  if (!cfg.host) throw new MailError('SMTP-Server ist nicht gesetzt.', 'ENOCONFIG');
  if (!Number.isFinite(cfg.port)) throw new MailError('SMTP-Port ist ungueltig.', 'ENOCONFIG');
  if (!cfg.fromAddress) throw new MailError('Absenderadresse ist nicht gesetzt.', 'ENOCONFIG');
  const auth = cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined;
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,          // true=465 implizites TLS, false=STARTTLS (587)
    auth,
    connectionTimeout: 10_000,   // UI soll bei falschem Host nicht haengen
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

// Prueft den SMTP-Handshake + Login, OHNE eine Mail zu senden.
export async function verifyMail() {
  const cfg = getMailConfig();
  const transport = buildTransport(cfg);
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    throw new MailError(friendlyError(err), err.code ?? null);
  } finally {
    transport.close();
  }
}

// Sanitisiert nodemailer-Fehler: das Passwort darf NIE in einer Meldung landen.
function friendlyError(err) {
  const raw = String(err?.message ?? err ?? 'Unbekannter Fehler');
  const clean = raw.replace(/pass(word)?[=:]\s*\S+/gi, 'pass=***');
  const code = err?.code ? ` (${err.code})` : '';
  return `SMTP-Fehler${code}: ${clean}`;
}

// Sendet eine Mail. Rueckgabe: { messageId, to }
export async function sendMail({ to, subject, text, html }) {
  const cfg = getMailConfig();
  const transport = buildTransport(cfg);
  if (!to) throw new MailError('Kein Empfaenger angegeben.', 'ENOTRECIPIENT');
  try {
    const info = await transport.sendMail({
      from: cfg.fromName ? `"${cfg.fromName}" <${cfg.fromAddress}>` : cfg.fromAddress,
      to,
      subject,
      text,
      html,
    });
    return { messageId: info.messageId, to };
  } catch (err) {
    throw new MailError(friendlyError(err), err.code ?? null);
  } finally {
    transport.close();
  }
}

// --- Konkrete Mailtypen ------------------------------------------------------

export async function sendTestMail(to) {
  const cfg = getMailConfig();
  const subject = 'Game-Armory: Testmail';
  const text = [
    'Diese Testmail bestaetigt, dass der SMTP-Versand deiner Game-Armory funktioniert.',
    '',
    `Server:   ${cfg.host}:${cfg.port} (${cfg.secure ? 'TLS' : 'STARTTLS'})`,
    `Absender: ${cfg.fromAddress}`,
    '',
    'Wenn du diese Mail siehst, sind Zugangsdaten und Absenderdomain korrekt.',
  ].join('\n');
  const html = `<p>Diese Testmail bestaetigt, dass der SMTP-Versand deiner <strong>Game-Armory</strong> funktioniert.</p>
<ul>
  <li>Server: <code>${cfg.host}:${cfg.port}</code> (${cfg.secure ? 'TLS' : 'STARTTLS'})</li>
  <li>Absender: <code>${cfg.fromAddress}</code></li>
</ul>
<p>Wenn du diese Mail siehst, sind Zugangsdaten und Absenderdomain korrekt.</p>`;
  return sendMail({ to, subject, text, html });
}

export async function sendPasswordResetMail(to, link, username, expiresMinutes) {
  const subject = 'Game-Armory: Passwort zuruecksetzen';
  const text = [
    `Hallo ${username},`,
    '',
    'fuer deinen Game-Armory-Zugang wurde ein Passwort-Reset angefordert.',
    `Oeffne dazu diesen Link (gueltig ${expiresMinutes} Minuten, einmalig):`,
    '',
    link,
    '',
    'Wenn du das nicht angefordert hast, kannst du diese Mail ignorieren.',
  ].join('\n');
  const html = `<p>Hallo ${escapeHtml(username)},</p>
<p>fuer deinen <strong>Game-Armory</strong>-Zugang wurde ein Passwort-Reset angefordert.</p>
<p><a href="${escapeHtml(link)}">Passwort zuruecksetzen</a></p>
<p>Der Link ist <strong>${expiresMinutes} Minuten</strong> gueltig und kann nur einmal verwendet werden.</p>
<p>Wenn du das nicht angefordert hast, kannst du diese Mail ignorieren.</p>`;
  return sendMail({ to, subject, text, html });
}

export async function sendInviteMail(to, link, username, roleLabel) {
  const subject = 'Game-Armory: Einladung';
  const text = [
    `Hallo ${username},`,
    '',
    `du wurdest zur Game-Armory eingeladen (Rolle: ${roleLabel}).`,
    `Setze dein Passwort ueber diesen Link (gueltig 60 Minuten, einmalig):`,
    '',
    link,
  ].join('\n');
  const html = `<p>Hallo ${escapeHtml(username)},</p>
<p>du wurdest zur <strong>Game-Armory</strong> eingeladen (Rolle: ${escapeHtml(roleLabel)}).</p>
<p><a href="${escapeHtml(link)}">Passwort setzen und anmelden</a></p>
<p>Der Link ist <strong>60 Minuten</strong> gueltig und kann nur einmal verwendet werden.</p>`;
  return sendMail({ to, subject, text, html });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
