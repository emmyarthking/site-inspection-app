# Site Inspection Log

Mobile web app for logging daily site inspections. Works offline and installs to the home screen.

- `index.html`: the app
- `config.js`: leave empty for phone-only storage, or add Supabase URL + anon key for a shared list
- `backend.js`: storage (phone or Supabase), photo upload, file downloads
- `sw.js`, `manifest.webmanifest`, `icon-*.png`: offline support and home-screen install
- `supabase-setup.sql`: one-time database setup for shared mode

Hosted with GitHub Pages from the `main` branch root.
