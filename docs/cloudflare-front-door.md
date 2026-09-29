# A Cloudflare front door for an Apps Script app

*Written 2026-09-29, after moving Ladle & Spoon behind Cloudflare. Notes for doing the
same for Upset Special. This repo is public: no secrets, URLs or customer data here.*

## Why Ladle & Spoon moved

**The slowness was Google, not the code.** Every Apps Script web app request goes
through Google's own front end before the script even starts. We measured it on
2026-09-29: 30 rounds, one minute apart, with requests that do no work at all.

| App | Typical wait | 1 in 10 waits longer than | Failed with Google's error page |
|---|---|---|---|
| Ladle & Spoon's real app | 2.8 s | 12 s | 9 of 30 |
| Empty test app (tonyedmonds2003) | 3.1 s | 42 s | 10 of 30 |
| Empty test app (ladlespoon00) | 1.7 s | 34 s | 4 of 30 |

Empty apps were as slow as the real one, on both accounts, and failures often hit
several apps in the same minute. So neither the code nor either account was the cause.

In practice, admin login and the dashboard took 25–40 s, and some customer orders got no
answer within 30 s, so the app sent them again. 12 order requests reached Google for 5
real orders (a repeat check caught the duplicates). Caching, retries and a static copy of
the menu on GitHub Pages had already been done inside Apps Script; the remaining delay
was all Google's.

## What the front door does

A small **Cloudflare Worker** sits in front as the app's backend address. **Apps Script
stays as the back office**: the Sheet, email, pricing and analytics are all still
decided there.

- **Reads** (menu, photos, per-customer lookups, the admin dashboard and monthly views)
  are served from copies that Apps Script pushes to the Worker after every change and
  hourly. They answer in ~0.2 s instead of 2–26 s.
- **Writes the app never reads an answer from** (orders, installs, ratings, and admin
  buttons like publish menu or save schedule) are saved in the Worker's database,
  answered at once, and forwarded to Apps Script. Failed forwards are retried every
  minute, strictly in order, and each carries an ID so a repeat is ignored.
- **Admin sign-in** is checked by the Worker (same PIN, same lockout; only hashes of
  session tokens are stored). When the Worker passes an admin request on, it proves
  itself to Apps Script with a shared secret instead of a user token.
- **Anything else** passes straight through to Apps Script unchanged, and reads are
  retried if Google answers with an error page.
- **Cost:** $0 on Cloudflare's free plan (100,000 requests a day; D1 database, 5 GB).
  The paid plan is $5/month if a limit is ever hit.
- **Rollback:** change one line in the app (the backend URL) back to Apps Script.

It was built in three phases, each live on its own:
1. customer reads and writes
2. admin sign-in and dashboards
3. admin buttons that don't need an answer

## Applying it to Upset Special

This assumes Upset Special is built the same way: a static site talking to an Apps
Script web app backed by Sheets. If so, it has the same Google delay.

1. **Measure first.** Run the latency probe (`tools/latency-probe/probe.js` in the Ladle &
   Spoon ops repo) against Upset Special's web app and an empty "ping" web app, to see
   what Google is costing it.
2. **Pass-through first.** A Worker that forwards everything and retries Google's error
   pages on reads fixes the random failures on day one, with nothing else changing.
3. **Serve the most-read data from copies** that Apps Script pushes after each change and
   hourly. This is usually where most of the speed comes from.
4. **Queue writes the screen doesn't need an answer from**, each with an ID so a retry
   can't do the work twice (Apps Script remembers the ID for 6 hours).
5. **Keep synchronous anything whose screen needs Apps Script's answer**: counts,
   "already done?" checks, email-quota checks. Before sending one, flush anything queued
   ahead of it, so order is kept.

Ladle & Spoon's Worker (`worker/` in its ops repo, ~450 lines with tests) is a working
template. It includes a parity test proving the Worker answers exactly as Apps Script
would, and one checking that the Worker's list of admin-only request types matches
Apps Script's.

## Lessons that save time

- **Sign-in:** run `npx wrangler login` in a real terminal. If the browser is signed into
  another Cloudflare account, copy the link it prints into a window signed into the
  right one, and keep the terminal open until it says "Successfully logged in".
- **New address:** a new `*.workers.dev` address takes a few minutes before it's
  reachable (TLS errors until then).
- **Size limits:** the first bulk push from Apps Script was refused as too large. Allow
  bigger bodies for the authenticated push only. D1 stores at most 2 MB per row.
- **Secrets:** Apps Script can't read request headers, so the shared secret travels
  inside the request body (or as a query parameter for GETs).
- **Script Properties:** in a project with large properties, the Project Settings page
  can fail to save. Add a spreadsheet menu item that prompts for the secret instead.
- **Order:** keep queued actions in order by insertion sequence (SQLite `rowid`), not by
  timestamp: two actions in the same millisecond can swap.
- **Version checks:** check the deployed Apps Script version directly, not through the
  Worker. Its copy only updates at the next push.
- **Rollback:** keep the old backend URL in a comment beside the new one.
- **Old copies of the app:** phones that already had the app open keep talking to the old
  backend until they reload it, so expect a short overlap after the switch.
