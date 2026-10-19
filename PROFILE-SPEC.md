# Profil-Seite + Nutzer/Einstellungen (Spec 2026-09-24)

## Entscheidungen (verbindlich)
- Eigene PROFIL-SEITE mit Tabs: Profil / Nutzer / Einstellungen
- Nutzer-Tab: Nutzerverwaltung + Passwort ändern (eigenes Passwort + Admin-Reset fuer andere)
- Einstellungen-Tab: alle API-Keys und Login-Daten fuer Racks (heute: CurseForge; erweiterbar)
- RCON-Passwoerter: BLEIBEN KOMPLETT VERSTECKT (nur Dateien data/*-rcon.password, nie in UI/API)

## Backend-Schnittstelle (API) — das Frontend ruft GENAU DIESE Routen auf
Bestehend (nur Admin):
  GET    /api/auth/me                  -> {user:{id,username,role}}
  GET    /api/auth/users               -> {users:[{id,username,role,created_at}]}
  POST   /api/auth/users               -> {id} | Fehler
  PATCH  /api/auth/users/:id           -> {ok:true}  (role aendern)
  DELETE /api/auth/users/:id           -> {ok:true}
  GET    /api/settings                 -> {settings:{curseforge_api_key:{set,preview}}}
  POST   /api/settings                 -> {ok:true}  body {key,value}
NEU (Backend-Worker baut):
  POST   /api/auth/password            -> {ok:true}  body {currentPassword,newPassword}
                                        Selbst-Aenderung fuer JEDEN eingeloggten Nutzer.
                                        Prueft currentPassword gegen den eigenen User.
  POST   /api/auth/users/:id/password  -> {ok:true}  body {newPassword}
                                        ADMIN-RESET fuer andere Nutzer (requireRole('admin')).
Regeln:
- Passwort min. 8 Zeichen (wie createUser), bcrypt-Hash (bestehende auth.js-Funktion nutzen)
- Fehler immer als {error:"..."} mit passendem Status (400/401/403/404)
- NIEMALS Passwort-Hashes oder Klartext ausliefern

## Frontend (UI)
- Header: Buttons "Nutzer" + "Einstellungen" ENTFERNEN, stattdessen Klick auf den Namen (#who) oeffnet das Profil-Modal.
- Logout bleibt sichtbar im Header.
- Profil-Modal (#profileModal) mit Tab-Leiste:
    [Profil] [Nutzer] [Einstellungen]
  - Profil: Name, Rolle. Später erweiterbar.
  - Nutzer: bestehende Nutzerverwaltung (#usersModal-Inhalt) + Passwort-Formulare
  - Einstellungen: bestehende Settings-Sicht (#settingsModal-Inhalt)
- Tabs nur zeigen wenn erlaubt: Nutzer + Einstellungen nur fuer admin (can('admin')).
- Bestehende Modals (#usersModal, #settingsModal) koennen in den Tabs aufgehen; wenn ihr sie entfernt, muessen ALLE getElementById-Referenzen mit umziehen.

## Verifikation
- Backend: node --check, Routen-Test mit curl (401 ohne Auth; 400 bei falschem Passwort), User-Query unveraendert
- Frontend: JS-Syntax, ID-Abgleich (keine fehlenden IDs), Tag-Balance
