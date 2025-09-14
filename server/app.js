// server/app.js (hard-wired orgs, scraper enabled, crash-proof imports)
'use strict';

const express = require('express');
const path = require('path');

// Safe/optional imports (won't crash if missing in some environments)
let cors;      try { cors = require('cors'); } catch { cors = () => (req,res,next)=>next(); }
let helmet;    try { helmet = require('helmet'); } catch { helmet = () => (req,res,next)=>next(); }
let rateLimit; try { rateLimit = require('express-rate-limit'); } catch { rateLimit = null; }
let axios;     try { axios = require('axios'); } catch { axios = null; }
let cheerio;   try { cheerio = require('cheerio'); } catch { cheerio = null; }

// --------------------------- Config ---------------------------
const HARDCODED_ORGS = [
  { name: "Brother Bill's Helping Hand", url: "https://www.northtexasgivingday.org/organization/bbhh" },
  { name: "Casa del Lago",              url: "https://www.northtexasgivingday.org/organization/casa-del-lago" },
  { name: "Dallas LIFE",                url: "https://www.northtexasgivingday.org/organization/dallas-life-homeless-shelter" },
  { name: "The Kessler School",         url: "https://www.northtexasgivingday.org/organization/the-kessler-school" },
  { name: "CityBridge Health Foundation", url: "https://www.northtexasgivingday.org/organization/Citybridge-Health-Foundation" },
  { name: "Dallas Area Rape Crisis Center (DARCC)", url: "https://www.northtexasgivingday.org/organization/darcc" },
  { name: "International Student Foundation (ISF)",  url: "https://www.northtexasgivingday.org/organization/ISF" },
  { name: "Girlstart",                  url: "https://www.northtexasgivingday.org/organization/Girlstart" }
];

const UA_HEADERS = { 'User-Agent': 'NTXGD-Monitor/1.0 (+vercel)' };
const BATCH_DELAY_MS = Number(process.env.BATCH_DELAY_MS || 400);

// --------------------------- Utils ---------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// extract /organization/<slug>
function urlToId(raw) {
  const m = String(raw).match(/\/organization\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

async function getWithRetry(url, tries = 2) {
  if (!axios) throw new Error('axios not available');
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await axios.get(url, { headers: UA_HEADERS, timeout: 12000 });
    } catch (e) {
      lastErr = e;
      const s = e.response?.status;
      if (s === 429 || s >= 500) { await sleep(1500 * (i + 1)); continue; }
      break;
    }
  }
  throw lastErr;
}

// Robustly parse: "$75,600 raised", "by 18 donors", "$400,000 Goal", and "% complete"
function extractFundraisingData(html) {
  if (!cheerio) {
    return { total: 0, donors: 0, goal: 0, lastUpdated: new Date().toISOString(), error: 'cheerio not available' };
  }

  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  const toNum = (s) => {
    if (!s) return 0;
    const n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  let total = 0, donors = 0, goal = 0;

  // Raised: "$75,600 raised" OR "raised $75,600"
  const raisedBefore = text.match(/\$\s*([\d,]+(?:\.\d{2})?)\s*raised\b/i);
  const raisedAfter  = text.match(/\braised\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
  if (raisedBefore) total = toNum(raisedBefore[1]);
  else if (raisedAfter) total = toNum(raisedAfter[1]);

  // Fallback: nearest $ around the word "raised"
  if (!total) {
    const idx = text.toLowerCase().indexOf('raised');
    if (idx !== -1) {
      const window = text.slice(Math.max(0, idx - 80), idx + 80);
      const near = window.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
      if (near) total = toNum(near[1]);
    }
  }

  // Donors: "by 18 donors"
  const donorsMatch = text.match(/\bby\s+([\d,]+)\s+donors?\b/i) || text.match(/\b([\d,]+)\s+donors?\b/i);
  if (donorsMatch) donors = toNum(donorsMatch[1]);

  // Goal: "$400,000 Goal" OR "Goal $400,000"
  const goalAfter  = text.match(/\$\s*([\d,]+(?:\.\d{2})?)\s*goal\b/i);
  const goalBefore = text.match(/\bgoal\b[^$]*\$\s*([\d,]+(?:\.\d{2})?)/i);
  if (goalAfter) goal = toNum(goalAfter[1]);
  else if (goalBefore) goal = toNum(goalBefore[1]);

  // If either missing but "% complete" exists, compute from the other
  const pct = text.match(/(\d{1,3})\s*%\s*complete/i);
  if (pct) {
    const p = toNum(pct[1]);
    if (!total && goal && p > 0 && p <= 100) total = Math.round((goal * p) / 100);
    if (!goal && total && p > 0 && p <= 100) goal = Math.round((total * 100) / p);
  }

  return {
    total: total || 0,
    donors: donors || 0,
    goal: goal || 0,
    lastUpdated: new Date().toISOString(),
    error: null
  };
}

// --------------------------- App ---------------------------
const app = express();

// Security / CORS (no-op if modules missing)
app.use(helmet());
const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (origins.length) {
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || origins.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'), false);
    }
  }));
} else {
  app.use(cors()); // allow all by default
}

