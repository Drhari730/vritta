# Vritta (वृत्त) — RUAS Meeting Minutes

A meeting recorder that transcribes **live** and turns meetings into clean,
RUAS-branded minutes — with an account journal, email invitations, and mobile support.

**Live at:** `drhari.co.in/vritta` (sign in with the site admin account)

## What it does

1. **Sign in** with your site admin account (the same email/password as `/admin`).
2. **New Meeting** — enter title, date, attendees (with emails), agenda; pick the
   spoken language and record. Words are transcribed live via the browser speech
   engine, and you can tap **who is speaking** so each line is labelled.
3. **Minutes** — one tap builds a Ramaiah-letterhead minutes document. Edit the
   summary, decisions and action items, then **Save**, **Email**, export to **Word**,
   or **Print / PDF**.
4. **Journal** — every saved meeting is stored **in your account** (server-side, on the
   Railway `/data` volume), searchable from any device.
5. **Email invitations** — send an invite (with a `.ics` calendar file) or the full
   minutes to attendees, straight from your own email.

## Honest by design

Nothing is fabricated. The transcript is your real speech; minutes contain only what
was said plus what you type. Email is really sent — no fake "delivery receipts."

## Architecture

- **Frontend** (this repo): `index.html`, `styles.css`, `app.js` — no build step.
- **Backend**: served by the `hari-prakash-site` Node/Express app, which provides the
  admin auth, the meeting journal (`/api/vritta/meetings`), and email
  (`/api/vritta/invite`). These three files are deployed there under `public/vritta/`.

### Enabling email (one-time)

In the Railway project, set environment variables:

- `SMTP_USER` — your Gmail address
- `SMTP_PASS` — a Google **App Password** (Account → Security → App passwords), not your
  normal password

Host defaults to Gmail; override with `SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM` if needed.

## Live transcription

Uses the browser's built-in Web Speech API (Chrome / Edge, incl. Android). Supports
English (India) and Hindi, Kannada, Tamil, Telugu, Malayalam, Marathi. Automatic
speaker identification isn't possible in-browser, so speakers are tagged with one tap.
