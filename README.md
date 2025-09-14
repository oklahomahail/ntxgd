# NTXGD Monitor

Real-time dashboard tracking 8 North Texas Giving Day organizations. Static frontend + Express API deployed on Vercel.

## Quick Start

```bash
npm ci
npm run dev
# Open http://localhost:3001
```

## Features

- Auto-refresh tracking of 8 hardcoded nonprofits
- Aggregate totals, per-org breakdown, CSV export
- Respectful scraping with retries and rate limiting
- Health monitoring and debug endpoints

## Organizations Tracked

Edit in `server/app.js` (`config.organizations`):
- Brother Bill's Helping Hand
- Casa del Lago  
- Dallas LIFE
- The Kessler School
- CityBridge Health Foundation
- Dallas Area Rape Crisis Center (DARCC)
- International Student Foundation (ISF)
- Girlstart

## API Endpoints

- `GET /api/organizations` - All org data
- `PUT /api/organizations/refresh` - Refresh all
- `PUT /api/organizations/:id/refresh` - Refresh one
- `GET /api/health` - System health
- `GET /api/export.csv` - Download data

## Configuration

Optional `.env` for tuning:
```bash
BATCH_DELAY_MS=500
REQUEST_TIMEOUT_MS=15000
MAX_RETRIES=3
LOG_LEVEL=info
```

## Deployment

Vercel auto-deploys from GitHub. Requires Node 18.x+.

Set environment variables in Vercel dashboard for production tuning.

## Tech Stack

- Frontend: Vanilla HTML/CSS/JS
- Backend: Node.js + Express
- Scraping: Axios + Cheerio
- Deploy: Vercel serverless functions
