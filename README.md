# Site Inspection Log

Mobile web app for logging daily site inspections. Installs to the home screen and works offline.

**Live:** https://emmyarthking.github.io/site-inspection-app/

## Storage
Dual storage: every inspection and photo is saved on the phone first, then synced with a shared Supabase database whenever the phone is online and signed in.

- Leave `config.js` empty to run phone-only.
- To turn on the shared copy: create a Supabase project, run `supabase-setup.sql` in its SQL Editor, paste the project URL and anon key into `config.js`, and add staff accounts under Authentication > Users (turn off public sign-ups).

## Files
- `index.html` the app
- `backend.js` phone storage + cloud sync, photos, downloads
- `sw.js`, `manifest.webmanifest`, `icon-*.png` offline support and install
