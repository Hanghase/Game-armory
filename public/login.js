// Game-Armory - Login-Seite
// Ausgelagert aus login.html (2026-10-23), damit die CSP
// script-src 'self' ohne 'unsafe-inline' auskommt. Inhalt 1:1 uebernommen.

    const msgEl = document.getElementById('msg');
    const noteEl = document.getElementById('note');
    const subtitleEl = document.getElementById('subtitle');
    const submitBtn = document.getElementById('submitBtn');
    let setupMode = false;

    function setMsg(text, cls = '') { msgEl.textContent = text; msgEl.className = 'msg ' + cls; }

    async function api(path, opts) {
      const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
      let data = {};
      try { data = await r.json(); } catch {}
      return { status: r.status, data };
    }

    (async () => {
      // Schon eingeloggt?
      const me = await api('/api/auth/me');
      if (me.status === 200) { location.href = '/app'; return; }

      // Setup nötig?
      const st = await api('/api/auth/setup-status');
      if (st.data?.needsSetup) {
        setupMode = true;
        subtitleEl.textContent = 'Erster Start — Admin-Konto anlegen';
        submitBtn.textContent = 'Admin anlegen';
        noteEl.textContent = 'Es existiert noch kein Benutzer. Lege jetzt den ersten Admin an.';
        setMsg('Passwort: mindestens 8 Zeichen.', '');
      } else {
        noteEl.textContent = 'Zugang nur für eingeladene Nutzer.';
      }
    })();

    // "Passwort vergessen?" nur zeigen, wenn SMTP eingerichtet ist UND kein Setup.
    (async () => {
      const ms = await api('/api/auth/mail-status');
      if (!setupMode && ms.data?.ready) {
        document.getElementById('forgotWrap').classList.remove('hidden');
      }
    })();

    document.getElementById('forgotLink').addEventListener('click', async (e) => {
      e.preventDefault();
      const username = document.getElementById('username').value.trim();
      if (!username) return setMsg('Bitte zuerst deinen Benutzernamen eingeben.', 'err');
      // Endpunkt erwartet eine E-Mail. Nutzer melden sich mit Benutzername an,
      // daher fragen wir die Adresse hier direkt ab.
      const email = prompt('E-Mail-Adresse fuer den Reset-Link:');
      if (!email) return;
      submitBtn.disabled = true;
      setMsg('…');
      const { status, data } = await api('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      });
      submitBtn.disabled = false;
      if (status === 200) {
        setMsg(data?.message ?? 'Wenn die Adresse existiert, wurde eine E-Mail verschickt.', 'ok');
      } else {
        setMsg(data?.error ?? 'Fehler beim Anfordern des Resets.', 'err');
      }
    });

    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      if (!username || !password) return setMsg('Bitte alle Felder ausfüllen.', 'err');

      submitBtn.disabled = true;
      setMsg('…');
      const endpoint = setupMode ? '/api/auth/setup' : '/api/auth/login';
      const { status, data } = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      submitBtn.disabled = false;

      if (status === 200 || status === 201) {
        setMsg('Eingeloggt! Weiterleitung…', 'ok');
        location.href = '/app';
      } else {
        setMsg(data?.error ?? 'Fehler beim Login.', 'err');
      }
    });

// --- Darstellung hell/dunkel --------------------------------------------------
// Login und Reset kennen kein Konto, deshalb liegt die Wahl nur im Browser.
// Nach dem Login ueberschreibt der gespeicherte Wert aus users.prefs diese Wahl.
(() => {
  const KEY = 'armory-theme';
  const btn = document.getElementById('themeSwitch');
  if (!btn) return;

  const read = () => {
    try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  };

  const paint = (theme) => {
    const light = theme === 'light';
    if (light) document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    btn.setAttribute('aria-checked', light ? 'true' : 'false');
  };

  paint(read());

  btn.addEventListener('click', () => {
    const next = read() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch { /* privat -> egal */ }
    paint(next);
  });
})();
