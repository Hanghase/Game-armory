// Game-Armory - Panel-Frontend
// Ausgelagert aus app.html (2026-10-23), damit die CSP script-src 'self'
// ohne 'unsafe-inline' auskommt. Inhalt 1:1 uebernommen.

    const RANGEN = { strangerdanger: 'Stranger Danger', friend: 'Freund', moderator: 'Moderator', admin: 'Admin', superuser: 'Superuser' };
    const RANG_LEVEL = { strangerdanger: 0, friend: 1, moderator: 2, admin: 3, superuser: 4 };
    const MAX_BUFFER = 20000;      // Zeichen-Puffer im Konsolenfenster (ältestes fliegt raus)
    const MAX_LINES = 800;         // harte Obergrenze Zeilen
    let me = null, ws = null;
    let logLines = [];
    let lastLogAt = null;
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    async function api(path, opts = {}) {
      const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
      let data = {};
      try { data = await r.json(); } catch {}
      return { status: r.status, data };
    }

    // Versions-Gegenprobe (2026-10-18): Die Karte zeigt gruen nur mit Beleg.
    // versionState kommt vom Server (current | outdated | unknown).
    function versionHint(sword) {
      if (sword.versionState === 'outdated' && sword.availableVersion) {
        return ` <span class="v-hint">→ v${esc(sword.availableVersion)}</span>`;
      }
      return '';
    }
    function versionTooltip(sword) {
      const parts = [`Installiert: ${sword.installedVersion ?? 'unbekannt'}`];
      if (sword.installedVersionSource) parts.push(`Quelle: ${sword.installedVersionSource}`);
      if (sword.availableVersion) parts.push(`Verfuegbar: ${sword.availableVersion}`);
      if (sword.versionState === 'current') parts.push('Status: aktuell');
      else if (sword.versionState === 'outdated') parts.push('Status: Update verfuegbar');
      else if (sword.versionState === 'unknown') parts.push('Status: unbekannt');
      if (sword.versionCheckReason) parts.push(sword.versionCheckReason);
      if (sword.versionCheckedAt) {
        parts.push(`Geprueft: ${new Date(sword.versionCheckedAt).toLocaleString('de-DE')}`);
      }
      return parts.join(' · ');
    }
    // --- Passwort-Richtlinie live anzeigen (2026-10-22) -------------------
    // Spiegel der Server-Regeln aus app/auth.js (validatePassword). Wird beim
    // Tippen ausgewertet, damit man sieht WAS noch fehlt statt es erst beim
    // Absenden zu erfahren. Der Server prueft weiterhin selbst - das hier ist
    // reine Anzeige, keine Sicherheitsgrenze.
    const PW_COMMON = new Set([
      '12345678', '123456789', '1234567890', '12345678910',
      'password', 'password1', 'password12', 'password123', 'passwort',
      'passwort1', 'passwort12', 'passwort123', 'qwertzuiop', 'qwertyuiop',
      'qwertz1234', 'qwerty1234', 'abcdefghij', 'abcd123456',
      'iloveyou1', 'welcome123', 'admin12345', 'administrator',
      'letmein123', 'football12', 'baseball12', 'sonnenschein',
      'schalke04', 'dortmund09', 'hallo12345', 'test123456',
    ]);

    function pwRuleState(pw, username) {
      const v = String(pw ?? '');
      const groups = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/]
        .filter((re) => re.test(v)).length;
      const name = String(username ?? '').trim().toLowerCase();
      return {
        len:    v.length >= 10,
        groups: groups >= 3,
        common: v.toLowerCase() !== '' && !PW_COMMON.has(v.toLowerCase()),
        name:   !(name.length >= 3 && v.toLowerCase().includes(name)),
      };
    }

    // Faerbt die <li data-rule="..."> in der Regel-Box und liefert zurueck,
    // ob alle Kriterien erfuellt sind.
    function renderPwRules(boxId, pw, username) {
      const box = document.getElementById(boxId);
      if (!box) return true;
      const st = pwRuleState(pw, username);
      box.querySelectorAll('li[data-rule]').forEach((li) => {
        const ok = st[li.dataset.rule];
        li.classList.toggle('ok', Boolean(ok));
        li.classList.toggle('bad', !ok);
      });
      return Object.values(st).every(Boolean);
    }

    // Haengt das Live-Feedback an ein Passwortfeld. userFn liefert den
    // Benutzernamen fuer die "nicht der Benutzername"-Regel (oder '').
    function bindPwRules(inputId, boxId, userFn) {
      const inp = document.getElementById(inputId);
      const box = document.getElementById(boxId);
      if (!inp || !box) return;

      // Die Regeln stehen eingeklappt da und klappen beim ersten Zeichen auf.
      // Bleiben offen, solange etwas im Feld steht - auch nach dem Verlassen
      // des Feldes, damit man nachlesen kann, woran es haengt.
      const sync = () => box.classList.toggle('open', inp.value.length > 0);

      const update = () => {
        sync();
        renderPwRules(boxId, inp.value, userFn());
      };
      inp.addEventListener('input', update);
      inp.addEventListener('focus', sync);
      inp.addEventListener('blur', update);
      update();
    }

    function toast(t) {
      const el = document.getElementById('toast');
      el.textContent = t; el.style.display = 'block';
      setTimeout(() => el.style.display = 'none', 2600);
    }
    function can(need) {
      // Prueft die aufgeloesten Rechte (perms) statt der alten Rang-Leiter.
      // me.perms kommt aus /api/auth/me (Rechte-Matrix). Fallback auf die
      // Rang-Leiter nur, falls perms (noch) nicht geladen ist.
      if (!me) return false;
      if (Array.isArray(me.perms)) return me.perms.includes(need);
      return RANG_LEVEL[me.role] >= RANG_LEVEL[need];
    }
    function clampLabel(s) { return /^\[(\d{2}:\d{2}:\d{2})\]/.exec(s); }

    // Promise-basierter Bestaetigungs-Dialog. Liefert true/false.
    // options: { ok, cancel, title } - Texte sind anpassbar.
    function confirmModal(text, options = {}) {
      return new Promise((resolve) => {
        const modal = document.getElementById('confirmModal');
        const okBtn = document.getElementById('confirmOk');
        const cancelBtn = document.getElementById('confirmCancel');
        document.getElementById('confirmTitle').textContent = options.title ?? 'Best\u00e4tigen';
        document.getElementById('confirmText').textContent = text;
        okBtn.textContent = options.ok ?? 'OK';
        cancelBtn.textContent = options.cancel ?? 'Abbrechen';
        modal.classList.add('open');
        const done = (result) => {
          modal.classList.remove('open');
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
          resolve(result);
        };
        const onOk = () => done(true);
        const onCancel = () => done(false);
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
      });
    }

    // Swords in der Ansicht neu laden (nach Neustart/Merker-Aenderung).
    // Kleiner Aufschub, damit der Server den neuen Zustand schon liefert.
    let swordsRefreshTimer = null;
    function scheduleSwordsRefresh(delay = 1200) {
      if (swordsRefreshTimer) clearTimeout(swordsRefreshTimer);
      swordsRefreshTimer = setTimeout(() => { reloadSwords().catch(() => {}); }, delay);
    }

    function dotClass(state) {
      if (state === 'active') return 'dot running';
      if (state === 'inactive' || state === 'failed') return 'dot stopped';
      return 'dot unknown';
    }

    async function refreshStatus(id, el) {
      const { status, data } = await api(`/api/swords/${id}/status`);
      if (status !== 200) { el.querySelector('.label').textContent = data.error ?? 'Fehler'; return; }
      el.querySelector('.dot').className = dotClass(data.state);
      el.querySelector('.label').textContent = data.running ? 'Läuft' : 'Gestoppt';
      const meta = el.querySelector('.meta');
      if (meta && data.since) meta.textContent = 'seit ' + fmtSince(data.since);

      // Merker "Neustart ausstehend" live nachziehen. Der Server liefert das
      // Flag in /status mit und raeumt es selbst weg, sobald der Server
      // gestoppt ist (dann greifen die neuen Werte beim naechsten Start ohnehin).
      const card = el.closest('.card');
      const shown = card.querySelector('.restart-pending');
      if (data.pendingRestart && !shown) {
        const div = document.createElement('div');
        div.className = 'warn restart-pending';
        div.title = 'Gespeicherte Einstellungen greifen erst nach einem Neustart';
        div.innerHTML = '⚠ Neustart ausstehend <button class="ghost mini" data-restart-now="1">Jetzt neustarten</button>';
        div.querySelector('[data-restart-now]').addEventListener('click', async (e) => {
          e.stopPropagation();
          e.currentTarget.disabled = true;
          const r = await api(`/api/swords/${id}/restart`, { method: 'POST' });
          if (r.status !== 200) toast('Fehler: ' + (r.data.error ?? r.status));
          setTimeout(() => refreshStatus(id, el), 800);
        });
        el.insertAdjacentElement('afterend', div);
      } else if (!data.pendingRestart && shown) {
        shown.remove();
      }
    }

    function fmtSince(ts) {
      if (!ts) return '';
      const d = new Date(ts * 1000);
      const s = Math.floor((Date.now() - d.getTime()) / 1000);
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + ' min';
      return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
    }

    function renderSwords(swords) {
      const swordsEl = document.getElementById('swords');
      swordsEl.innerHTML = '';
      document.getElementById('hint').textContent = `${swords.length} Sword(s) geladen.`;
      const editable = can('sword.config.read');
      const mayStart = can('sword.control.start');

      for (const sword of swords) {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
          <h2>${sword.name} <span class="ver ${sword.versionState ? 'v-' + esc(sword.versionState) : 'v-unknown'}" title="${esc(versionTooltip(sword))}">v${esc(sword.installedVersion ?? '—')}${versionHint(sword)}</span></h2>
          <div class="desc">${sword.description ?? ''}</div>
          <span class="badge ${sword.tier === 'premium' ? 'premium' : ''}">${sword.tier}</span>
          <div class="state"><span class="dot unknown"></span><span class="label">…</span><span class="meta"></span></div>
          <div class="actions">
            <button data-a="start" ${(!mayStart || sword.locked) ? 'disabled' : ''}>▶ Start</button>
            <button data-a="stop" ${(!editable || sword.locked) ? 'disabled' : ''}>■ Stop</button>
            <div class="menu" data-menu>
              <button data-menu-toggle="1">⚙ Aktionen ▾</button>
              <div class="menu-list">
                <button data-a="restart" ${(!editable || sword.locked) ? 'disabled' : ''}>↻ Restart</button>
                ${!!editable && !sword.locked ? '<button data-update="1">⬆ Update</button>' : ''}
                ${!sword.locked ? '<button data-config="1">⚙ Konfiguration</button>' : ''}
                ${can('sword.config.write') && !sword.locked ? '<button data-version="1">🏷 Version eintragen</button>' : ''}
                ${/* EULA nachtragen: nur bei Racks mit eula === 'required' (z.B.
                     Minecraft). Der Sword-Datensatz wird vom Loader aus dem Rack
                     angereichert (swords.js), daher kein Spiel-Hardcode hier. */
                  can('sword.eula') && sword.eula === 'required'
                    ? '<button data-eula="1">✔ EULA nachtragen</button>' : ''}
                ${can('sword.delete') ? '<div class="menu-sep"></div><button class="danger" data-remove="1">🗑 Sword entfernen</button>' : ''}
              </div>
            </div>
          </div>
          ${sword.javaWarning ? `<div class="warn" title="Java-Version passt nicht">⚠ ${esc(sword.javaWarning)}</div>` : ''}
          ${sword.restartPending ? '<div class="warn restart-pending" title="Gespeicherte Einstellungen greifen erst nach einem Neustart">⚠ Neustart ausstehend <button class="ghost mini" data-restart-now="1">Jetzt neustarten</button></div>' : ''}
          ${sword.locked ? '<div class="locked">🔒 Lizenz erforderlich</div>'
            : (!editable ? '<div class="locked">Nur Ansicht (Rang zu niedrig)</div>' : '')}
        `;
        const stateEl = card.querySelector('.state');

        // Dropdown-Menue: oeffnen/schliessen, Klick ausserhalb schliesst.
        const menu = card.querySelector('[data-menu]');
        if (menu) {
          const toggle = menu.querySelector('[data-menu-toggle]');
          toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = menu.classList.contains('open');
            document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
            if (!isOpen) menu.classList.add('open');
          });
          // Klick auf einen Menueintrag schliesst das Menue.
          menu.querySelectorAll('.menu-list button').forEach((b) => {
            b.addEventListener('click', () => menu.classList.remove('open'));
          });
        }

        const updateBtn = card.querySelector('[data-update]');
        if (updateBtn) {
          updateBtn.addEventListener('click', () => {
            let running = false;
            const dot = stateEl.querySelector('.dot');
            const label = stateEl.querySelector('.label');
            const meta = stateEl.querySelector('.meta');
            if (dot) running = dot.classList.contains('running');
            openUpdateModal(sword, {
              running,
              stateText: label ? label.textContent : '',
              since: meta ? meta.textContent : '',
            });
          });
        }
        const removeBtn = card.querySelector('[data-remove]');
        if (removeBtn) {
          removeBtn.addEventListener('click', () => openRemoveModal(sword));
        }
        const eulaBtn = card.querySelector('[data-eula]');
        if (eulaBtn) {
          eulaBtn.addEventListener('click', () => openEulaModal(sword));
        }
        const versionBtn = card.querySelector('[data-version]');
        if (versionBtn) {
          versionBtn.addEventListener('click', () => openVersionModal(sword));
        }
        const configBtn = card.querySelector('[data-config]');
        if (configBtn) {
          configBtn.addEventListener('click', () => openConfigModal(sword));
        }
        // "Jetzt neustarten" aus dem Merker-Hinweis auf der Karte.
        const restartNowBtn = card.querySelector('[data-restart-now]');
        if (restartNowBtn) {
          restartNowBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            restartNowBtn.disabled = true;
            const { status, data } = await api(`/api/swords/${sword.id}/restart`, { method: 'POST' });
            if (status !== 200) toast('Fehler: ' + (data.error ?? status));
            setTimeout(() => refreshStatus(sword.id, stateEl), 800);
          });
        }
        card.querySelectorAll('[data-a]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            const { status, data } = await api(`/api/swords/${sword.id}/${btn.dataset.a}`, { method: 'POST' });
            btn.disabled = false;
            if (status !== 200) toast('Fehler: ' + (data.error ?? status));
            setTimeout(() => refreshStatus(sword.id, stateEl), 800);
          });
        });
        swordsEl.appendChild(card);
        refreshStatus(sword.id, stateEl);
        setInterval(() => refreshStatus(sword.id, stateEl), 10000);
      }

      // Select NACH dem Aufbau einmal sauber neu befuellen (verhindert
      // Vervielfaeltigung bei mehrfachem renderSwords, z.B. "Swords neu laden").
      fillSwordSelect(swords);
    }

    // Befuellt die Livekonsolen-Auswahl (#swordSelect) frisch. Wird aus
    // renderSwords() aufgerufen; das Select wird vorher geleert.
    function fillSwordSelect(swords) {
      const sel = document.getElementById('swordSelect');
      const prev = sel.value;
      sel.innerHTML = '';
      for (const sword of swords) {
        const opt = document.createElement('option');
        opt.value = sword.id; opt.textContent = sword.name;
        sel.appendChild(opt);
      }
      // Vorherige Auswahl beibehalten, falls das Sword noch existiert.
      if (prev && swords.some((r) => r.id === prev)) sel.value = prev;
    }

    // --- Konsole ------------------------------------------------------------
    // APPEND-ONLY: Beim Stop schiesst der Server viele Zeilen gleichzeitig herein.
    // Ein komplettes Neu-Rendern pro Zeile laesst die Ansicht flackern und die
    // Scrollposition springen. Darum haengen wir einzelne Zeilen nur an den DOM an.
    function makeLineEl(line) {
      const showTs = document.getElementById('timestamps').checked;
      const div = document.createElement('div');
      div.className = 'logline';
      div.textContent = showTs ? ('[' + line.at + '] ' + line.raw) : line.raw;
      return div;
    }

    function appendLine(line) {
      const box = document.getElementById('console');
      if (box.dataset.placeholder === '1') { box.textContent = ''; box.dataset.placeholder = '0'; }
      box.appendChild(makeLineEl(line));
      while (box.childElementCount > MAX_LINES) box.removeChild(box.firstChild);
      let textLen = box.textContent.length;
      while (box.childElementCount > 200 && textLen > MAX_BUFFER) {
        const first = box.firstChild;
        textLen -= first.textContent.length + 1;
        box.removeChild(first);
      }
      if (document.getElementById('autoscroll').checked) box.scrollTop = box.scrollHeight;
    }

    function renderConsoleAll() {
      const box = document.getElementById('console');
      box.innerHTML = '';
      for (const l of logLines) box.appendChild(makeLineEl(l));
      if (document.getElementById('autoscroll').checked) box.scrollTop = box.scrollHeight;
      updateConsoleStatus();
    }

    function updateConsoleStatus() {
      const st = document.getElementById('consoleStatus');
      if (!ws) { st.textContent = 'nicht verbunden'; return; }
      // Echte Log-Zeit nutzen (ATM10 praefix [HH:MM:SS]), nicht die Empfangszeit.
      const last = logLines[logLines.length - 1];
      let agoTxt = '';
      const m = last && /^\[(\d{2}):(\d{2}):(\d{2})\]/.exec(last.raw);
      if (m) {
        const now = new Date();
        const t = new Date();
        t.setHours(+m[1], +m[2], +m[3], 0);
        let secs = Math.floor((now - t) / 1000);
        if (secs < 0) secs += 86400; // Tageswechsel
        agoTxt = secs < 60 ? secs + 's' : Math.floor(secs / 60) + ' min';
        st.textContent = `${logLines.length} Zeilen · letzter Log-Eintrag vor ${agoTxt}`;
        return;
      }
      st.textContent = `${logLines.length} Zeilen`;
    }

    function pushLog(raw) {
      const now = new Date();
      const at = now.toLocaleTimeString('de-DE');
      // ATM10-Logs bringen eigenen [HH:MM:SS]-Präfix; Zeitstempel-Toggle zeigt Empfangszeit
      for (const line of raw.split('\n')) {
        if (line.length === 0) continue;
        const entry = { raw: line, ts: Date.now(), at };
        logLines.push(entry);
        appendLine(entry);
      }
      if (logLines.length > MAX_LINES) logLines = logLines.slice(-MAX_LINES);
    }

    setInterval(() => { if (ws) updateConsoleStatus(); }, 5000); // "letzte vor Xs" aktualisieren

    // --- Nutzerverwaltung ---------------------------------------------------
    async function loadUsers() {
      const { data } = await api('/api/auth/users');
      const el = document.getElementById('usersList');
      if (!Array.isArray(data)) { el.textContent = 'Keine Daten.'; return; }
      el.innerHTML = `<table class="users-tbl"><thead><tr><th>Benutzer</th><th>Rang</th><th>E-Mail</th><th></th></tr></thead><tbody>
        ${data.map((u) => `<tr>
          <td>${esc(u.username)}${u.id === me.id ? ' (du)' : ''}</td>
          <td>
            <select data-uid="${u.id}" class="roleSel">
              ${Object.entries(RANGEN).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </td>
          <td>${can('user.email')
            ? `<input class="emailInp" data-uid="${u.id}" type="email" value="${esc(u.email ?? '')}" placeholder="keine E-Mail" />`
            : esc(u.email ?? '–')}</td>
          <td class="row-actions">
            ${can('user.password') && u.id !== me.id ? `<button data-reset="${u.id}">Passwort zurücksetzen</button> ` : ''}
            ${u.id === me.id ? '' : `<button class="danger" data-del="${u.id}">Löschen</button>`}
          </td>
        </tr>`).join('')}
      </tbody></table>`;

      el.querySelectorAll('.roleSel').forEach((sel) => {
        sel.addEventListener('change', async () => {
          const { status, data } = await api(`/api/auth/users/${sel.dataset.uid}`, {
            method: 'PATCH', body: JSON.stringify({ role: sel.value }),
          });
          if (status !== 200) toast('Fehler: ' + (data.error ?? status));
          else toast('Rang geändert.');
        });
      });
      // E-Mail je Nutzer speichern (Admin, Recht user.email).
      el.querySelectorAll('.emailInp').forEach((inp) => {
        let last = inp.value;
        const save = async () => {
          if (inp.value === last) return;
          const { status, data } = await api(`/api/auth/users/${inp.dataset.uid}/email`, {
            method: 'POST', body: JSON.stringify({ email: inp.value }),
          });
          if (status !== 200) { toast('Fehler: ' + (data.error ?? status)); inp.value = last; }
          else { last = inp.value; toast('E-Mail gespeichert.'); }
        };
        inp.addEventListener('blur', save);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
      });
      el.querySelectorAll('[data-reset]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const user = data.find((u) => String(u.id) === String(btn.dataset.reset));
          if (user) openPasswordReset(user);
        });
      });
      el.querySelectorAll('[data-del]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Nutzer löschen?')) return;
          const { status, data } = await api(`/api/auth/users/${btn.dataset.del}`, { method: 'DELETE' });
          if (status !== 200) toast('Fehler: ' + (data.error ?? status));
          else { toast('Nutzer gelöscht.'); loadUsers(); }
        });
      });
    }

    // --- Einstellungen (nur Admin) ------------------------------------------
    let keyLoaded = false;   // true = ein Key ist gesetzt und die Vorschau wird angezeigt
    let keyEditing = false;  // true = Eingabefeld ist offen (ersetzen)

    // SMTP: Die API maskiert ALLE Nicht-Zahlen-Settings ueber {set, preview} -
    // auch smtp_host/smtp_user/from_*. Der Klartext ist also absichtlich nicht
    // abrufbar. Deshalb fuellen wir die Felder NICHT vor, sondern zeigen den
    // maskierten preview nur als Platzhalter-Hinweis und senden beim Speichern
    // ausschliesslich die vom Nutzer tatsaechlich geaenderten Felder.
    const SMTP_FIELDS = ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user',
      'smtp_pass', 'smtp_from_name', 'smtp_from_address', 'smtp_enabled'];
    // Zuletzt vom Server geladener Zustand (nur fuer den Changed-Vergleich).
    let smtpLoaded = false;        // true = erster GET war erfolgreich
    let smtpBaseline = {};         // { key: {set,preview} } aus GET /api/settings
    // Eingabefeld-ID -> Settings-Key.
    const SMTP_INPUT = {
      smtpHost: 'smtp_host', smtpPort: 'smtp_port', smtpSecure: 'smtp_secure',
      smtpUser: 'smtp_user', smtpPass: 'smtp_pass',
      smtpFromName: 'smtp_from_name', smtpFromAddress: 'smtp_from_address',
    };

    // Ist der Wert des Feldes nicht mehr der beim Laden gesetzte? Fuer leere
    // Felder gilt: leer = unveraendert (Server behaelt seinen Wert, nichts senden).
    // WICHTIG: Die API maskiert ALLE Nicht-Zahlen-Settings (auch smtp_secure),
    // der echte Wert ist also nie abrufbar. Deshalb vergleichen wir nur gegen
    // "hat der Nutzer etwas eingetippt" - nicht gegen einen bekannten Rohwert.
    function smtpChanged(id) {
      const val = String(document.getElementById(id).value ?? '').trim();
      return val === '' ? null : val;   // leer = unveraendert
    }

    function renderSmtp(data) {
      const g = (k) => data[k] ?? {};
      smtpBaseline = {};
      SMTP_FIELDS.forEach((k) => { smtpBaseline[k] = g(k); });
        const pass = g('smtp_pass');
        const el = (id) => document.getElementById(id);
        // Konfigurationswerte liefert das Backend im Klartext als {set, value};
        // nur ECHTE Secrets (smtp_pass) kommen maskiert als {set, preview}.
        const val = (k) => (g(k).value ?? '');
        el('smtpHost').value = val('smtp_host');
        el('smtpPort').value = val('smtp_port');
        el('smtpUser').value = val('smtp_user');
        el('smtpFromName').value = val('smtp_from_name');
        el('smtpFromAddress').value = val('smtp_from_address');
        el('smtpSecure').value = val('smtp_secure') === 'true' ? 'true' : 'false';
        el('smtpEnabled').checked = val('smtp_enabled') === 'true';
        // Leak-Pruefung: fehlt das Setting, ist sie AN (Default).
        const hibpEl = el('hibpEnabled');
        if (hibpEl) hibpEl.checked = String(val('hibp_enabled')).trim().toLowerCase() !== 'false';
        // Das Passwort ist ein Secret: Feld bleibt LEER, nur der Hinweis zeigt,
        // DASS eines gesetzt ist. Leer lassen = unveraendert.
        el('smtpPass').value = '';
        el('smtpPass').placeholder = pass.set
          ? `gesetzt (${pass.preview ?? '••••'}) - leer lassen = unveraendert`
          : 'Passwort';
      const state = el('smtpState');
      const bits = [
        pass.set ? 'Passwort gesetzt' : 'kein Passwort',
        host.set ? 'Server hinterlegt' : 'kein Server',
        from.set ? 'Absender gesetzt' : 'kein Absender',
      ];
      state.textContent = 'Status: ' + bits.join(' | ');
      smtpLoaded = true;
    }

    // --- Diagnose -----------------------------------------------------------
    // Zeigt Ladefehler/-hinweise der Racks und Swords im Panel. Die Dateien
    // werden serverseitig frisch von der Platte geprueft (GET /api/diagnostics).
    async function loadDiagnostics() {
      const box = document.getElementById('diagResult');
      if (!box) return;
      box.textContent = 'Wird geprueft…';
      const { status, data } = await api('/api/diagnostics');
      if (status !== 200) {
        box.innerHTML = '<div class="warn">Diagnose nicht abrufbar: ' + esc(data.error ?? ('HTTP ' + status)) + '</div>';
        return;
      }
      box.innerHTML = renderDiagnostics(data);
    }

    function diagSection(title, part) {
      const errs = part?.errors ?? [];
      const warns = part?.warnings ?? [];
      let html = '<h5 style="margin:12px 0 4px;">' + esc(title) + ' <span class="meta">'
        + (part?.count ?? 0) + ' geladen</span></h5>';
      if (errs.length === 0 && warns.length === 0) {
        html += '<div class="meta">Keine Fehler, keine Hinweise.</div>';
        return html;
      }
      html += '<ul style="margin:4px 0 0;padding-left:18px;">';
      for (const e of errs) {
        html += '<li class="warn"><b>' + esc(e.file) + '</b>: ' + esc(e.message) + '</li>';
      }
      for (const w of warns) {
        html += '<li class="meta"><b>' + esc(w.file) + '</b>: ' + esc(w.message) + '</li>';
      }
      html += '</ul>';
      return html;
    }

    function renderDiagnostics(data) {
      let html = '<div class="meta">Stand: ' + esc(fmtTime(data.checkedAt)) + '</div>';
      html += diagSection('Racks (Schablonen)', data.racks);
      html += diagSection('Swords (Instanzen)', data.swords);
      return html;
    }

    function fmtTime(iso) {
      if (!iso) return '–';
      const d = new Date(iso);
      return d.toLocaleTimeString('de-DE') + ' Uhr';
    }

    // --- Rechte-Matrix --------------------------------------------------------
    // laedt die Matrix per GET /api/auth/permissions. Aenderungen werden lokal
    // gesammelt und erst per "Speichern" als PUT geschickt (changes[]).
    let permsData = null;
    let permsDirty = new Set();

    async function loadPermissions() {
      const box = document.getElementById('permsMatrix');
      if (!box) return;
      box.textContent = 'Wird geladen…';
      permsDirty.clear();
      updatePermsSaveBtn();
      const { status, data } = await api('/api/auth/permissions');
      if (status !== 200) {
        box.innerHTML = '<div class="warn">Matrix nicht abrufbar: '
          + esc(data.error ?? ('HTTP ' + status)) + '</div>';
        return;
      }
      permsData = data;
      renderPermsMatrix(data);
    }

    function permCellKey(role, perm) { return role + '|' + perm; }

    function onPermToggle(role, perm, checked) {
      if (!permsData) return;
      permsData.matrix[role][perm] = checked;
      permsDirty.add(permCellKey(role, perm));
      updatePermsSaveBtn();
    }

    function updatePermsSaveBtn() {
      const btn = document.getElementById('permsSave');
      const state = document.getElementById('permsState');
      if (!btn) return;
      btn.disabled = permsDirty.size === 0;
      if (state) state.textContent = permsDirty.size === 0
        ? '' : permsDirty.size + ' Änderung(en) vorgemerkt';
    }

    function renderPermsMatrix(data) {
      const box = document.getElementById('permsMatrix');
      const roles = data.roles ?? [];
      const groups = [];
      for (const p of data.permissions ?? []) {
        let g = groups.find((x) => x.name === p.group);
        if (!g) { g = { name: p.group, items: [] }; groups.push(g); }
        g.items.push(p);
      }
      let html = '<table class="perms"><thead><tr><th class="perm-col">Recht</th>';
      for (const r of roles) {
        const fixed = data.editable && data.editable[r] === false;
        html += '<th title="' + esc(r) + (fixed ? ' (fix: alle Rechte, nicht aenderbar)' : '') + '">'
          + esc(RANGEN[r] ?? r) + (fixed ? ' 🔒' : '') + '</th>';
      }
      html += '</tr></thead><tbody>';
      for (const g of groups) {
        html += '<tr class="grouprow"><td colspan="' + (roles.length + 1) + '">' + esc(g.name || 'Sonstige') + '</td></tr>';
        for (const p of g.items) {
          html += '<tr><td class="perm-col"><span class="perm-label">' + esc(p.label)
            + '</span><span class="perm-key">' + esc(p.perm) + '</span></td>';
          for (const r of roles) {
            const fixed = data.editable && data.editable[r] === false;
            const on = !!(data.matrix[r] && data.matrix[r][p.perm]);
            html += '<td' + (fixed ? ' class="fixed-col"' : '') + '><input type="checkbox" data-perm-role="' + esc(r)
              + '" data-perm="' + esc(p.perm) + '"' + (on ? ' checked' : '')
              + (fixed ? ' disabled' : '') + ' /></td>';
          }
          html += '</tr>';
        }
      }
      html += '</tbody></table>';
      box.innerHTML = html;
      box.querySelectorAll('input[type=checkbox]').forEach((cb) => {
        if (cb.disabled) return;
        cb.addEventListener('change', () => onPermToggle(cb.dataset.permRole, cb.dataset.perm, cb.checked));
      });
    }

    async function savePermissions() {
      if (!permsData || permsDirty.size === 0) return;
      const changes = [];
      for (const key of permsDirty) {
        const [role, perm] = key.split('|');
        changes.push({ role, perm, allowed: !!permsData.matrix[role][perm] });
      }
      const { status, data } = await api('/api/auth/permissions', { method: 'PUT', body: { changes } });
      const state = document.getElementById('permsState');
      if (status !== 200) {
        if (state) state.textContent = 'Fehler: ' + (data.error ?? ('HTTP ' + status));
        return;
      }
      permsData = data.matrix ? data : permsData;
      permsDirty.clear();
      renderPermsMatrix(permsData);
      updatePermsSaveBtn();
      if (state) {
        state.textContent = data.errors && data.errors.length
          ? 'Gespeichert, aber ' + data.errors.length + ' abgelehnt (z.B. Superuser fix)'
          : 'Gespeichert.';
      }
      await refreshMe();
    }

    // /api/auth/me neu laden und UI-Sichtbarkeit neu bestimmen.
    async function refreshMe() {
      const res = await api('/api/auth/me');
      if (res.status !== 200) return;
      me = res.data.user;
      initProfile();
      loadSwords();
    }

    async function loadSettings() {
      const { status, data } = await api('/api/settings');
      if (status !== 200) {
        document.getElementById('cfKeyState').textContent = 'Fehler: ' + (data.error ?? status);
        return;
      }
      const cf = data.curseforge_api_key ?? {};
      keyLoaded = Boolean(cf.set);
      keyEditing = !keyLoaded;
      document.getElementById('cfKeyState').innerHTML = cf.set
        ? `Status: gesetzt <code class="pathhint">${esc(cf.preview ?? '••••')}</code>`
        : 'Status: noch kein Key hinterlegt. CurseForge-Suche und -Updates sind erst danach nutzbar.';
      const input = document.getElementById('cfKeyInput');
      input.value = '';
      input.placeholder = cf.set ? 'Neuen Key einfügen (ersetzt den alten)' : 'CurseForge API-Key einfügen';
      document.getElementById('cfKeyChange').style.display = keyEditing ? 'block' : 'none';
      document.getElementById('cfKeyReplace').style.display = keyLoaded ? 'inline-block' : 'none';
      document.getElementById('cfKeySave').style.display = keyEditing ? 'inline-block' : 'none';

      // Brute-Force-Schutz: Zahlen kommen im Klartext (nur Admin sieht den Tab).
      const bfg = (key) => data[key] ?? {};
      const state = document.getElementById('bfgState');
      if (state) {
        const mf = bfg('login_max_fails');
        document.getElementById('bfgMaxFails').value = mf.value ?? mf.default ?? 5;
        document.getElementById('bfgWindow').value = bfg('login_window_minutes').value ?? 10;
        document.getElementById('bfgBan').value = bfg('login_ban_minutes').value ?? 15;
        const wl = bfg('login_whitelist');
        document.getElementById('bfgWhitelist').value = wl.value ?? '';
        state.textContent = 'Aktiv: ' + document.getElementById('bfgMaxFails').value +
          ' Fehlversuche / ' + document.getElementById('bfgWindow').value +
          ' min  ->  ' + document.getElementById('bfgBan').value + ' min Sperre';
      }

      // SMTP (nur Superuser kann den Tab sehen).
      if (document.getElementById('smtpState')) renderSmtp(data);

      // Versions-Pruefung: Intervall (0 = nur manuell).
      const vcField = document.getElementById('vcMinutes');
      if (vcField) {
        const vc = data.version_check_minutes ?? {};
        vcField.value = vc.value ?? vc.default ?? 0;
      }
    }

    document.getElementById('cfKeyReplace').addEventListener('click', () => {
      keyEditing = true;
      document.getElementById('cfKeyChange').style.display = 'block';
      document.getElementById('cfKeyReplace').style.display = 'none';
      document.getElementById('cfKeySave').style.display = 'inline-block';
      document.getElementById('cfKeyInput').focus();
    });
    document.getElementById('cfKeySave').addEventListener('click', async () => {
      const value = document.getElementById('cfKeyInput').value.trim();
      if (!value) return toast('Bitte einen Key eingeben.');
      const btn = document.getElementById('cfKeySave');
      btn.disabled = true;
      const { status, data } = await api('/api/settings', {
        method: 'PUT', body: JSON.stringify({ curseforge_api_key: value }),
      });
      btn.disabled = false;
      if (status !== 200) return toast('Fehler: ' + (data.error ?? status));
      toast('Einstellungen gespeichert.');
      loadSettings();
    });

    document.getElementById('bfgSave')?.addEventListener('click', async () => {
      const num = (id, fallback) => {
        const v = Number.parseInt(document.getElementById(id).value, 10);
        return Number.isFinite(v) ? v : fallback;
      };
      const btn = document.getElementById('bfgSave');
      btn.disabled = true;
      const { status, data } = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          login_max_fails: num('bfgMaxFails', 5),
          login_window_minutes: num('bfgWindow', 10),
          login_ban_minutes: num('bfgBan', 15),
          // Leer = nur 127.0.0.1/::1. Kommagetrennt, Server trimmt.
          login_whitelist: document.getElementById('bfgWhitelist').value.trim(),
        }),
      });
      btn.disabled = false;
      if (status !== 200) return toast('Fehler: ' + (data.error ?? status));
      toast('Brute-Force-Schutz gespeichert.');
      loadSettings();
    });

    document.getElementById('vcSave')?.addEventListener('click', async () => {
      const raw = Number.parseInt(document.getElementById('vcMinutes').value, 10);
      const minutes = Number.isFinite(raw) && raw >= 0 && raw <= 1440 ? raw : 0;
      const btn = document.getElementById('vcSave');
      btn.disabled = true;
      const { status, data } = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ version_check_minutes: minutes }),
      });
      btn.disabled = false;
      if (status !== 200) return toast('Fehler: ' + (data.error ?? status));
      toast(minutes === 0
        ? 'Gespeichert: Prüfung nur auf Knopfdruck.'
        : `Gespeichert: Prüfung alle ${minutes} Minuten.`);
      loadSettings();
    });

    // Jetzt alle Swords pruefen. Sequenziell im Server, damit die Quellen
    // nicht parallel angefunkt werden. Ergebnis landet in den Sword-Dateien.
    document.getElementById('vcCheckAll')?.addEventListener('click', async () => {
      const btn = document.getElementById('vcCheckAll');
      const out = document.getElementById('vcAllResult');
      btn.disabled = true;
      if (out) {
        out.style.display = 'block';
        out.textContent = 'Prüfe alle Server … (kann bis zu einer Minute dauern)';
      }
      try {
        const { status, data } = await api('/api/swords/version-check-all', { method: 'POST' });
        if (!out) return;
        if (status !== 200) {
          out.textContent = 'Fehler: ' + (data.error ?? status);
          return;
        }
        // esc(): die Namen und Begruendungen kommen aus Rack-/Sword-Dateien
        // und Fehlermeldungen fremder Quellen. Wie ueberall im Panel werden
        // sie escaped, nicht roh in innerHTML gesetzt.
        const rows = (data.results ?? []).map((r) => {
          const st = r.state === 'current' ? 'aktuell'
            : r.state === 'outdated' ? 'veraltet'
            : 'unbekannt';
          const detail = r.state === 'unknown' && r.reason ? ' — ' + esc(r.reason) : '';
          return esc(r.name) + ': ' + esc(st) + ' (installiert ' + esc(r.installed ?? '?')
            + (r.available ? ', verfügbar ' + esc(r.available) : '')
            + ')' + detail;
        });
        out.innerHTML = rows.map((t) => '<div>' + t + '</div>').join('');
        scheduleSwordsRefresh(200);
      } catch (err) {
        // Ohne catch blieb der Knopf bei einem Netzfehler dauerhaft gesperrt.
        if (out) out.textContent = 'Fehler: ' + esc(err.message ?? err);
      } finally {
        btn.disabled = false;
      }
    });

    // --- SMTP: Speichern (nur geaenderte Felder senden) ---------------------
      document.getElementById('smtpSave')?.addEventListener('click', async () => {
        // Alle Felder sind vorausgefuellt (Klartext aus dem Backend). Wir senden
        // schlicht die aktuellen Formularwerte - das Backend speichert sie.
        // smtp_pass ist Sonderfall: nur senden, wenn wirklich neu eingetippt.
        const body = {
          smtp_host: String(document.getElementById('smtpHost').value ?? '').trim(),
          smtp_port: String(document.getElementById('smtpPort').value ?? '').trim() || '587',
          smtp_user: String(document.getElementById('smtpUser').value ?? '').trim(),
          smtp_secure: String(document.getElementById('smtpSecure').value === 'true'),
          smtp_enabled: String(document.getElementById('smtpEnabled').checked),
          hibp_enabled: String(document.getElementById('hibpEnabled').checked),
          smtp_from_name: String(document.getElementById('smtpFromName').value ?? '').trim(),
          smtp_from_address: String(document.getElementById('smtpFromAddress').value ?? '').trim(),
        };
        // Passwort NUR senden, wenn ein NEUES eingetippt wurde (Feld ist sonst leer).
        const passVal = String(document.getElementById('smtpPass').value ?? '');
        if (passVal.trim() !== '' && !passVal.includes('\u2022')) body.smtp_pass = passVal;

      const btn = document.getElementById('smtpSave');
      btn.disabled = true;
      const { status, data } = await api('/api/settings', {
        method: 'PUT', body: JSON.stringify(body),
      });
      btn.disabled = false;
      if (status !== 200) return toast('Fehler: ' + (data.error ?? status));
      toast('SMTP-Einstellungen gespeichert.');
      loadSettings();
    });

    // --- SMTP: Testmail -----------------------------------------------------
    document.getElementById('smtpTest')?.addEventListener('click', async () => {
      const to = String(document.getElementById('smtpTestTo').value ?? '').trim();
      const out = document.getElementById('smtpTestResult');
      out.style.display = 'block';
      if (!to) { out.textContent = 'Bitte eine Empfaengeradresse angeben.'; return; }
      const btn = document.getElementById('smtpTest');
      btn.disabled = true;
      out.textContent = 'Sende Testmail an ' + to + ' …';
      const { status, data } = await api('/api/settings/test-mail', {
        method: 'POST', body: JSON.stringify({ to }),
      });
      btn.disabled = false;
      if (status === 200 && data.ok) {
        out.textContent = 'Testmail gesendet an ' + (data.to ?? to) + '.';
      } else {
        out.textContent = 'Fehler: ' + (data.error ?? status);
      }
    });

    // Diagnose: erneut pruefen (frisch von der Platte).
    document.getElementById('diagReload')?.addEventListener('click', loadDiagnostics);

    // --- Profil-Modal (Tabs: Profil / Nutzer / Einstellungen) ---------------
    // Die Tab-Inhalte tragen dieselben IDs wie frueher #usersModal/#settingsModal,
    // damit loadUsers/loadSettings und alle Handler unveraendert weiterlaufen.
    let profileResetUser = null;   // Nutzer, dessen Passwort gerade zurueckgesetzt wird

    function setProfileTab(tab) {
      document.querySelectorAll('#profileTabs button').forEach((b) => {
        if (b.style.display === 'none') return;   // versteckte Tabs nie aktivieren
        b.classList.toggle('active', b.dataset.ptab === tab);
      });
      const paneId = { profile: 'pTabProfile', users: 'pTabUsers', settings: 'pTabSettings', updates: 'pTabUpdates', reset: 'pTabReset', diagnose: 'pTabDiagnose', perms: 'pTabPerms' }[tab];
      document.querySelectorAll('#profileModal .tabpane').forEach((p) => {
        p.classList.toggle('active', p.id === paneId);
      });
    }

    function openProfile(tab = 'profile') {
      document.getElementById('profileName').textContent = me ? me.username : '–';
      document.getElementById('profileRole').textContent = me ? (RANGEN[me.role] ?? me.role) : '–';
      document.getElementById('profileModal').classList.add('open');
      setProfileTab(tab);
      if (tab === 'users') loadUsers();
      // Die Update-Sektionen liegen im Tab "Updates". Ohne diesen Aufruf
      // bleiben die Statusboxen beim ersten Oeffnen auf ihrem Platzhalter
      // stehen ("Rechte werden geprueft ...") und behaupten eine Pruefung,
      // die nie startet.
      if (tab === 'settings') loadSettings();
      if (tab === 'updates') { loadSettings(); loadSelfUpdate(); }
      if (tab === 'diagnose') loadDiagnostics();
      if (tab === 'perms') loadPermissions();
    }

    function closeProfile() {
      document.getElementById('profileModal').classList.remove('open');
    }

    // Tabs je nach Rang freischalten und Profil-Daten setzen (nach /auth/me).
    // Version im Header (2026-10-19): traegt jetzt den ZUSTAND.
    // Gruen = aktuell, gelb = neuer Stand da, grau = keine belastbare Aussage.
    // Dieselben Klassen wie bei den Swords - eine Farbe, eine Bedeutung.
    // Der Zustand kommt vom Hintergrund-Takt (GET /api/self-update/state),
    // nicht von einem Abgleich bei jedem Seitenaufruf.
    async function loadVersion() {
      const badge = document.getElementById('versionBadge');
      if (!badge) return;
      const { status, data } = await api('/api/version');
      if (status !== 200) { badge.textContent = 'v?'; badge.title = data.error ?? ('HTTP ' + status); return; }
      const tag = data.tag ?? '?';
      badge.textContent = tag + (data.dirty ? ' *' : '');

      const bits = [];
      if (data.commit) bits.push('Commit ' + data.commit);
      if (data.dirty) bits.push('Arbeitsstand: ungespeicherte Aenderungen');
      if (data.source === 'package') bits.push('Quelle: package.json (kein Git)');

      // Zustand der Selbst-Update-Pruefung. Faellt sie aus, bleibt das Badge
      // neutral (grau) - nie gruen ohne Beleg.
      let su = null;
      try {
        const st = await api('/api/self-update/state');
        if (st.status === 200) su = st.data;
      } catch { su = null; }

      badge.classList.remove('v-current', 'v-outdated', 'v-unknown');
      if (su && su.state === 'current') {
        badge.classList.add('v-current');
        bits.push('Status: aktuell');
        badge.textContent = tag + (data.dirty ? ' *' : '') + ' \u25cf';
      } else if (su && su.state === 'outdated') {
        badge.classList.add('v-outdated');
        bits.push('Verfuegbar: ' + su.available);
        bits.push('Status: Update verfuegbar');
        badge.textContent = tag + (data.dirty ? ' *' : '') + ' \u2192 ' + su.available;
      } else {
        badge.classList.add('v-unknown');
        bits.push(su && su.reason ? su.reason : 'Status: unbekannt');
        badge.textContent = tag + (data.dirty ? ' *' : '') + ' \u25cb';
      }
      if (su && su.checkedAt) bits.push('Geprueft: ' + new Date(su.checkedAt).toLocaleString('de-DE'));
      badge.title = bits.join(' \u00b7 ') || tag;
    }

    // Der Badge verspricht Klickbarkeit (cursor: pointer) - also muss er auch
    // etwas tun. Er oeffnet den Updates-Tab, wo "Armory selbst" steht.
    // Nur wer Einstellungen lesen darf, kommt dort hin; sonst bleibt es beim
    // Tooltip, statt in einen leeren Tab zu fuehren.
    (function wireVersionBadge() {
      const badge = document.getElementById('versionBadge');
      if (!badge) return;
      const open = () => {
        if (typeof can === 'function' && !can('settings.read')) return;
        openProfile('updates');
        // Nach dem Oeffnen einmal nachladen, damit der Zustand frisch ist.
        setTimeout(() => { loadSelfUpdate(); }, 50);
      };
      badge.addEventListener('click', open);
      badge.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    })();

    function initProfile() {
      document.querySelectorAll('#profileTabs button[data-need]').forEach((b) => {
        b.style.display = can(b.dataset.need) ? 'inline-block' : 'none';
      });
      document.getElementById('profileName').textContent = me ? me.username : '–';
      document.getElementById('profileRole').textContent = me ? (RANGEN[me.role] ?? me.role) : '–';
      renderSelfEmail();
    }

    // --- Darstellung: Hell/Dunkel ------------------------------------------
    // Reihenfolge der Anwendung: 1) localStorage (sofort, kein Flackern),
    // 2) Server-Wert nach dem Login (gilt geraeteuebergreifend).
    // Der Server ist die Wahrheit; localStorage nur der schnelle Start.
    const THEME_KEY = 'armory-theme';

    function applyTheme(theme) {
      const t = theme === 'light' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', t);
      document.querySelectorAll('[data-theme-choice]').forEach((b) => {
        b.classList.toggle('active', b.dataset.themeChoice === t);
      });
      return t;
    }

    function themeFromCache() {
      try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; }
      catch { return 'dark'; }
    }

    // Vor dem ersten Zeichnen setzen, damit nichts dunkel aufblitzt.
    applyTheme(themeFromCache());

    async function loadTheme() {
      const { status, data } = await api('/api/auth/prefs');
      if (status !== 200) return;              // alt: kein Endpunkt -> Cache bleibt
      const t = applyTheme(data.theme);
      try { localStorage.setItem(THEME_KEY, t); } catch { /* privat -> egal */ }
    }

    async function saveTheme(theme) {
      applyTheme(theme);
      try { localStorage.setItem(THEME_KEY, theme); } catch { /* privat -> egal */ }
      const { status } = await api('/api/auth/prefs', {
        method: 'PUT', body: JSON.stringify({ theme }),
      });
      if (status !== 200) toast('Darstellung konnte nicht gespeichert werden.');
    }

    // Klick auf einen Darstellungs-Knopf: sofort anwenden, im Hintergrund speichern.
    document.querySelectorAll('[data-theme-choice]').forEach((b) => {
      b.addEventListener('click', () => saveTheme(b.dataset.themeChoice));
    });

    // Wird vom Menue unten gesetzt; andere Stellen (Logout, Reload) nutzen es.
    let closeWhoMenu = () => {};

    // Kontomenue: Klick auf den Namen klappt auf, Klick daneben zu.
    (function initWhoMenu() {
      const wrap = document.getElementById('whoMenu');
      const btn = document.getElementById('who');
      const acc = document.getElementById('menuAccount');
      if (!wrap || !btn) return;

      const setOpen = (open) => {
        wrap.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      };

      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setOpen(!wrap.classList.contains('open'));
      });

      // Klick irgendwo sonst schliesst das Menue.
      document.addEventListener('click', (ev) => {
        if (!wrap.classList.contains('open')) return;
        if (!wrap.contains(ev.target)) setOpen(false);
      });

      // Escape schliesst und gibt den Fokus zurueck.
      document.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Escape') return;
        if (!wrap.classList.contains('open')) return;
        setOpen(false);
        btn.focus();
      });

      closeWhoMenu = () => setOpen(false);

      if (acc) acc.addEventListener('click', () => {
        setOpen(false);
        openProfile('profile');
      });
    })();
    document.getElementById('profileClose').addEventListener('click', closeProfile);
    document.getElementById('permsSave').addEventListener('click', savePermissions);

    // --- Selbst-Update der Armory (2026-10-19) ------------------------------
    // Nur der Superuser darf das: ein fehlgeschlagenes Selbst-Update legt das
    // ganze Panel lahm - inklusive der Möglichkeiten, es zu reparieren.
    // Der eigentliche Tausch läuft im privilegierten Helfer
    // (/usr/local/bin/armory-self-update), nicht im Panel-Prozess.
    let suTagsLoaded = false;

    function suBox(id, text, tone) {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.display = 'block';
      el.textContent = text;
      el.classList.remove('ok', 'warn', 'bad');
      if (tone) el.classList.add(tone);
    }

    // Ergebnis des letzten Selbst-Updates anzeigen (Karte 2026-10-25).
    // Beim Update startet der Dienst neu, die HTTP-Antwort stirbt - der Browser
    // sieht 502, obwohl es geklappt hat. Das Ergebnis liegt deshalb als Datei
    // vor und wird hier nachgelesen. Kein Eintrag = noch nie gelaufen: dann
    // bleibt die Box unsichtbar, statt "unbekannt" zu behaupten.
    async function loadLastResult() {
      const el = document.getElementById('suLastResult');
      if (!el) return;
      const r = await api('/api/system/self-update/last-result');
      const d = r.status === 200 ? r.data.result : null;
      if (!d) { el.style.display = 'none'; return; }

      const when = d.at ? new Date(d.at).toLocaleString('de-DE') : 'unbekannt';
      const map = {
        'ok': ['Update auf ' + (d.tag ?? '?') + ' erfolgreich (' + when + ')', 'ok'],
        'dry-run': ['Nur Trockenlauf, nichts getauscht (' + when + ')', null],
        'rolled-back': ['Update auf ' + (d.tag ?? '?') + ' zurückgerollt — Grund: ' +
          (d.reason ?? 'unbekannt') + ' (' + when + ')', 'warn'],
        'rollback-failed': ['Update fehlgeschlagen UND Rückrollung fehlgeschlagen — ' +
          'bitte Dienst prüfen (' + when + ')', 'bad'],
        'rollback-checkout-failed': ['Update fehlgeschlagen, Rückrollung nicht möglich — ' +
          'Sicherung: ' + (d.backup ?? 'unbekannt') + ' (' + when + ')', 'bad'],
      };
      const [text, tone] = map[d.result] ?? ['Letztes Update: ' + d.result + ' (' + when + ')', null];
      let full = text;
      if (d.previous && d.previous !== d.tag) full = 'Vorher ' + d.previous + ' — ' + text;
      suBox('suLastResult', full, tone);
    }

    async function loadSelfUpdate() {
      // Rechte zuerst: ohne sie ist alles andere sinnlos.
      const r = await api('/api/system/rights');
      if (r.status !== 200) {
        suBox('suRights', 'Rechte-Prüfung nicht möglich: ' + (r.data.error ?? r.status), 'bad');
        document.getElementById('suTagsWrap').style.display = 'none';
        return;
      }
      const d = r.data;
      const label = { ok: 'läuft', partial: 'teilweise', blocked: 'gesperrt', unknown: 'unbekannt' };
      const h = d.helpers ?? {};
      const name = { install: 'Install', service: 'Dienste', selfUpdate: 'Selbst-Update' };
      const parts = Object.keys(name).map((k) => name[k] + ': ' + (h[k] ?? '?')).join(' · ');
      suBox('suRights', 'Rechte: ' + (label[d.summary] ?? d.summary) + ' — ' + parts,
        d.summary === 'ok' ? 'ok' : (d.summary === 'blocked' ? 'bad' : 'warn'));

      const canSelf = h.selfUpdate === 'ok';
      document.getElementById('suTagsWrap').style.display = canSelf ? 'block' : 'none';
      if (!canSelf) return;

      if (!suTagsLoaded) {
        const t = await api('/api/system/self-update/tags');
        if (t.status === 200) {
          const sel = document.getElementById('suTagSelect');
          sel.innerHTML = (t.data.tags ?? []).map((tag) =>
            '<option value="' + esc(tag) + '">' + esc(tag) + '</option>').join('');
          suTagsLoaded = true;
        }
      }
      const s = await api('/api/system/self-update/status');
      if (s.status === 200) {
        const cur = s.data.tag ?? '–';
        // Getrennt (2026-10-19): nur geaenderte verfolgte Dateien sperren.
        // Neue, unversionierte Dateien werden gemeldet, blockieren aber nicht -
        // sonst legt eine vergessene Datei den Betrieb dauerhaft lahm.
        const trackedNow = s.data.dirtyTracked ?? (s.data.dirty ? 1 : 0);
        const untrackedNow = s.data.dirtyUntracked ?? 0;
        let vText = 'Installiert: ' + cur;
        let vTone = 'ok';
        if (trackedNow > 0) {
          vText += ' (' + trackedNow + ' geänderte verfolgte Datei(en) — Update gesperrt)';
          vTone = 'warn';
        }
        if (untrackedNow > 0) {
          vText += (trackedNow > 0 ? ' · ' : ' · ') + untrackedNow +
            ' neue Datei(en) im Repo (unberührt)';
          if (vTone === 'ok') vTone = 'warn';
        }
        suBox('suVersion', vText, vTone);
        const btn = document.getElementById('suApply');
        btn.disabled = trackedNow > 0;
      }

      // Zustand der taeglichen Gegenprobe: dieselbe Farbe wie das Header-Badge.
      await loadLastResult();
      await loadSelfUpdateState();
    }

    // Zustand "aktuell / Update da / unbekannt" - die Quelle ist der
    // Hintergrund-Takt. Faellt die Pruefung aus, steht das hier als Grund,
    // statt dass ein Fehler als "aktuell" durchginge.
    async function loadSelfUpdateState() {
      const r = await api('/api/self-update/state');
      if (r.status !== 200) {
        return suBox('suState', 'Zustand nicht lesbar: ' + (r.data.error ?? r.status), 'warn');
      }
      const d = r.data;
      const when = d.checkedAt ? new Date(d.checkedAt).toLocaleString('de-DE') : 'nie';
      // Stammt die Aussage aus einem frueheren, erfolgreichen Lauf? Dann gilt
      // sie weiter - aber mit Datum, damit niemand sie fuer frisch haelt.
      const good = d.lastGoodAt ? new Date(d.lastGoodAt).toLocaleString('de-DE') : null;
      const staleNote = good
        ? ' · Angabe vom ' + good + ', neueste Prüfung fehlgeschlagen: ' + (d.reason ?? 'ohne Grund')
        : '';
      if (d.state === 'current') {
        suBox('suState', 'Aktuell (' + (d.installed ?? '?') + ') — zuletzt geprüft: ' + when + staleNote,
          good ? 'warn' : 'ok');
      } else if (d.state === 'outdated') {
        suBox('suState', 'Neue Version verfügbar: ' + (d.available ?? '?') +
          ' (installiert: ' + (d.installed ?? '?') + ') — zuletzt geprüft: ' + when + staleNote, 'warn');
      } else {
        suBox('suState', 'Stand unbekannt — ' + (d.reason ?? 'keine Aussage möglich') +
          ' (zuletzt geprüft: ' + when + ')', null);
      }
    }

    document.getElementById('suRecheck')?.addEventListener('click', async () => {
      suBox('suRights', 'Rechte werden neu gemessen…', null);
      const r = await api('/api/system/rights/recheck', { method: 'POST' });
      if (r.status !== 200) {
        return suBox('suRights', 'Neumessung fehlgeschlagen: ' + (r.data.error ?? r.status), 'bad');
      }
      // Neu laden, damit Anzeige und Tag-Liste den neuen Stand spiegeln.
      suTagsLoaded = false;
      loadSelfUpdate();
    });

    document.getElementById('suCheckNow')?.addEventListener('click', async () => {
      const btn = document.getElementById('suCheckNow');
      btn.disabled = true;
      suBox('suState', 'Prüfung läuft — Abgleich mit dem Repository…', null);
      try {
        const r = await api('/api/self-update/check', { method: 'POST' });
        if (r.status !== 200) {
          return suBox('suState', 'Prüfung fehlgeschlagen: ' + (r.data.error ?? r.status), 'warn');
        }
        await loadSelfUpdateState();
        loadVersion();               // Header-Badge nachziehen
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('suCheck')?.addEventListener('click', async () => {
      const tag = document.getElementById('suTagSelect').value;
      if (!tag) return;
      suBox('suResult', 'Trockenlauf läuft…', null);
      const r = await api('/api/system/self-update/dry-run', {
        method: 'POST', body: JSON.stringify({ tag }),
      });
      if (r.status !== 200) {
        return suBox('suResult', 'Trockenlauf fehlgeschlagen: ' + (r.data.error ?? r.status), 'bad');
      }
      suBox('suResult', 'Trockenlauf ok — Ziel ' + (r.data.tag ?? tag) +
        ', Sicherung angelegt. Es wurde nichts getauscht.', 'ok');
    });

    document.getElementById('suApply')?.addEventListener('click', async () => {
      const tag = document.getElementById('suTagSelect').value;
      if (!tag) return;
      if (!confirm('Armory auf ' + tag + ' aktualisieren?\n\nDas Panel startet neu und ist '
        + 'für etwa eine Minute nicht erreichbar. Bei Problemen wird automatisch '
        + 'zurückgerollt.')) return;
      suBox('suResult', 'Update läuft — das Panel startet gleich neu…', null);
      const r = await api('/api/system/self-update/apply', {
        method: 'POST', body: JSON.stringify({ tag }),
      });
      if (r.status !== 200) {
        return suBox('suResult', 'Update fehlgeschlagen: ' + (r.data.error ?? r.status), 'bad');
      }
      suBox('suResult', 'Update gestartet. Diese Seite lädt in 20 Sekunden neu…', 'ok');
      setTimeout(() => location.reload(), 20000);
    });
    document.querySelectorAll('#profileTabs button').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.style.display === 'none') return;
        setProfileTab(b.dataset.ptab);
        if (b.dataset.ptab === 'users') loadUsers();
        if (b.dataset.ptab === 'settings') { loadSettings(); loadSelfUpdate(); }
        if (b.dataset.ptab === 'diagnose') loadDiagnostics();
        if (b.dataset.ptab === 'perms') loadPermissions();
      });
    });

    // Eigenes Passwort aendern -> POST /api/auth/password {currentPassword,newPassword}
    document.getElementById('selfPasswordForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('sp_current').value;
      const newPassword = document.getElementById('sp_new').value;
      const repeat = document.getElementById('sp_new2').value;
      if (!currentPassword) return toast('Bitte das aktuelle Passwort eingeben.');
      if (newPassword.length < 8) return toast('Neues Passwort: mindestens 8 Zeichen.');
      if (newPassword !== repeat) return toast('Die neuen Passwörter stimmen nicht überein.');
      const { status, data } = await api('/api/auth/password', {
        method: 'POST', body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (status !== 200) return toast('Fehler: ' + (data.error ?? status));
      toast('Passwort geändert.');
      document.getElementById('selfPasswordForm').reset();
    });

    // Eigene E-Mail speichern -> POST /api/auth/email {email}
    document.getElementById('selfEmailForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('se_email').value.trim();
      const { status, data } = await api('/api/auth/email', {
        method: 'POST', body: JSON.stringify({ email }),
      });
      if (status !== 200) return toast('Fehler: ' + (data.error ?? status));
      toast(email ? 'E-Mail gespeichert.' : 'E-Mail entfernt.');
      me.email = email || null;
      renderSelfEmail();
    });

    // Eigenes E-Mail-Feld aus `me` befuellen (nach /auth/me und nach Aenderung).
    function renderSelfEmail() {
      const inp = document.getElementById('se_email');
      const hint = document.getElementById('seHint');
      if (!inp) return;
      inp.value = me?.email ?? '';
      if (hint) hint.textContent = me?.email
        ? 'Hinterlegt: ' + me.email
        : 'Noch keine Adresse hinterlegt - ohne sie ist kein Passwort-Reset per E-Mail möglich.';
    }

    // Admin-Reset: aus der Nutzerliste heraus das Passwort eines anderen Nutzers setzen.
    function openPasswordReset(user) {
      if (!can('user.password')) return;
      profileResetUser = user;
      document.getElementById('rpUserInfo').textContent =
        'Neues Passwort für ' + user.username + ' festlegen.';
      document.getElementById('resetPasswordForm').reset();
      setProfileTab('reset');
      document.getElementById('rp_new').focus();
    }

    document.getElementById('rpCancel').addEventListener('click', () => {
      profileResetUser = null;
      setProfileTab('users');
    });

    document.getElementById('resetPasswordForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!profileResetUser) return;
      const newPassword = document.getElementById('rp_new').value;
      const repeat = document.getElementById('rp_new2').value;
      if (newPassword.length < 8) return toast('Neues Passwort: mindestens 8 Zeichen.');
      if (newPassword !== repeat) return toast('Die Passwörter stimmen nicht überein.');
      const { status, data } = await api(
        `/api/auth/users/${encodeURIComponent(profileResetUser.id)}/password`,
        { method: 'POST', body: JSON.stringify({ newPassword }) },
      );
      if (status !== 200) return toast('Fehler: ' + (data.error ?? status));
      toast('Passwort gesetzt.');
      profileResetUser = null;
      setProfileTab('users');
    });

    // --- Quelle wählen: CurseForge-Suche + Versionsliste ---------------------
    let cfState = { mod: null, file: null };
    let upMode = 'update';   // 'update' = Sword aktualisieren | 'install' = Neuer Server
    let upSword = null;
    let upPoll = null;
    let upStatusPath = null;
    let upStartedAtMs = null;

    let upUpload = null;   // { file, uploadId } – gewählte/hochgeladene ZIP aus dem Browser
    let racksCache = [];   // Rack-Schablonen aus /api/racks
    let selectedRack = null; // aktuell im Setup gewaehltes Rack


    function upTab(tab) {
      // Sicherheitsnetz: ohne passendes Rack nur den erlaubten Tab zulassen.
      if (selectedRack) {
        const allowed = METHOD_TO_TAB[selectedRack.installMethod] ?? null;
        if (allowed && tab !== allowed) tab = allowed;
      }
      cfState = { mod: null, file: null };
      document.getElementById('upTabCf').style.display = tab === 'cf' ? 'block' : 'none';
      document.getElementById('upTabZip').style.display = tab === 'zip' ? 'block' : 'none';
      document.getElementById('upTabUpload').style.display = tab === 'upload' ? 'block' : 'none';
      const steamTab = document.getElementById('upTabSteam');
      if (steamTab) steamTab.style.display = tab === 'steam' ? 'block' : 'none';
      document.querySelectorAll('#upTabs button').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === tab);
      });
    }

    // --- Upload-Tab: Datei wählen, prüfen, per XHR mit Fortschritt senden ---
    const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;   // 2 GB

    function isZip(file) {
      return /\.zip$/i.test(file.name || '');
    }

    // Archive-Erkennung im Browser (2026-10-18): ZIP, .tar.gz, .tgz.
    // Die verbindliche Pruefung macht der Server am INHALT (Magic Bytes) -
    // hier wird nur offensichtlicher Unsinn abgefangen, damit der Nutzer
    // nicht 2 GB hochlaedt und erst dann eine Fehlermeldung sieht.
    // Archive-Erkennung im Browser (2026-10-18): ZIP und Tarballs (.tar.gz,
    // .tgz, .tar.xz, .txz, .tar.bz2) - TS6 liefert z.B. ausschliesslich .tar.xz.
    // Die verbindliche Pruefung macht der Server am INHALT (Magic Bytes) -
    // hier wird nur offensichtlicher Unsinn abgefangen, damit der Nutzer
    // nicht 2 GB hochlaedt und erst dann eine Fehlermeldung sieht.
    function isArchive(file) {
      return /(\.zip|\.tar\.gz|\.tar\.xz|\.tar\.bz2|\.tgz|\.txz)$/i.test(file.name || '');
    }

    function archiveLabel(file) {
      const n = String(file?.name ?? '').toLowerCase();
      if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'Tarball (gzip)';
      if (n.endsWith('.tar.xz') || n.endsWith('.txz')) return 'Tarball (xz)';
      if (n.endsWith('.tar.bz2')) return 'Tarball (bzip2)';
      if (n.endsWith('.zip')) return 'ZIP';
      return 'Archiv';
    }

    function resetUpload(clearInput = true) {
      upUpload = null;
      if (clearInput) {
        const input = document.getElementById('upFile');
        if (input) input.value = '';
      }
      document.getElementById('upFileInfo').style.display = 'none';
      document.getElementById('upFileName').textContent = '';
      document.getElementById('upFileMeta').textContent = '';
      document.getElementById('upUploadWrap').style.display = 'none';
      document.getElementById('upUploadMsg').style.display = 'none';
      document.getElementById('upUploadMsg').textContent = '';
      document.getElementById('upUploadBar').style.width = '0%';
      const dz = document.getElementById('upDrop');
      dz.classList.remove('over', 'ok');
    }

    function setUploadFile(file) {
      resetUpload(false);
      if (!file) return;
      if (!isArchive(file)) { toast('Nur .zip, .tar.gz, .tar.xz, .tar.bz2, .tgz oder .txz erlaubt.'); return; }
      if (file.size > MAX_UPLOAD_BYTES) {
        toast('Datei ist zu groß (' + fmtBytes(file.size) + '). Maximum 2 GB.');
        return;
      }
      upUpload = { file, uploadId: null };
      document.getElementById('upDrop').classList.add('ok');
      document.getElementById('upFileInfo').style.display = 'flex';
      document.getElementById('upFileName').textContent = file.name;
      document.getElementById('upFileMeta').textContent = fmtBytes(file.size) + ' · ' + archiveLabel(file);
    }

    // XHR statt fetch – nur so gibt es echten Upload-Fortschritt.
    function uploadZip(onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/uploads', true);
        xhr.withCredentials = true;            // Session-Cookie mitschicken
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          let data = {};
          try { data = JSON.parse(xhr.responseText); } catch {}
          if (xhr.status === 201 && data.id) resolve(data);
          else reject(new Error(data.error || ('Upload fehlgeschlagen (' + xhr.status + ').')));
        };
        xhr.onerror = () => reject(new Error('Netzwerkfehler beim Upload.'));
        const fd = new FormData();
        fd.append('file', upUpload.file, upUpload.file.name);
        // Rack-Kontext mitschicken (2026-10-18): Die Inhaltspruefung ist
        // spielabhaengig - ein TS6-Archiv wird gegen tsserver geprueft, ein
        // Modpack gegen mods/. Beim Update ist das Rack des Swords bekannt.
        const rackId = upSword?.rack ?? selectedRack?.id ?? null;
        if (rackId) fd.append('rackId', rackId);
        xhr.send(fd);
      });
    }

    function releaseBadge(rt) {
      if (rt === 1) return '<span class="badge rel">release</span>';
      if (rt === 2) return '<span class="badge beta">beta</span>';
      return '<span class="badge alpha">alpha</span>';
    }
    function fmtBytes(n) {
      if (!n) return '';
      const mb = n / 1048576;
      return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(1) + ' MB';
    }
    function fmtDate(iso) {
      if (!iso) return '';
      return String(iso).slice(0, 10);
    }
    function fmtNum(n) {
      return n == null ? '' : Number(n).toLocaleString('de-DE');
    }

    async function searchCurseForge() {
      const q = document.getElementById('cfQuery').value.trim();
      const box = document.getElementById('cfResults');
      if (!q) { toast('Bitte einen Suchbegriff eingeben.'); return; }
      box.innerHTML = '<div class="item"><span class="meta">Suche…</span></div>';
      const { status, data } = await api(`/api/curseforge/search?q=${encodeURIComponent(q)}`);
      if (status !== 200) {
        box.innerHTML = `<div class="item"><span class="meta">Fehler: ${esc(data.error ?? status)}</span></div>`;
        return;
      }
      if (!Array.isArray(data) || data.length === 0) {
        box.innerHTML = '<div class="item"><span class="meta">Keine Treffer.</span></div>';
        return;
      }
      box.innerHTML = data.map((m) => `<div class="item" data-mid="${esc(m.id)}">
        ${m.logo ? `<img src="${esc(m.logo)}" alt="" />` : '<img alt="" />'}
        <div class="grow"><div>${esc(m.name)}</div>
          <div class="meta">${esc(m.summary ?? '')}</div></div>
        <div class="meta">↓ ${fmtNum(m.downloadCount)}</div>
      </div>`).join('');
      box.querySelectorAll('.item').forEach((it) => {
        it.addEventListener('click', () => {
          box.querySelectorAll('.item').forEach((x) => x.classList.remove('sel'));
          it.classList.add('sel');
          const mod = data.find((m) => String(m.id) === it.dataset.mid);
          loadFiles(mod);
        });
      });
    }

    async function loadFiles(mod) {
      const box = document.getElementById('cfFiles');
      cfState.mod = mod;
      cfState.file = null;
      box.innerHTML = '<div class="item"><span class="meta">Lade Versionen…</span></div>';
      const { status, data } = await api(`/api/curseforge/mod/${encodeURIComponent(mod.id)}/files`);
      if (status !== 200) {
        box.innerHTML = `<div class="item"><span class="meta">Fehler: ${esc(data.error ?? status)}</span></div>`;
        return;
      }
      const files = (Array.isArray(data) ? data : []).slice()
        .sort((a, b) => String(b.fileDate ?? '').localeCompare(String(a.fileDate ?? '')));
      if (files.length === 0) {
        box.innerHTML = '<div class="item"><span class="meta">Keine Dateien gefunden.</span></div>';
        return;
      }
      box.innerHTML = files.map((f) => `<div class="item" data-fid="${esc(f.id)}">
        <div class="grow"><div>${esc(f.displayName ?? f.fileName)}</div>
          <div class="meta">${esc(fmtDate(f.fileDate))} · ${esc(fmtBytes(f.fileLength))} · ${esc((f.gameVersions ?? []).slice(0, 3).join(', '))}</div></div>
        ${releaseBadge(f.releaseType)}
      </div>`).join('');
      box.querySelectorAll('.item').forEach((it) => {
        it.addEventListener('click', () => {
          box.querySelectorAll('.item').forEach((x) => x.classList.remove('sel'));
          it.classList.add('sel');
          cfState.file = files.find((f) => String(f.id) === it.dataset.fid);
        });
      });
    }

    function buildSource(tab) {
      if (tab === 'zip') {
        const path = document.getElementById('zipPath').value.trim();
        if (!path) throw new Error('Bitte den Serverpfad zur ZIP angeben.');
        return { type: 'zip', path };
      }
      if (tab === 'upload') {
        if (!upUpload || !upUpload.uploadId) throw new Error('Bitte zuerst eine ZIP-Datei hochladen.');
        return upMode === 'update'
          ? { uploadId: upUpload.uploadId }
          : { type: 'upload', uploadId: upUpload.uploadId };
      }
      if (tab === 'steam') {
        if (!selectedRack) throw new Error('Bitte zuerst ein Rack auswählen.');
        const appId = selectedRack.source?.appId;
        if (!appId) throw new Error('Das gewählte Rack hat keine Steam-App-ID.');
        return { type: 'steam', rackId: selectedRack.id, appId, branch: selectedRack.source?.branch ?? 'public' };
      }
      if (!cfState.mod || !cfState.file) throw new Error('Bitte Modpack und Version auswählen.');
      const src = { type: 'curseforge', modId: cfState.mod.id, fileId: cfState.file.id };
      if (selectedRack) src.rackId = selectedRack.id;
      return src;
    }

    // --- Fortschrittsanzeige (Update & Installation teilen diese Logik) ------
    function stopPolling() {
      if (upPoll) { clearInterval(upPoll); upPoll = null; }
      if (upStatusPath) { const p = upStatusPath; upStatusPath = null; api(p); }
    }

    function showProgress(title) {
      document.getElementById('upForm').style.display = 'none';
      document.getElementById('upProgress').style.display = 'block';
      document.getElementById('upTitle').textContent = title;
      document.getElementById('upBar').style.width = '0%';
      document.getElementById('upBar').style.background = 'var(--accent)';
      document.getElementById('upPhase').textContent = 'Warten auf Server…';
      document.getElementById('upMessage').textContent = '';
      document.getElementById('upTimer').textContent = '';
      document.getElementById('upProgressClose').disabled = true;
    }

    let upAdminKeyShown = null;
    function renderProgress(st) {
      const phase = st.phase ?? 'unbekannt';
      // Vorrang fuer die SteamCMD-Phase (Download/Verifizierung/Installation) -
      // 'running' allein sagt dem Nutzer nichts. Prozent kommt dazu, sobald Steam
      // ihn liefert.
      const steamPhase = st.steamPhase ?? null;
      const steamPct = Number(st.steamPercent);
      let phaseText = phase;
      if (steamPhase && (phase === 'running' || phase === 'starting')) {
        phaseText = Number.isFinite(steamPct)
          ? steamPhase + ' (' + steamPct.toFixed(1).replace('.', ',') + ' %)'
          : steamPhase;
      } else if (phase === 'running' && Number.isFinite(Number(st.progress))) {
        phaseText = 'Läuft (' + Number(st.progress).toFixed(0) + ' %)';
      }
      document.getElementById('upPhase').textContent = phaseText;
      document.getElementById('upMessage').textContent = st.message ?? '';
      showAdminKey(st.result && st.result.adminKey);
      const bar = document.getElementById('upBar');
      const num = Number(st.progress);
      if (Number.isFinite(num)) {
        const pct = Math.max(0, Math.min(100, num));
        bar.style.width = pct + '%';
      }
      const box = document.getElementById('upStatus');
      box.classList.toggle('error', Boolean(st.error));
      const started = st.startedAt ? new Date(st.startedAt) : null;
      const ended = st.finishedAt ? new Date(st.finishedAt) : null;
      const from = started && !Number.isNaN(started.getTime()) ? started.getTime() : upStartedAtMs;
      const to = ended && !Number.isNaN(ended.getTime()) ? ended.getTime() : Date.now();
      if (from) document.getElementById('upTimer').textContent = 'läuft seit ' + fmtSince(from / 1000);
      if (st.error) {
        box.classList.remove('done');
        bar.style.background = 'var(--red)';
        if (!Number.isFinite(num)) bar.style.width = '100%';
        document.getElementById('upMessage').textContent = st.error;
      } else if (ended || phase === 'done' || phase === 'error') {
        bar.style.background = 'var(--green)';
        bar.style.width = '100%';
        box.classList.toggle('done', !st.error);
      }
    }

    // Admin-Schluessel (TeamSpeak-Erstinstall): nur einmal sichtbar, daher
    // direkt nach dem Install mit Kopier-Knopf anzeigen.
    function showAdminKey(key) {
      const box = document.getElementById('upAdminKey');
      if (!box) return;
      if (!key) { box.style.display = 'none'; return; }
      if (upAdminKeyShown === key) return;
      upAdminKeyShown = key;
      document.getElementById('upAdminKeyValue').textContent = key;
      box.style.display = 'block';
    }
    async function copyAdminKey() {
      const key = upAdminKeyShown;
      const btn = document.getElementById('upAdminKeyCopy');
      if (!key) return;
      try {
        await navigator.clipboard.writeText(key);
        btn.textContent = 'Kopiert \u2713';
      } catch (err) {
        const el = document.getElementById('upAdminKeyValue');
        const r = document.createRange(); r.selectNodeContents(el);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        btn.textContent = 'Markiert - Strg+C';
      }
      setTimeout(() => { btn.textContent = 'Kopieren'; }, 2500);
    }

    function startPolling(statusPath, { timeoutMs = 10 * 60 * 1000 } = {}) {
      upStatusPath = statusPath;
      upStartedAtMs = Date.now();
      let misses = 0;
      // Sofort fragen, danach im 2-Sekunden-Takt.
      const tick = async () => {
        const { status, data } = await api(statusPath);
        if (status !== 200) {
          misses += 1;
          if (misses >= 3) {
            document.getElementById('upMessage').textContent =
              'Status nicht lesbar: ' + (data.error ?? status);
          }
          return;
        }
        misses = 0;
        renderProgress(data);
        const done = Boolean(data.finishedAt) || data.phase === 'done' || data.phase === 'error';
        if (done) { stopPolling(); finishProgress(data); return; }
        if (Date.now() - upStartedAtMs > timeoutMs) {
          stopPolling();
          document.getElementById('upMessage').textContent =
            'Zeitüberschreitung — Status wird nicht mehr abgefragt.';
          document.getElementById('upProgressClose').disabled = false;
        }
      };
      upPoll = setInterval(tick, 2000);
      tick();
    }

    function finishProgress(st) {
      const box = document.getElementById('upStatus');
      document.getElementById('upPhase').textContent = st.error ? 'Fehlgeschlagen' : 'Abgeschlossen';
      box.classList.toggle('error', Boolean(st.error));
      box.classList.toggle('done', !st.error);
      const bar = document.getElementById('upBar');
      bar.style.background = st.error ? 'var(--red)' : 'var(--green)';
      if (!st.error) bar.style.width = '100%';
      document.getElementById('upProgressClose').disabled = false;
      if (upMode === 'update' && !st.error) toast('Update abgeschlossen. Server ggf. neu starten.');

      // Wizard Stufe 2: Ergebnis zeigen statt nur "fertig" melden.
      // Wo liegt das Backup? Kam der Server hoch? Das sind die zwei Fragen,
      // die nach einem Update wirklich zaehlen.
      if (upMode === 'update' && st.result) renderUpdateResult(st.result, st);
      if (upMode === 'install' && !st.error) {
        toast('Server angelegt.');
        // KEIN automatischer Reload, wenn ein Admin-Schluessel angezeigt wird -
        // der ist nur einmal sichtbar und darf nicht mit der Seite verschwinden.
        if (!upAdminKeyShown) setTimeout(() => location.reload(), 1200);
      }
    }

    // Zeigt nach dem Update, was tatsaechlich passiert ist. Grundlage ist
    // st.result aus runUpdate() (2026-10-18 ergaenzt) - vorher kam das
    // Ergebnis nie beim Panel an, die Meldung war nur "fertig".
    function renderUpdateResult(result, st) {
      const box = document.getElementById('upResult');
      const txt = document.getElementById('upResultText');
      if (!box || !txt) return;
      const rows = [];
      if (result.backup) {
        rows.push(`<div class="meta">Backup: <code class="pathhint">${esc(result.backup)}</code></div>`);
        if (Array.isArray(result.backupIncluded) && result.backupIncluded.length) {
          rows.push(`<div class="meta">Enthalten: ${esc(result.backupIncluded.join(', '))}</div>`);
        }
      } else {
        rows.push('<div class="meta">Backup: <b>keines erstellt</b> (keine der Pfade vorhanden).</div>');
      }
      if (result.pack) {
        const rep = Array.isArray(result.pack.replaced) ? result.pack.replaced.length : null;
        const skip = Array.isArray(result.pack.skipped) ? result.pack.skipped.length : null;
        if (rep !== null) {
          rows.push(`<div class="meta">Ersetzt: <b>${esc(String(rep))}</b> Eintraege`
            + (skip !== null ? `, behalten/geschuetzt: <b>${esc(String(skip))}</b>` : '')
            + '</div>');
        }
      }
      if (result.started === false) {
        rows.push('<div class="meta" style="color:var(--red);">Server wurde NICHT gestartet - bitte Log pruefen.</div>');
      } else if (result.doneSeen === false) {
        rows.push('<div class="meta" style="color:var(--yellow);">Server gestartet, aber kein "Done (" innerhalb von 3 Min. - Log pruefen.</div>');
      } else if (result.started) {
        rows.push('<div class="meta" style="color:var(--green);">Server laeuft ("Done (" gesehen).</div>');
      }
      if (st.error) {
        rows.push(`<div class="meta" style="color:var(--red);">Fehler: ${esc(st.error)}</div>`);
      }
      txt.innerHTML = rows.join('');
      box.style.display = 'block';
    }

    // --- Dialoge öffnen -----------------------------------------------------
    function openUpdateModal(sword, stateInfo = {}) {
      if (!can('sword.update')) return;
      stopPolling();
      upMode = 'update';
      upSword = sword;
      cfState = { mod: null, file: null };

      // Tab-Auswahl an das Rack des Swords binden (2026-10-18). Vorher wurde
      // hier nie applyRackTabs() gerufen - deshalb zeigte der Update-Dialog
      // bei TeamSpeak auch Steam und CurseForge, obwohl beides dort nicht
      // funktionieren kann. Das Sword kennt sein Rack (sword.rack).
      const swordRack = racksCache.find((r) => r.id === sword.rack) ?? null;
      selectedRack = null;            // Rack-Picker gehoert nur zum Neu-Anlegen
      applyRackTabs(swordRack);
      document.getElementById('upTitle').textContent = 'Sword aktualisieren';
      document.getElementById('upStart').textContent = 'Update starten';
      document.getElementById('upRackFields').style.display = 'none';
      document.getElementById('upForm').style.display = 'block';
      document.getElementById('upProgress').style.display = 'none';
      document.getElementById('upProgressClose').disabled = true;
      document.getElementById('upPreflight').style.display = 'none';
      const resBox = document.getElementById('upResult');
      if (resBox) { resBox.style.display = 'none'; document.getElementById('upResultText').innerHTML = ''; }
      document.getElementById('cfQuery').value = '';
      document.getElementById('zipPath').value = '';
      resetUpload();
      document.getElementById('cfResults').innerHTML =
        '<div class="item"><span class="meta">Noch keine Suche.</span></div>';
      document.getElementById('cfFiles').innerHTML =
        '<div class="item"><span class="meta">Erst ein Modpack auswählen.</span></div>';
      const warn = document.getElementById('upRunningWarn');
      if (stateInfo.running) {
        warn.style.display = 'block';
        warn.textContent = '⚠ Achtung: ' + sword.name +
          ' läuft gerade (' + (stateInfo.stateText || 'aktiv') +
          (stateInfo.since ? ', ' + stateInfo.since : '') +
          '). Das Update stoppt den Server, sichert ihn und startet ihn danach wieder.';
      } else {
        warn.style.display = 'none';
        warn.textContent = '';
      }
      upTab('cf');
      renderPreflight(sword, stateInfo);
      document.getElementById('updateModal').classList.add('open');
    }

    // --- Wizard Stufe 2: "Was passiert gleich?" -------------------------------
    // Zeigt VOR dem Start die Reihenfolge der Schritte, wo das Backup landet und
    // was NICHT ueberschrieben wird. Quelle: runUpdate() in app/updater.js -
    // die Schritte hier sind bewusst dieselben, keine erfundene Liste.
    function renderPreflight(sword, stateInfo = {}) {
      const box = document.getElementById('upPreflight');
      const txt = document.getElementById('upPreflightText');
      if (!box || !txt) return;
      const keep = Array.isArray(sword.update?.keep) && sword.update.keep.length
        ? sword.update.keep
        : null;
      const gen = sword.update?.keepGenerations ?? 2;
      const steps = [
        'Server stoppen und warten, bis er wirklich aus ist',
        'Backup nach <code class="pathhint">backups/</code> (nur bei gestopptem Server - sonst kein konsistenter Schnitt)',
        'ZIP entpacken und Inhalte ersetzen',
        'Neoforge-Version pruefen, ggf. <code class="pathhint">libraries/</code> neu aufbauen',
        'Server starten und auf <code>Done (</code> warten (max. 3 Min.)',
      ];
      const keepLine = keep
        ? `Behalten: <code class="pathhint">${esc(keep.join('</code>, <code class="pathhint">'))}</code>`
        : 'Es wird <b>alles</b> aus dem Pack uebernommen (keine Ausnahmen konfiguriert).';
      const running = stateInfo.running
        ? `<div class="meta" style="margin-top:8px;">Server laeuft gerade - er wird fuer das Update gestoppt und danach wieder gestartet.</div>`
        : `<div class="meta" style="margin-top:8px;">Server ist aktuell gestoppt.</div>`;
      txt.innerHTML =
        `<div style="font-weight:600;margin-bottom:6px;">Ablauf beim Start</div>`
        + `<ol style="margin:0 0 8px 18px;padding:0;font-size:13px;">`
        + steps.map((s) => `<li>${s}</li>`).join('')
        + `</ol>`
        + `<div class="meta">${keepLine}</div>`
        + `<div class="meta" style="margin-top:4px;">Backup-Generationen behalten: <b>${esc(String(gen))}</b> - aeltere werden danach geloescht.</div>`
        + (sword.installedVersion
          ? `<div class="meta" style="margin-top:4px;">Aktuell installiert: <b>v${esc(sword.installedVersion)}</b></div>`
          : '')
        + running;
      box.style.display = 'block';
    }

    // --- Sword entfernen + EULA nachtragen (nur Admin) ---------------------
    let removeSwordRef = null;

    // --- Version nachtragen (moderator) -------------------------------------
    let versionSwordRef = null;

    function openVersionModal(sword) {
      if (!can('sword.config.write')) return;
      versionSwordRef = sword;
      document.getElementById('versionSwordInfo').textContent =
        'Aktuell: v' + (sword.installedVersion ?? '—') + ' (' + (sword.installedVersionSource ?? 'unbekannt') + ')';
      const inp = document.getElementById('versionInput');
      inp.value = sword.installedVersion ?? '';
      // Soll-Version vorbelegen (leer = keine eingetragen).
      const tgt = document.getElementById('targetInput');
      if (tgt) tgt.value = sword.update?.availableVersion ?? '';
      // CurseForge-Pack-Nummer vorbelegen (2026-10-19). Leer = nicht gesetzt.
      const pidEl = document.getElementById('projectIdInput');
      if (pidEl) pidEl.value = sword.update?.projectId ?? '';
      document.getElementById('versionConfirm').disabled = !inp.value.trim();
      document.getElementById('versionModal').classList.add('open');
      inp.focus();
    }

    document.getElementById('versionInput').addEventListener('input', (e) => {
      document.getElementById('versionConfirm').disabled = !e.target.value.trim();
    });

    document.getElementById('versionCancel').addEventListener('click', () => {
      document.getElementById('versionModal').classList.remove('open');
      versionSwordRef = null;
    });

    document.getElementById('versionConfirm').addEventListener('click', async () => {
      if (!versionSwordRef) return;
      const btn = document.getElementById('versionConfirm');
      const version = document.getElementById('versionInput').value.trim();
      if (!version) return;
      btn.disabled = true;
      const { status, data } = await api(`/api/swords/${encodeURIComponent(versionSwordRef.id)}/version`, {
        method: 'PUT', body: JSON.stringify({ version }),
      });
      btn.disabled = false;
      if (status !== 200) return toast('Fehler: ' + (data.error ?? status));

      // Soll-Version separat (eigene Route) - nur senden, wenn sie sich aendert.
      const targetEl = document.getElementById('targetInput');
      const target = targetEl ? targetEl.value.trim() : '';
      const before = versionSwordRef.update?.availableVersion ?? '';
      let targetNote = '';
      if (targetEl && target !== before) {
        const r2 = await api(`/api/swords/${encodeURIComponent(versionSwordRef.id)}/target-version`, {
          method: 'POST', body: JSON.stringify({ version: target }),
        });
        if (r2.status !== 200) {
          toast('Version gespeichert, Soll-Version aber NICHT: ' + (r2.data.error ?? r2.status));
          scheduleSwordsRefresh(200);
          return;
        }
        targetNote = target ? ` · Soll: ${target}` : ' · Soll-Version gelöscht';
      }

      // CurseForge-Pack-Nummer separat (eigene Route) - nur bei Änderung senden.
      const pidEl = document.getElementById('projectIdInput');
      const pid = pidEl ? pidEl.value.trim() : '';
      const pidBefore = String(versionSwordRef.update?.projectId ?? '');
      let pidNote = '';
      if (pidEl && pid !== pidBefore) {
        const r3 = await api(`/api/swords/${encodeURIComponent(versionSwordRef.id)}/project-id`, {
          method: 'POST', body: JSON.stringify({ projectId: pid }),
        });
        if (r3.status !== 200) {
          toast('Version gespeichert, Pack-Nummer aber NICHT: ' + (r3.data.error ?? r3.status));
          scheduleSwordsRefresh(200);
          return;
        }
        pidNote = pid ? ` · Pack-Nr.: ${pid}` : ' · Pack-Nummer gelöscht';
        // Nummer gesetzt: sofort gegentesten, damit man den Effekt sieht.
        if (pid) {
          const chk = await api(`/api/swords/${encodeURIComponent(versionSwordRef.id)}/version-check`, { method: 'POST' });
          const st = chk.data?.state;
          const why = chk.data?.reason;
          if (st === 'unknown' && why) pidNote += ` (Prüfung: ${why})`;
        }
      }

      toast('Version gespeichert: ' + version + targetNote + pidNote);
      document.getElementById('versionModal').classList.remove('open');
      versionSwordRef = null;
      scheduleSwordsRefresh(200);
    });

    function openRemoveModal(sword) {
      if (!can('sword.delete')) return;
      removeSwordRef = sword;
      const chk = document.getElementById('removeFiles');
      chk.checked = false; // sicherer Default: Ordner/Welt behalten (deleteFiles=false)
      document.getElementById('removeWarn').innerHTML =
        'Achtung: <strong>' + esc(sword.name) + '</strong> wird aus der Verwaltung entfernt.';
      document.getElementById('removeModal').classList.add('open');
    }

    document.getElementById('removeCancel').addEventListener('click', () => {
      document.getElementById('removeModal').classList.remove('open');
      removeSwordRef = null;
    });

    document.getElementById('removeFiles').addEventListener('change', (e) => {
      document.getElementById('removeWarn').innerHTML = e.target.checked
        ? 'Achtung: <strong>' + esc(removeSwordRef?.name ?? 'Sword') + '</strong> wird aus der Verwaltung entfernt. '
          + 'Der Server wird vorher gestoppt und der Server-Ordner inklusive Welt '
          + '<strong>unwiderruflich gelöscht</strong>.'
        : 'Achtung: <strong>' + esc(removeSwordRef?.name ?? 'Sword') + '</strong> wird aus der Verwaltung entfernt.';
    });

    document.getElementById('removeConfirm').addEventListener('click', async () => {
      if (!removeSwordRef) return;
      const sword = removeSwordRef;
      const deleteFiles = document.getElementById('removeFiles').checked;
      const btn = document.getElementById('removeConfirm');
      btn.disabled = true;
      const { status, data } = await api(`/api/swords/${encodeURIComponent(sword.id)}`, {
        method: 'DELETE', body: JSON.stringify({ deleteFiles }),
      });
      btn.disabled = false;
      if (status !== 200) return toast('Fehler: ' + (data.error ?? status));
      toast(deleteFiles ? 'Server entfernt.' : 'Server entfernt, Ordner behalten.');
      document.getElementById('removeModal').classList.remove('open');
      removeSwordRef = null;
      await reloadSwords();
    });

    function openEulaModal(sword) {
      if (!can('sword.eula')) return;
      removeSwordRef = sword; // hier als generischer Sword-Verweis genutzt
      const chk = document.getElementById('eulaAccept');
      chk.checked = false; // bewusst nicht vorausgewaehlt
      document.getElementById('eulaConfirm').disabled = true;
      document.getElementById('eulaSwordInfo').textContent =
        'Für ' + sword.name + ' wird eula=true in der eula.txt des Server-Ordners gesetzt.';
      document.getElementById('eulaModal').classList.add('open');
    }

    document.getElementById('eulaAccept').addEventListener('change', (e) => {
      document.getElementById('eulaConfirm').disabled = !e.target.checked;
    });

    document.getElementById('eulaCancel').addEventListener('click', () => {
      document.getElementById('eulaModal').classList.remove('open');
      removeSwordRef = null;
    });

    document.getElementById('eulaConfirm').addEventListener('click', async () => {
      if (!removeSwordRef) return;
      const btn = document.getElementById('eulaConfirm');
      btn.disabled = true;
      const { status, data } = await api(`/api/swords/${encodeURIComponent(removeSwordRef.id)}/eula`, {
        method: 'POST', body: JSON.stringify({ acceptEula: true }),
      });
      if (status !== 200) { btn.disabled = false; return toast('Fehler: ' + (data.error ?? status)); }
      toast('EULA akzeptiert.');
      document.getElementById('eulaModal').classList.remove('open');
      removeSwordRef = null;
      await reloadSwords();
    });

    async function reloadSwords() {
      const { data: swords } = await api('/api/swords');
      allSwords = Array.isArray(swords) ? swords : [];
      if (document.getElementById('rackList')) renderSidebar();
      applyRackFilter();
    }

    function openNewSwordModal() {
      if (!can('sword.create')) return;
      stopPolling();
      upMode = 'install';
      upSword = null;
      cfState = { mod: null, file: null };
      document.getElementById('upTitle').textContent = 'Neuer Server';
      document.getElementById('upStart').textContent = 'Installation starten';
      document.getElementById('upRackFields').style.display = 'block';
      const picker = document.getElementById('rackPicker');
      if (picker) picker.style.display = 'block';
      selectedRack = null;
      applyRackTabs(null);   // alle Tabs sichtbar, bis ein Rack gewaehlt ist
      // Sidebar-Kontext: wenn ein Rack aktiv ist, nur dieses anbieten und vorwaehlen.
      const preset = activeRack();
      loadRackPicker(preset ? preset.id : null).then(() => {
        if (preset) selectRack(preset.id);
      });
      document.getElementById('upRunningWarn').style.display = 'none';
      document.getElementById('upForm').style.display = 'block';
      document.getElementById('upProgress').style.display = 'none';
      document.getElementById('upProgressClose').disabled = true;
      document.getElementById('nrId').value = '';
      document.getElementById('nrName').value = '';
      document.getElementById('nrPort').value = '';
      const rootResetEl = document.getElementById('nrRoot');
      if (rootResetEl) rootResetEl.value = '';
      const eulaBox = document.getElementById('nrEula');
      if (eulaBox) eulaBox.checked = false; // bewusst nicht vorausgewaehlt
      document.getElementById('cfQuery').value = '';
      document.getElementById('zipPath').value = '';
      resetUpload();
      document.getElementById('cfResults').innerHTML =
        '<div class="item"><span class="meta">Noch keine Suche.</span></div>';
      document.getElementById('cfFiles').innerHTML =
        '<div class="item"><span class="meta">Erst ein Modpack auswählen.</span></div>';
      upTab('cf');
      document.getElementById('updateModal').classList.add('open');
    }

    function closeUpdateModal() {
      stopPolling();
      document.getElementById('updateModal').classList.remove('open');
    }

    async function startAction() {
      const tab = document.querySelector('#upTabs button.active')?.dataset.tab ?? 'cf';

      // Upload-Tab: erst die Datei senden, dann mit der neuen uploadId weitermachen.
      if (tab === 'upload' && (!upUpload || !upUpload.uploadId)) {
        if (!upUpload || !upUpload.file) { toast('Bitte zuerst eine ZIP-Datei auswählen.'); return; }
        const btn0 = document.getElementById('upStart');
        const wrap = document.getElementById('upUploadWrap');
        const msg = document.getElementById('upUploadMsg');
        const bar = document.getElementById('upUploadBar');
        btn0.disabled = true;
        wrap.style.display = 'block';
        msg.style.display = 'block';
        msg.textContent = 'Upload läuft… 0%';
        bar.style.width = '0%';
        try {
          const res = await uploadZip((pct) => {
            bar.style.width = pct + '%';
            msg.textContent = 'Upload läuft… ' + pct + '%';
          });
          upUpload.uploadId = res.id;
          bar.style.width = '100%';
          msg.textContent = 'Upload abgeschlossen.';
        } catch (err) {
          toast(err.message);
          bar.style.width = '0%';
          msg.style.display = 'none';
          btn0.disabled = false;
          return;
        }
        btn0.disabled = false;
      }

      let source;
      try { source = buildSource(tab); }
      catch (err) { toast(err.message); return; }

      const btn = document.getElementById('upStart');
      btn.disabled = true;
      try {
        if (upMode === 'update') {
          const { status, data } = await api(`/api/swords/${upSword.id}/update`, {
            method: 'POST', body: JSON.stringify(source),
          });
          if (status !== 202) return toast('Fehler: ' + (data.error ?? status));
          showProgress('Update läuft: ' + upSword.name);
          startPolling(`/api/swords/${upSword.id}/update-status`);
        } else {
          const id = document.getElementById('nrId').value.trim();
          const name = document.getElementById('nrName').value.trim();
          const port = Number(document.getElementById('nrPort').value);
          if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(id)) return toast('Ungültige id (Slug).');
          if (!name) return toast('Bitte einen Anzeigenamen angeben.');
          if (!Number.isInteger(port) || port < 1024 || port > 65535) return toast('Port muss 1024-65535 sein.');
          const eulaEl = document.getElementById('nrEula');
          const acceptEula = eulaEl ? eulaEl.checked === true : false;
          const rootEl2 = document.getElementById('nrRoot');
          const root = rootEl2 ? rootEl2.value.trim() : '';
          if (!selectedRack) return toast('Bitte zuerst ein Rack auswählen.');
          const { status, data } = await api('/api/installs', {
            method: 'POST', body: JSON.stringify({ id, name, port, root, source, acceptEula, rackId: selectedRack.id }),
          });
          if (status !== 202) return toast('Fehler: ' + (data.error ?? status));
          showProgress('Installation läuft: ' + name);
          startPolling(`/api/installs/${encodeURIComponent(id)}/status`);
        }
      } finally {
        btn.disabled = false;
      }
    }

    document.querySelectorAll('#upTabs button').forEach((b) => {
      b.addEventListener('click', () => upTab(b.dataset.tab));
    });
    document.getElementById('cfSearchBtn').addEventListener('click', searchCurseForge);
    document.getElementById('cfQuery').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); searchCurseForge(); }
    });
    document.getElementById('upCancel').addEventListener('click', closeUpdateModal);
    document.getElementById('upProgressClose').addEventListener('click', closeUpdateModal);
    document.getElementById('upAdminKeyCopy').addEventListener('click', copyAdminKey);
    document.getElementById('upStart').addEventListener('click', startAction);

    // Upload-Tab: Datei-Eingabe + Drag&Drop
    {
      const dz = document.getElementById('upDrop');
      const input = document.getElementById('upFile');
      dz.addEventListener('click', () => input.click());
      input.addEventListener('change', () => setUploadFile(input.files && input.files[0]));
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('over'));
      dz.addEventListener('drop', (e) => {
        e.preventDefault();
        dz.classList.remove('over');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) setUploadFile(f);
      });
      document.getElementById('upFileClear').addEventListener('click', (e) => {
        e.stopPropagation();
        resetUpload();
      });
    }
    window.addEventListener('beforeunload', stopPolling);

    // Sidebar-State - MUSS vor dem Init-Block stehen (sonst TDZ-Fehler,
    // weil der Init-Block allSwords/activeRackId schon beim Laden liest).
    let allSwords = [];        // alle geladenen Swords
    let activeRackId = null;   // null = 'Alle Server'
    let sidebarSelection = null; // null = alle Racks; sonst Array von Rack-IDs
    let rackEditMode = 'create';   // 'create' | 'edit' - Rack-Editor (Zustand)
    let rackEditOriginalId = null; // id des Racks, das gerade bearbeitet wird

    // Gruppierung der Sidebar. MUSS vor dem Init-Block stehen (renderSidebar
    // liest sie beim ersten Laden -> sonst TDZ-ReferenceError).
    // Gruppierung nach Spiel (Minecraft, 7 Days to Die, ...).
    const GAME_LABELS = {
      minecraft: 'Minecraft',
      '7d2d': '7 Days to Die',
      teamspeak: 'TeamSpeak',
    };
    const GAME_ORDER = ['minecraft', '7d2d', 'teamspeak6', 'teamspeak3'];

    (async () => {
      const meRes = await api('/api/auth/me');
      if (meRes.status !== 200) { location.href = '/login'; return; }
      me = meRes.data.user;
      document.getElementById('who').innerHTML =
        `${me.username}<span class="rolechip">${RANGEN[me.role]}</span>`;
      if (can('sword.create')) {
        document.getElementById('newRackBtn').style.display = 'inline-block';
      }
      if (can('rack.reload')) {
        document.getElementById('reloadSwordsBtn').style.display = 'inline-block';
      }
      // Profil-Modal mit den aktuellen Daten befuellen; Admin-Tabs freischalten.
      initProfile();
      loadTheme();     // Darstellung aus dem Konto nachziehen (Server ist die Wahrheit)
      loadVersion();

      // Swords zuerst laden - loadSidebar() leitet daraus die Startauswahl ab
      // (Racks mit Servern) und braucht allSwords deshalb schon gefuellt.
      const { data: swords } = await api('/api/swords');
      allSwords = Array.isArray(swords) ? swords : [];
      await loadSidebar();
      applyRackFilter();
      renderSidebar();
    })();

    document.getElementById('logoutBtn').addEventListener('click', async () => {
      closeWhoMenu();
      await api('/api/auth/logout', { method: 'POST' });
      location.href = '/login';
    });

    // --- Rack-Auswahl (Setup) --------------------------------------------------
    // Laedt die Rack-Schablonen und laesst den Nutzer EINES waehlen. Die Wahl
    // bestimmt die verfuegbare Install-Quelle (CurseForge/ZIP/Upload/Steam) und
    // den vorbelegten Ziel-Pfad.
    // restrictTo: optional nur dieses Rack anzeigen (Sidebar-Kontext).
    async function loadRackPicker(restrictTo = null) {
      const box = document.getElementById('rackResults');
      if (!box) return;
      box.innerHTML = '<div class="item"><span class="meta">Racks werden geladen…</span></div>';
      try {
        const { status, data } = await api('/api/racks');
        if (status !== 200) throw new Error('HTTP ' + status);
        racksCache = Array.isArray(data) ? data : [];
      } catch (err) {
        box.innerHTML = '<div class="item"><span class="meta">Racks konnten nicht geladen werden: ' + esc(err.message) + '</span></div>';
        return;
      }
      const list = restrictTo ? racksCache.filter((r) => r.id === restrictTo) : racksCache;
      if (list.length === 0) {
        box.innerHTML = '<div class="item"><span class="meta">Keine Racks vorhanden.</span></div>';
        return;
      }
      box.innerHTML = list.map((r) => `
        <div class="item rack-item" data-id="${esc(r.id)}" style="cursor:pointer;">
          <div class="grow">
            <div>${esc(r.name)} <span class="badge">${esc(r.game)}</span>
              ${r.locked ? '<span class="badge premium">gesperrt</span>' : ''}
              ${r.singleton && countRackInstances(r.id) > 0 ? '<span class="badge">bereits installiert</span>' : ''}</div>
            <div class="meta">${esc(r.description ?? '')} · ${esc(r.installMethod)} · ${esc(r.defaultRoot ?? '')}</div>
          </div>
        </div>`).join('');
      box.querySelectorAll('.rack-item').forEach((el) => {
        el.addEventListener('click', () => selectRack(el.dataset.id));
      });
    }

    // Install-Methode eines Racks -> zugehoeriger Tab.
    // EINE Quelle: ein Rack kann nur seinen eigenen Weg installieren.
    const METHOD_TO_TAB = {
      curseforge: 'cf', steamcmd: 'steam', zip: 'zip', upload: 'upload', github: 'zip',
    };

    // Tab-Leiste an das gewaehlte Rack anpassen: nur der erlaubte Tab ist
    // sichtbar/aktiv. Ohne Rack-Wahl sind alle sichtbar (noch keine Bindung).
    // Tab-Leiste an das Rack anpassen (2026-10-18 neu gedacht).
    // Vorher: nur der zum installMethod passende Tab war sichtbar. Beim
    // Update-Dialog wurde die Funktion aber nie mit einem Rack aufgerufen -
    // dadurch sah man bei TeamSpeak auch Steam und CurseForge, obwohl beides
    // dort nicht funktionieren kann.
    // Jetzt: der passende Tab zuerst, ZIP/Archiv IMMER zusätzlich (Vorgabe:
    // "zip würde ich für jede option möglich machen"). Passt der Rack-Typ
    // selbst aufs Archiv (installMethod url/zip/upload), bleibt nur ein Tab.
    const ARCHIVE_TAB = 'upload';
    function tabsForRack(rack) {
      if (!rack) return ['cf', 'zip', 'upload', 'steam'];
      const primary = METHOD_TO_TAB[rack.installMethod] ?? null;
      if (!primary) return ['cf', 'zip', 'upload', 'steam'];
      if (primary === ARCHIVE_TAB) return [ARCHIVE_TAB];
      return [primary, ARCHIVE_TAB];
    }

    function applyRackTabs(rack) {
      const allowed = tabsForRack(rack);
      const tabsEl = document.getElementById('upTabs');
      document.querySelectorAll('#upTabs button').forEach((b) => {
        const ok = allowed.includes(b.dataset.tab);
        b.style.display = ok ? '' : 'none';
        b.disabled = !ok;
        // Reihenfolge: der passende Tab steht vorn.
        b.style.order = String(allowed.indexOf(b.dataset.tab));
      });
      // Eine Leiste mit einem einzigen Knopf ist Ballast - dann ganz ausblenden.
      if (tabsEl) tabsEl.style.display = allowed.length <= 1 ? 'none' : '';
    }

    // Wie viele Swords laufen von diesem Rack? Fuer Einmal-Racks (singleton)
    // entscheidet das ueber die Sperre. allSwords ist beim Klick bereits geladen.
    function countRackInstances(rackId) {
      return allSwords.filter((sw) => sw.rack === rackId).length;
    }

    function selectRack(id) {
      const rack = racksCache.find((r) => r.id === id);
      if (!rack) return;
      if (rack.locked) { toast('Dieses Rack ist gesperrt (Premium).'); return; }
      // Einmal-Racks (singleton): nur EINE Instanz. Der Server lehnt einen
      // zweiten Install ohnehin ab (409) - hier wird es vorab verstaendlich.
      if (rack.singleton && countRackInstances(rack.id) > 0) {
        toast('Dieses Rack ist ein Einmal-Rack und bereits installiert. '
          + 'Weitere Server werden intern angelegt (z. B. virtueller Server).');
        return;
      }
      selectedRack = rack;
      document.querySelectorAll('.rack-item').forEach((el) => {
        el.style.borderColor = el.dataset.id === id ? 'var(--accent)' : '';
      });
      applyRackTabs(rack);
      upTab(METHOD_TO_TAB[rack.installMethod] ?? 'cf');
      const rootEl = document.getElementById('nrRoot');
      if (rootEl) rootEl.value = rack.defaultRoot ?? '';
      const portEl = document.getElementById('nrPort');
      if (portEl && !portEl.value && rack.ports && rack.ports.game) portEl.value = rack.ports.game;
      const eulaWrap = document.getElementById('nrEulaWrap');
      if (eulaWrap) eulaWrap.style.display = rack.game === 'minecraft' ? 'flex' : 'none';
    }

        // --- Config-Editor ---------------------------------------------------------
    let configSword = null;

    async function openConfigModal(sword) {
      configSword = sword;
      const modal = document.getElementById('configModal');
      const body = document.getElementById('configBody');
      document.getElementById('configTitle').textContent = 'Konfiguration: ' + sword.name;
      body.innerHTML = '<div class="meta">Lade Konfiguration…</div>';
      modal.classList.add('open');
      try {
        const { status, data } = await api('/api/swords/' + encodeURIComponent(sword.id) + '/config');
        if (status !== 200) throw new Error(data.error ?? ('HTTP ' + status));
        renderConfigFields(data);
      } catch (err) {
        body.innerHTML = '<div class="warn">Konfiguration konnte nicht geladen werden: ' + esc(err.message) + '</div>';
      }
    }

    function renderConfigFields(data) {
      const body = document.getElementById('configBody');
      const groups = {};
      for (const f of data.fields) { (groups[f.group] ??= []).push(f); }
      let html = '<div class="meta">Pfad: <code class="pathhint">' + esc(data.path) + '</code></div>';
      for (const [group, fields] of Object.entries(groups)) {
        html += '<h4>' + esc(group) + '</h4><div class="cfg-grid">';
        for (const f of fields) {
          const val = f.value ?? '';
          let input;
          if (f.type === 'bool') {
            input = '<label class="cfg-bool"><input type="checkbox" data-cfg="' + esc(f.key) + '"' + (val === 'true' ? ' checked' : '') + ' /> aktiv</label>';
          } else if (f.type === 'select') {
            input = '<select data-cfg="' + esc(f.key) + '">' + f.options.map((o) =>
              '<option value="' + esc(o.value) + '"' + (String(val) === String(o.value) ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') + '</select>';
          } else if (f.type === 'number') {
            input = '<input type="number" data-cfg="' + esc(f.key) + '" value="' + esc(val) + '"'
              + (f.min !== undefined ? ' min="' + f.min + '"' : '') + (f.max !== undefined ? ' max="' + f.max + '"' : '') + ' />';
          } else if (f.type === 'password') {
            input = '<input type="password" data-cfg="' + esc(f.key) + '" value="' + esc(val) + '" autocomplete="new-password" />';
          } else {
            input = '<input type="text" data-cfg="' + esc(f.key) + '" value="' + esc(val) + '" />';
          }
          html += '<div class="cfg-row"><label>' + esc(f.label) + ' <span class="meta">' + esc(f.key) + '</span></label>' + input + '</div>';
        }
        html += '</div>';
      }
      body.innerHTML = html;
    }

    async function saveConfig() {
      if (!configSword) return;
      const sword = configSword;
      const values = {};
      document.querySelectorAll('#configBody [data-cfg]').forEach((el) => {
        const key = el.dataset.cfg;
        values[key] = el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value;
      });
      const btn = document.getElementById('configSave');
      btn.disabled = true;
      try {
        const { status, data } = await api('/api/swords/' + encodeURIComponent(sword.id) + '/config', {
          method: 'PUT', body: JSON.stringify(values),
        });
        if (status !== 200) throw new Error(data.error ?? ('HTTP ' + status));
        closeConfigModal();

        // Laeuft der Server, greifen die Werte erst nach einem Neustart
        // (kein Spiel liest seine Config im Betrieb neu). Deshalb fragen -
        // ehrlich als Neustart, nicht als "Reload".
        if (data.restartRequired) {
          const now = await confirmModal(
            'Einstellungen gespeichert.\n\nDie Werte greifen erst beim n\u00e4chsten Start. ' +
            'Der Server l\u00e4uft gerade - die Spieler werden bei einem Neustart getrennt.\n\n' +
            'Jetzt neu starten?',
            { ok: 'Jetzt neustarten', cancel: 'Sp\u00e4ter' },
          );
          if (now) {
            const r = await api(`/api/swords/${sword.id}/restart`, { method: 'POST' });
            if (r.status !== 200) toast('Fehler: ' + (r.data.error ?? r.status));
            else toast('Neustart ausgel\u00f6st.');
          } else {
            // "Spaeter": Merker setzen, damit der offene Neustart nicht
            // vergessen wird. Verschwindet bei start/stop/restart von selbst.
            const r = await api(`/api/swords/${sword.id}/pending-restart`, { method: 'POST' });
            if (r.status !== 200) toast('Fehler: ' + (r.data.error ?? r.status));
            else toast('Gespeichert. Neustart vorgemerkt - Hinweis auf der Karte.');
          }
          scheduleSwordsRefresh();
        } else {
          toast('Gespeichert (' + (data.reallyChanged ?? data.changed) + ' Felder ge\u00e4ndert). Backup: ' + (data.backupPath ? 'ja' : 'nein'));
        }
      } catch (err) {
        toast('Fehler: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    }

    function closeConfigModal() {
      document.getElementById('configModal').classList.remove('open');
      configSword = null;
    }

    const _cfgCancel = document.getElementById('configCancel');
    if (_cfgCancel) _cfgCancel.addEventListener('click', closeConfigModal);
    const _cfgSave = document.getElementById('configSave');
    if (_cfgSave) _cfgSave.addEventListener('click', saveConfig);

// --- Sidebar: Racks als Filter --------------------------------------------
// (State-Deklarationen stehen weiter oben, vor dem Init-Block.)

async function loadSidebar() {
  const box = document.getElementById('rackList');
  if (!box) return;
  try {
    const { status, data } = await api('/api/racks');
    if (status !== 200) throw new Error('HTTP ' + status);
    racksCache = Array.isArray(data) ? data : [];
    // Gespeicherte Sidebar-Auswahl mitladen.
    const sel = await api('/api/sidebar-racks');
    if (sel.status === 200) {
      if (sel.data.initialized) {
        sidebarSelection = sel.data.selected;   // null = bewusst "alle"
      } else {
        // Erststart: nur Racks mit Servern zeigen, damit leere Racks im Shop
        // anklickbar sind. Hat keiner Server, alle zeigen (leere Sidebar waere sinnlos).
        const used = racksCache.map((r) => r.id)
          .filter((id) => allSwords.some((sw) => sw.rack === id));
        if (used.length > 0 && used.length < racksCache.length) {
          await saveSidebarSelection(used);
        } else {
          sidebarSelection = null;
        }
      }
    }
  } catch (err) {
    box.innerHTML = '<div class="item"><span class="meta">Racks nicht ladbar: ' + esc(err.message) + '</span></div>';
    return;
  }
  renderSidebar();
}

// Racks nach SPIEL gruppieren (Minecraft, 7 Days to Die, ...).
function groupRacks(list) {
  const byKey = {};
  for (const r of list) {
    const key = r.game ?? 'andere';
    (byKey[key] ??= []).push(r);
  }
  // Bekannte Spiele zuerst in fester Reihenfolge, Unbekanntes danach.
  const unknown = Object.keys(byKey).filter((k) => !GAME_ORDER.includes(k)).sort();
  const order = [...GAME_ORDER, ...unknown].filter((k) => byKey[k]?.length);
  return order.map((k) => ({
    key: k, label: GAME_LABELS[k] ?? k, racks: byKey[k],
  }));
}

// Racks, die aktuell in der Sidebar sichtbar sein sollen.
// sidebarSelection === null  -> alle Racks
function visibleRacks() {
  if (sidebarSelection === null) return racksCache;
  const set = new Set(sidebarSelection);
  return racksCache.filter((r) => set.has(r.id));
}

function renderSidebar() {
  const box = document.getElementById('rackList');
  if (!box) return;
  const total = allSwords.length;
  const countFor = (rack) => allSwords.filter((s) => s.rack === rack.id).length;
  const shown = visibleRacks();

  let html = '<button class="rack-btn' + (activeRackId === null ? ' active' : '') + '" data-id="">'
    + '<span class="rack-name">Alle Server</span><span class="count">' + total + '</span></button>';
  html += '<div class="rack-sep"></div>';

  if (shown.length === 0) {
    html += '<div class="meta" style="padding:6px 4px;">Keine Racks ausgewählt.</div>';
  }

  // Nach Rack-Typ gruppieren (CurseForge, SteamCMD, ...).
  for (const group of groupRacks(shown)) {
    html += '<div class="rack-group">' + esc(group.label) + '</div>';
    for (const r of group.racks) {
      const icon = r.icon === 'minecraft' ? '🟩' : (r.game === '7d2d' ? '🧟' : '🎮');
      // Filter-Button und Entfernen-Button sind GETRENNT - ein X im Button
      // waere nur auf 20px treffbar und wuerde sonst den Filter ausloesen.
      html += '<div class="rack-row">'
        + '<button class="rack-btn' + (activeRackId === r.id ? ' active' : '') + '"'
        + ' data-id="' + esc(r.id) + '"'
        + ' title="' + esc(r.name + ' · ' + r.game + ' · ' + r.installMethod) + '">'
        + '<span>' + icon + '</span>'
        + '<span class="rack-name">' + esc(r.name) + '</span>'
        + '<span class="count">' + countFor(r) + '</span>'
        + '</button>'
        + (can('rack.sidebar.write')
            ? '<button class="rack-remove" data-remove-rack="' + esc(r.id) + '"'
              + ' title="Aus der Sidebar entfernen" aria-label="Rack entfernen">✕</button>'
            : '')
        + '</div>';
    }
  }

  // Rack-Verwaltung (anlegen/bearbeiten/loeschen) - eigenes Recht.
  if (can('rack.create')) {
    html += '<button class="rack-add" id="rackManageBtn">⚙ Racks verwalten</button>';
  }
  box.innerHTML = html;

  // Alle Klicks (Filter, Entfernen, Shop) laufen ueber den delegierten
  // document-Handler - hier wird nichts mehr einzeln gebunden.
}

// Blendet ein Rack in der Sidebar ein oder aus (persistiert die Auswahl).
// Getrennt von removeRackFromSidebar: hier ohne Seiteneffekte auf den Filter,
// weil der Aufrufer die Verwaltungsliste offen hat.
async function toggleRackSidebar(id) {
  const shown = visibleRacks().map((r) => r.id);
  const isShown = shown.includes(id);
  const next = isShown ? shown.filter((x) => x !== id) : [...shown, id];
  await saveSidebarSelection(next);
  if (!isShown && activeRackId === null) { /* nichts */ }
  if (isShown && activeRackId === id) activeRackId = null;
  renderRackManage();
  applyRackFilter();
}

// Entfernt ein Rack aus der Sidebar (persistiert die Auswahl).
async function removeRackFromSidebar(id) {
  const shown = visibleRacks().map((r) => r.id).filter((x) => x !== id);
  await saveSidebarSelection(shown);
  if (activeRackId === id) activeRackId = null;
  renderSidebar();
  applyRackFilter();
}

async function saveSidebarSelection(ids) {
  const { status, data } = await api('/api/sidebar-racks', {
    method: 'PUT', body: JSON.stringify({ selected: ids }),
  });
  if (status !== 200) return toast('Fehler: ' + (data.error ?? status));
  sidebarSelection = data.selected;
  renderSidebar();
}


// Filtert die gezeigten Swords auf das aktive Rack.
function applyRackFilter() {
  const shown = activeRackId === null ? allSwords : allSwords.filter((s) => s.rack === activeRackId);
  renderSwords(shown);
}

function activeRack() {
  return activeRackId ? racksCache.find((r) => r.id === activeRackId) ?? null : null;
}

// --- Rack-Verwaltung: anlegen / bearbeiten / loeschen -----------------------
// WICHTIG: Das ist NICHT der Sword-Install ("Neuer Server"). Hier wird die
// SCHABLONE (Rack) geschrieben, aus der spaeter Server entstehen. Die id ist
// der Dateiname und unveraendert; beim Bearbeiten deshalb gesperrt.
function openRackManage() {
  if (!can('rack.create') && !can('rack.delete')) return;
  stopPolling();
  document.getElementById('rackManageModal').classList.add('open');
  renderRackManage();
}

function closeRackManage() {
  document.getElementById('rackManageModal').classList.remove('open');
}

function renderRackManage() {
  const box = document.getElementById('rackManageList');
  if (!box) return;
  if (racksCache.length === 0) {
    box.innerHTML = '<div class="meta">Keine Racks vorhanden.</div>';
    return;
  }
  // Nach id sortiert anzeigen, damit die Liste stabil bleibt.
  const list = [...racksCache].sort((a, b) => a.id.localeCompare(b.id));
  const shownIds = new Set(visibleRacks().map((r) => r.id));
  // Sichtbarkeit in der Sidebar getrennt vom Anlegen: eigenes Recht.
  const canSidebar = can('rack.sidebar.write');
  const hiddenCount = list.filter((r) => !shownIds.has(r.id)).length;

  let html = '';
  if (canSidebar) {
    html += '<p class="hint" style="margin:0 0 10px;">'
      + 'Das Auge schaltet die Sidebar-Ansicht. Ausgeblendete Racks verschwinden '
      + 'nur aus der Ansicht \u2013 Rechte und Installationen bleiben unber\u00fchrt.'
      + (hiddenCount > 0 ? ' <b>' + hiddenCount + ' ausgeblendet.</b>' : '')
      + '</p>';
  }

  html += list.map((r) => {
    const used = allSwords.filter((s) => s.rack === r.id).length;
    const canDel = can('rack.delete');
    const canEdit = can('rack.create');
    const isShown = shownIds.has(r.id);
    const delTitle = used > 0
      ? 'Wird von ' + used + ' Server(n) benutzt - erst diese entfernen'
      : 'Rack loeschen';
    return '<div class="rack-manage-row">'
      + '<div class="rm-name"><b>' + esc(r.name) + '</b>'
      + '<span class="si-meta">' + esc(r.id) + ' \u00b7 ' + esc(r.game) + ' \u00b7 '
      + esc(r.installMethod) + ' \u00b7 ' + used + ' Server</span></div>'
      + (canSidebar
        ? '<button data-toggle-rack="' + esc(r.id) + '"'
          + ' title="' + (isShown ? 'Aus der Sidebar ausblenden' : 'In der Sidebar anzeigen') + '">'
          + (isShown ? '\ud83d\udc41 sichtbar' : 'ausgeblendet') + '</button>'
        : '')
      + (canEdit ? '<button data-edit-rack="' + esc(r.id) + '">Bearbeiten</button>' : '')
      + (canDel ? '<button class="danger" data-del-rack="' + esc(r.id) + '"'
        + (used > 0 ? ' disabled' : '') + ' title="' + esc(delTitle) + '">Loeschen</button>' : '')
      + '</div>';
  }).join('');

  box.innerHTML = html;
}

// Oeffnet den Editor. rack = null -> neues Rack, sonst bearbeiten.
function openRackEditor(rack) {
  rackEditMode = rack ? 'edit' : 'create';
  rackEditOriginalId = rack ? rack.id : null;
  const g = (id) => document.getElementById(id);
  g('reTitle').textContent = rack ? ('Rack bearbeiten: ' + rack.name) : 'Neues Rack';
  g('reId').value = rack ? rack.id : '';
  g('reId').disabled = !!rack;               // id = Dateiname, unveraendert
  g('reName').value = rack?.name ?? '';
  g('reDescription').value = rack?.description ?? '';
  g('reIcon').value = rack?.icon ?? '';
  g('reGame').value = rack?.game ?? 'minecraft';
  g('reLoader').value = rack?.loader ?? 'vanilla';
  g('reInstallMethod').value = rack?.installMethod ?? 'curseforge';
  g('reTier').value = rack?.tier ?? 'free';
  g('reDefaultRoot').value = rack?.defaultRoot ?? '/opt/';
  g('reLicenseRequired').checked = rack?.licenseRequired === true;
  g('reSingleton').checked = rack?.singleton === true;
  g('reSourceType').value = rack?.source?.type ?? 'curseforge';
  g('reProjectId').value = rack?.source?.projectId ?? '';
  g('reAppId').value = rack?.source?.appId ?? '';
  g('reBranch').value = rack?.source?.branch ?? '';
  g('reSourceUrl').value = rack?.source?.url ?? '';
  g('reConfigFile').value = rack?.configFile ?? '';
  g('reStartScript').value = rack?.startScript ?? '';
  g('reLogFile').value = rack?.logFile ?? '';
  g('reJavaRequired').value = (rack?.javaRequired ?? '') === null ? '' : (rack?.javaRequired ?? '');
  g('reEula').value = rack?.eula ?? 'none';
  g('rePorts').value = rack?.ports && Object.keys(rack.ports).length
    ? JSON.stringify(rack.ports) : '';
  const err = g('reError');
  err.style.display = 'none';
  err.textContent = '';
  document.getElementById('rackEditModal').classList.add('open');
}

function closeRackEditor() {
  document.getElementById('rackEditModal').classList.remove('open');
}

// Baut aus dem Formular den Rack-Entwurf. Leere optionale Felder werden NICHT
// mitgeschickt (der Server normalisiert Defaults). ports wird als JSON geparst.
function buildRackDraft() {
  const g = (id) => document.getElementById(id);
  const val = (id) => g(id).value.trim();
  const draft = {
    id: rackEditMode === 'edit' ? rackEditOriginalId : val('reId'),
    name: val('reName'),
    description: val('reDescription'),
    icon: val('reIcon'),
    game: g('reGame').value,
    loader: g('reLoader').value,
    tier: g('reTier').value,
    licenseRequired: g('reLicenseRequired').checked,
    installMethod: g('reInstallMethod').value,
    defaultRoot: val('reDefaultRoot'),
    source: { type: g('reSourceType').value },
    javaRequired: val('reJavaRequired') === '' ? null : Number(val('reJavaRequired')),
  };
  // source.projectId: Zahl -> Zahl, sonst String/null.
  const pid = val('reProjectId');
  if (pid === '') draft.source.projectId = null;
  else draft.source.projectId = /^\d+$/.test(pid) ? Number(pid) : pid;
  const appId = val('reAppId');
  if (appId !== '') draft.source.appId = Number(appId);
  const branch = val('reBranch');
  if (branch !== '') draft.source.branch = branch;
  const url = val('reSourceUrl');
  if (url !== '') draft.source.url = url;

  // Optionale Felder nur senden, wenn gefuellt (sonst null = weglassen).
  const opt = (id, key) => { const v = val(id); if (v !== '') draft[key] = v; };
  opt('reConfigFile', 'configFile');
  opt('reStartScript', 'startScript');
  opt('reLogFile', 'logFile');
  if (g('reSingleton').checked) draft.singleton = true;
  if (val('reEula') !== 'none') draft.eula = val('reEula');

  const portsRaw = val('rePorts');
  if (portsRaw !== '') {
    let parsed;
    try { parsed = JSON.parse(portsRaw); }
    catch (e) { throw new Error('ports ist kein gueltiges JSON: ' + e.message); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('ports muss ein JSON-Objekt sein, z.B. {"game":25565}');
    }
    draft.ports = parsed;
  }
  return draft;
}

async function saveRackEditor() {
  const err = document.getElementById('reError');
  const show = (msg) => { err.textContent = msg; err.style.display = 'block'; };
  err.style.display = 'none';
  let draft;
  try { draft = buildRackDraft(); }
  catch (e) { return show(e.message); }

  const btn = document.getElementById('reSave');
  btn.disabled = true;
  try {
    const isEdit = rackEditMode === 'edit';
    const res = await api('/api/racks' + (isEdit ? '/' + encodeURIComponent(draft.id) : ''), {
      method: isEdit ? 'PUT' : 'POST',
      body: JSON.stringify(draft),
    });
    if (res.status !== 200 && res.status !== 201) {
      return show((res.data && res.data.error) || ('Fehler HTTP ' + res.status));
    }
    if (Array.isArray(res.data.warnings) && res.data.warnings.length) {
      toast('Gespeichert. Hinweis: ' + res.data.warnings.join('; '));
    } else {
      toast(isEdit ? 'Rack gespeichert.' : 'Rack angelegt.');
    }
    // Caches neu holen (Rack-Liste in der Sidebar mitziehen).
    await refreshRacks();
    closeRackEditor();
    renderRackManage();
  } finally {
    btn.disabled = false;
  }
}

async function deleteRackFromPanel(id) {
  const ok = await confirmModal(
    'Rack "' + id + '" wirklich loeschen? Bestehende Server bleiben, verlieren '
    + 'aber ihre Schablone. Die Rack-Datei wird von der Platte entfernt.',
    { title: 'Rack loeschen', ok: 'Loeschen' },
  );
  if (!ok) return;
  const { status, data } = await api('/api/racks/' + encodeURIComponent(id), { method: 'DELETE' });
  if (status !== 200) return toast('Fehler: ' + ((data && data.error) || status));
  toast('Rack geloescht.');
  await refreshRacks();
  renderRackManage();
}

// Rack-Liste frisch vom Server holen und Sidebar/Filter nachziehen.
async function refreshRacks() {
  const { status, data } = await api('/api/racks');
  if (status === 200 && Array.isArray(data)) racksCache = data;
  renderSidebar();
  applyRackFilter();
}

const _newRackBtn = document.getElementById('newRackBtn');
    if (_newRackBtn) _newRackBtn.addEventListener('click', openNewSwordModal);


document.addEventListener('click', (ev) => {
  // Textknoten-Klicks (z.B. genau auf dem Buchstaben) auf das Element heben.
  let t = ev.target;
  if (t && t.nodeType === 3) t = t.parentElement;
  if (!t || typeof t.closest !== 'function') return;

  const hit = (sel) => !!t.closest(sel);

  // Reihenfolge: spezifischste Ziele zuerst, dann allgemeine.


  const rem = t.closest('.rack-remove');
  if (rem && rem.dataset.removeRack) {
    removeRackFromSidebar(rem.dataset.removeRack).catch(() => {});
    return;
  }

  // --- Rack-Verwaltung ---
  if (hit('#rackManageBtn')) { openRackManage(); return; }
  if (hit('#rackManageClose')) { closeRackManage(); return; }
  if (hit('#rackManageNew')) { openRackEditor(null); return; }
  const manageOverlay = document.getElementById('rackManageModal');
  if (manageOverlay && t === manageOverlay) { closeRackManage(); return; }

  const toggleRackBtn = t.closest('[data-toggle-rack]');
  if (toggleRackBtn && toggleRackBtn.dataset.toggleRack) {
    toggleRackSidebar(toggleRackBtn.dataset.toggleRack).catch(() => {});
    return;
  }

  const editRackBtn = t.closest('[data-edit-rack]');
  if (editRackBtn && editRackBtn.dataset.editRack) {
    const rack = racksCache.find((r) => r.id === editRackBtn.dataset.editRack);
    if (rack) openRackEditor(rack);
    return;
  }
  const delRackBtn = t.closest('[data-del-rack]');
  if (delRackBtn && delRackBtn.dataset.delRack && !delRackBtn.disabled) {
    deleteRackFromPanel(delRackBtn.dataset.delRack).catch(() => {});
    return;
  }

  if (hit('#reCancel')) { closeRackEditor(); return; }
  if (hit('#reSave')) { saveRackEditor().catch(() => {}); return; }
  const editOverlay = document.getElementById('rackEditModal');
  if (editOverlay && t === editOverlay) { closeRackEditor(); return; }

  const rackBtn = t.closest('.rack-btn');
  if (rackBtn && document.getElementById('rackList')?.contains(rackBtn)) {
    activeRackId = rackBtn.dataset.id || null;
    renderSidebar();
    applyRackFilter();
    return;
  }
});

// Escape schliesst Shop und Rack-Modals.
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { closeRackManage(); closeRackEditor(); }
});

    document.getElementById('reloadSwordsBtn').addEventListener('click', async () => {
      closeWhoMenu();
      const { status, data } = await api('/api/swords/reload', { method: 'POST' });
      if (status !== 200 || !data.ok) {
        return toast('Fehler: ' + (data.error ?? status));
      }
      const { data: swords } = await api('/api/swords');
      allSwords = Array.isArray(swords) ? swords : [];
      applyRackFilter();
      let msg = 'Swords neu geladen: ' + data.reloaded;
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        msg += ' (' + data.errors.length + ' Fehler)';
      }
      toast(msg);
    });

    document.getElementById('newUserForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('nu_name').value.trim();
      const password = document.getElementById('nu_pass').value;
      const email = document.getElementById('nu_email').value.trim();
      const role = document.getElementById('nu_role').value;
      const { status, data } = await api('/api/auth/users', {
        method: 'POST', body: JSON.stringify({ username, password, role, email }),
      });
      if (status !== 201) return toast('Fehler: ' + (data.error ?? status));
      toast('Nutzer angelegt.');
      document.getElementById('newUserForm').reset();
      loadUsers();
    });

    function connect() {
      const sword = document.getElementById('swordSelect').value;
      if (!sword) return;
      if (ws) { ws.close(); ws = null; }
      const box = document.getElementById('console');
      box.dataset.placeholder = '1';
      box.textContent = '[armory] verbinde …';
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/logs?sword=${sword}`);
      document.getElementById('connectBtn').classList.add('active');
      document.getElementById('disconnectBtn').disabled = false;
      ws.onmessage = (e) => pushLog(e.data);
      ws.onclose = () => {
        document.getElementById('connectBtn').classList.remove('active');
        document.getElementById('disconnectBtn').disabled = true;
        ws = null;
        pushLog('[armory] Verbindung geschlossen.');
        updateConsoleStatus();
      };
    }

    document.getElementById('connectBtn').addEventListener('click', connect);
    document.getElementById('disconnectBtn').addEventListener('click', () => {
      if (ws) { ws.close(); }
      // Menue schliessen: Trennen ist eine Aktion, keine Einstellung.
      const wrap = document.getElementById('consoleMenu');
      const btn = document.getElementById('consoleMenuBtn');
      if (wrap) wrap.classList.remove('open');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
    document.getElementById('clearBtn').addEventListener('click', () => {
      logLines = [];
      const box = document.getElementById('console');
      box.textContent = '';
      box.dataset.placeholder = '1';
      // Menue schliessen: Leeren ist eine Aktion, keine Einstellung.
      const wrap = document.getElementById('consoleMenu');
      const btn = document.getElementById('consoleMenuBtn');
      if (wrap) wrap.classList.remove('open');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
    document.getElementById('timestamps').addEventListener('change', renderConsoleAll);

    // Auto-Scroll aus, wenn man hochscrollt
    document.getElementById('console').addEventListener('scroll', (e) => {
      const box = e.target;
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
      if (!atBottom) document.getElementById('autoscroll').checked = false;
    });

    // Konsolen-Praeferenzen: Knopf klappt das Menue auf/zu. Die Schalter selbst
// bleiben unveraendert verdrahtet (change-Events weiter unten).
{
  const wrap = document.getElementById('consoleMenu');
  const btn = document.getElementById('consoleMenuBtn');
  if (wrap && btn) {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const open = !wrap.classList.contains('open');
      wrap.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // Klick auf einen Schalter soll das Menue NICHT schliessen - man will
    // meist beides umstellen. Nur ein Klick daneben schliesst.
    wrap.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('click', (ev) => ev.stopPropagation());
    });
  }
}

// Dropdown-Menues schliessen: Klick irgendwo ausserhalb oder Escape.
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu')) {
        document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
        closeProfile();
        closeUpdateModal();
        document.getElementById('removeModal').classList.remove('open');
        document.getElementById('eulaModal').classList.remove('open');
      }
    });
    // Passwort-Regeln live verdrahten (2026-10-22)
    bindPwRules('nu_pass', 'nu_pass_rules', () => document.getElementById('nu_name')?.value ?? '');
    bindPwRules('rp_new', 'rp_pass_rules', () => profileResetUser?.username ?? '');
    bindPwRules('sp_new', 'sp_pass_rules', () => me?.username ?? '');