app.use(express.json());

// Static for local dev; on Vercel, /public is handled by vercel.json
app.use(express.static(path.join(__dirname, '..', 'public')));

// Optional rate limit
if (rateLimit) {
  app.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
}

// Seed in-memory store
let organizationsData = {};
for (const { name, url } of HARDCODED_ORGS) {
  const id = urlToId(url);
  if (!id) continue;
  organizationsData[id] = { id, name, url, total: 0, donors: 0, goal: 0, lastUpdated: null, error: null };
}
console.log('[BOOT] seeded orgs:', Object.keys(organizationsData));

// --------------------------- Routes ---------------------------
// Sanity/debug
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/_debug', (req, res) => {
  const keys = Object.keys(organizationsData || {});
  res.json({ count: keys.length, keys, axios: !!axios, cheerio: !!cheerio });
});

// Read all
app.get('/api/organizations', (req, res) => res.json(organizationsData));

// Refresh one
app.put('/api/organizations/:id/refresh', async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  const org = organizationsData[id];
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  if (!axios || !cheerio) {
    return res.status(503).json({ ...org, error: 'Scraper unavailable', lastUpdated: new Date().toISOString() });
  }

  try {
    const resp = await getWithRetry(org.url, 2);
    const data = extractFundraisingData(resp.data);
    organizationsData[id] = {
      ...org,
      total: (data.total || 0) > 0 ? data.total : org.total,
      donors: (data.donors || 0) > 0 ? data.donors : org.donors,
      goal: data.goal || org.goal,
      lastUpdated: new Date().toISOString(),
      error: null
    };
    res.json(organizationsData[id]);
  } catch (e) {
    organizationsData[id].error = `Failed to refresh: ${e.message}`;
    organizationsData[id].lastUpdated = new Date().toISOString();
    res.status(502).json(organizationsData[id]);
  }
});

// Bulk refresh
app.put('/api/organizations/refresh', async (req, res) => {
  const results = {};
  for (const id of Object.keys(organizationsData)) {
    const org = organizationsData[id];
    if (!axios || !cheerio) {
      organizationsData[id].error = 'Scraper unavailable';
      organizationsData[id].lastUpdated = new Date().toISOString();
      results[id] = 'skipped';
      continue;
    }
    try {
      const resp = await getWithRetry(org.url, 2);
      const data = extractFundraisingData(resp.data);
      organizationsData[id] = {
        ...org,
        total: (data.total || 0) > 0 ? data.total : org.total,
        donors: (data.donors || 0) > 0 ? data.donors : org.donors,
        goal: data.goal || org.goal,
        lastUpdated: new Date().toISOString(),
        error: null
      };
      results[id] = 'success';
    } catch (e) {
      organizationsData[id].error = `Failed to refresh: ${e.message}`;
      organizationsData[id].lastUpdated = new Date().toISOString();
      results[id] = 'error';
    }
    await sleep(BATCH_DELAY_MS);
  }
  res.json({ message: 'Bulk refresh completed', results, data: organizationsData });
});

// Summary
app.get('/api/summary', (req, res) => {
  const orgs = Object.values(organizationsData);
  const totalRaised = orgs.reduce((s, o) => s + (o.total || 0), 0);
  const totalDonors = orgs.reduce((s, o) => s + (o.donors || 0), 0);
  const totalGoal   = orgs.reduce((s, o) => s + (o.goal   || 0), 0);
  res.json({
    organizationCount: orgs.length,
    totalRaised,
    totalDonors,
    totalGoal,
    averageGift: totalDonors > 0 ? Math.round((totalRaised / totalDonors) * 100) / 100 : 0,
    lastUpdated: new Date().toISOString()
  });
});

// Local dev root (Vercel serves /public via routing)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

module.exports = app;
