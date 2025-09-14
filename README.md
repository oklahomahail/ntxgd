# NTXGD Monitor

A simple dashboard and API to track a fixed list of North Texas Giving Day organizations.  
Frontend is static (served from `/public`), backend is a lightweight Express app (exported from `server/app.js`) deployed as Vercel serverless functions.

---

## Features

- Hard-wired list of 8 orgs (easy to edit in one place)
- Aggregate totals and average gift
- Per-org refresh + bulk refresh
- CSV export
- Health/debug endpoints
- Respectful scraping (timeouts, retries, batch delay)

---

## Tech Stack

- **Frontend:** vanilla HTML/CSS/JS (`public/index.html`, `public/app.js`)
- **Backend:** Node.js + Express (`server/app.js`)
- **Deploy:** Vercel (serverless), static assets from `/public`

> **Node Requirement:** Vercel currently requires **Node 22.x**. This repo sets `"engines": { "node": "22.x" }`.

---

## Hard-Wired Organizations

Edit the list in **`server/app.js`** (`HARDCODED_ORGS`). Defaults:

- Brother Bill’s Helping Hand — `bbhh`
- Casa del Lago — `casa-del-lago`
- Dallas LIFE — `dallas-life-homeless-shelter`
- The Kessler School — `the-kessler-school`
- CityBridge Health Foundation — `Citybridge-Health-Foundation`
- Dallas Area Rape Crisis Center (DARCC) — `darcc`
- International Student Foundation (ISF) — `ISF`
- Girlstart — `Girlstart`

Slug is taken from `https://www.northtexasgivingday.org/organization/<slug>`.

---

## Local Development

### 1) Install

```bash
# from repo root
rm -rf node_modules
npm ci
