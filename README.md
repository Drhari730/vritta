# Vritta (वृत्त) — Personal Meeting Notes & Minutes

A private, fully in-browser tool that records a meeting, transcribes it **live**, and
turns it into clean, professional minutes. No server, no account, no data leaving your
device — everything is stored locally in your browser.

**Live at:** `drhari.co.in/vritta`

## What it does

1. **New Meeting** — enter the title, date, attendees and agenda, pick the spoken
   language, and hit record. Your words are transcribed live and kept as you speak.
2. **Minutes** — one tap builds a clean minutes document from what was actually said.
   You edit the summary, add decisions and action items (owner + due date), then
   **Save**, **Export to Word**, **Print / PDF**, or **Copy**.
3. **Saved Meetings** — every saved meeting is stored in this browser, searchable, with
   a JSON backup/restore so you never lose anything.

## Honest by design

Nothing is invented. The transcript is your real speech; the minutes contain only what
was spoken plus what you type. There are no fabricated budgets, attendees, decisions or
"delivery receipts."

## How live transcription works

Vritta uses the browser's built-in **Web Speech API** (Chrome or Edge recommended).
It supports English and major Indian languages (Hindi, Kannada, Tamil, Telugu,
Malayalam, Marathi). The recogniser auto-restarts through the browser's periodic
time-outs so a long meeting is captured continuously. An internet connection is
required (the browser handles the speech-to-text).

## Tech

Plain HTML, CSS and JavaScript — three static files, no build step, no dependencies.

- `index.html` — layout
- `styles.css` — styling
- `app.js` — recording, transcription, minutes, storage and exports

Drop these three files behind any static host. On `drhari.co.in` they are served from
`public/vritta/` by the site's Node/Express server.
