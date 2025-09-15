// server/app.js
'use strict';

const path = require('path');
const express = require('express');
const app = express();

// --- security & middleware (safe if not installed) ---
let helmet, cors, rateLimit, axios, cheerio;
try { helmet = require('helmet'); } catch {}
try { cors = require('cors'); } catch {}
try { rateLimit = require('express-rate-limit'); } catch {}
try { axios = require('axios'); } catch {}
try { cheerio = require('cheerio'); } catch {}

// Behind Vercel’s proxy; required for correct client IP & rate-limit lib
app.set('trust proxy', 1);

// Optional hardening
if (helmet) app.use(helmet());
if (cors) app.use(cors());
app.use(express.json());

// --- config ---------------------------------------------------
const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  batchDelayMs: parseInt(process.env.BATCH_DELAY_MS || '600', 10),
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '12000', 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2', 10),
  userAgent: process.env.USER_AGENT || 'NTXGD-Monitor/2.0 (+vercel)',
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '200', 10),

  organizations: [
    { name: "Brother Bill's Helping Hand", url: "https://www.northtexasgivingday.org/organization/bbhh" },
    { name: "Casa del Lago", url: "https://www.northtexasgivingday.org/organization/casa-del-lago" },
    { name: "Dallas LIFE", url: "https://www.northtexasgivingday.org/organization/dallas-life-homeless-shelter" },
    { name: "The Kessler School", url: "https://www.northtexasgivingday.org/organization/the-kessler-school" },
    { name: "CityBridge Health Foundation", url: "https://www.northtexasgivingday.org/organization/Citybridge-Health-Foundation" },
    { name: "Dallas Area Rape Crisis Center (DARCC)", url: "https://www.northtexasgivingday.org/organization/darcc" },
    { name: "International Student Foundation (ISF)", url: "https://www.northtexasgivingday.org/organization/ISF" },
    { name: "Girlstart", url: "https://www.northtexasgivingday.org/organization/Girlstart" }
  ]
};

// --- logging helpers -----------------------------------------
const log = {
  info: (...a) => console.log('[INFO]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
};

// simple req log
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => log.info(`${req.method} ${req.originalUrl} - ${res.statusCode} (${Date.now()-t0}ms)`));
  next();
});

// --- static (serves /, /app.js, /data/ntxgd_last_year.json, etc.) ----
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  lastModified: true,
  maxAge: 0,
}));

// --- optional API rate limiting ---------------------------------------
if (rateLimit) {
  app.use('/api', rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMaxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    // allow health/ping freely
    skip: (req) => req.path === '/api/health' || req.path === '/api/ping',
    message: { error: 'Too many requests, slow down a bit.' }
  }));
}

// --- helpers ---------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const urlToId = (raw) => {
  const m = String(raw).match(/\/organization\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
};

// HTTP get with retry
async function getWithRetry(url, tries = Math.max(1, config.maxRetries)) {
  if (!axios) throw new Error('axios not available on server');
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await axios.get(url, {
        timeout: config.requestTimeoutMs,
        headers: {
          'User-Agent': config.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        validateStatus: s => s >= 200 && s < 400
      });
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(Math.min(1000 * 2 ** i, 5000));
    }
  }
  throw lastErr;
}

// crude scraper
function extractFundraisingData(html) {
  if (!cheerio) {
    return { total: 0, donors: 0, goal: 0, lastUpdated: new Date().toISOString(), error: 'scraper unavailable' };
  }
  const $ = cheerio.load(html);
  const toNum = (s) => {
    if (!s) return 0;
    const n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  let total = 0, donors = 0, goal = 0;

  // JSON-LD pass
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      if (!total && (data.amount || data.totalRaised)) total = toNum(data.amount || data.totalRaised);
      if (!donors && (data.donorCount || data.supporters)) donors = toNum(data.donorCount || data.supporters);
      if (!goal && (data.goal || data.target)) goal = toNum(data.goal || data.target);
    } catch {}
  });

  const bodyText = $('body').text().replace(/\s+/g, ' ');

  if (!total) {
    const m = bodyText.match(/\$?\s*([\d,]+(?:\.\d{2})?)\s*(?:raised|total\s*raised|amount\s*raised)/i);
    if (m) total = toNum(m[1]);
  }
  if (!donors) {
    const m = bodyText.match(/([\d,]+)\s*(?:donors?|supporters?)/i);
    if (m) donors = toNum(m[1]);
  }
  if (!goal) {
    const m = bodyText.match(/goal[:\s]*\$?\s*([\d,]+(?:\.\d{2})?)/i);
    if (m) goal = toNum(m[1]);
  }

  return {
    total: total || 0,
    donors: donors || 0,
    goal: goal || 0,
    lastUpdated: new Date().toISOString(),
    error: null
  };
}

// sanity merge (avoid wild spikes)
function saneMerge(prev, next, orgName) {
  let safeTotal = next.total;
  if (!Number.isFinite(safeTotal) || safeTotal <= 0) safeTotal = prev.total;
  if (prev.total > 0 && safeTotal > prev.total * 5) {
    log.warn(`Rejecting suspicious jump for ${orgName}: ${prev.total} -> ${safeTotal}`);
    safeTotal = prev.total;
  }
  return {
    total: safeTotal,
    donors: Number.isFinite(next.donors) && next.donors >= 0 ? next.donors : prev.donors,
    goal: Number.isFinite(next.goal) && next.goal >= 0 ? next.goal : prev.goal,
    lastUpdated: next.lastUpdated,
    error: next.error || null
  };
}

// --- in-memory data -------------------------------------------
let organizationsData = {};
for (const { name, url } of config.organizations) {
  const id = urlToId(url);
  if (id) organizationsData[id] = { id, name, url, total: 0, donors: 0, goal: 0, lastUpdated: null, error: null };
}
log.info(`Initialized ${Object.keys(organizationsData).length} organizations`);

// --- API -------------------------------------------------------
app.get('/api/health', (req, res) => {
  const orgs = Object.values(organizationsData);
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    organizations: orgs.length,
    dependencies: { axios: !!axios, cheerio: !!cheerio }
  });
});

app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/_debug', (req, res) => {
  res.json({ keys: Object.keys(organizationsData), axios: !!axios, cheerio: !!cheerio });
});

app.get('/api/organizations', (req, res) => res.json(organizationsData));

app.put('/api/organizations/:id/refresh', async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  const org = organizationsData[id];
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  if (!axios || !cheerio) {
    const updated = { ...org, error: 'scraper unavailable', lastUpdated: new Date().toISOString() };
    organizationsData[id] = updated;
    return res.status(503).json(updated);
  }

  try {
    const resp = await getWithRetry(org.url, config.maxRetries);
    const scraped = extractFundraisingData(resp.data);
    const merged = { ...org, ...saneMerge(org, scraped, org.name) };
    organizationsData[id] = merged;
    res.json(merged);
  } catch (e) {
    const updated = { ...org, error: e.message || 'refresh failed', lastUpdated: new Date().toISOString() };
    organizationsData[id] = updated;
    res.status(502).json(updated);
  }
});

app.put('/api/organizations/refresh', async (req, res) => {
  const ids = Object.keys(organizationsData);
  const results = {};
  let success = 0, errors = 0;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const org = organizationsData[id];

    if (!axios || !cheerio) {
      organizationsData[id] = { ...org, error: 'scraper unavailable', lastUpdated: new Date().toISOString() };
      results[id] = 'skipped';
      continue;
    }

    try {
      const resp = await getWithRetry(org.url, config.maxRetries);
      const scraped = extractFundraisingData(resp.data);
      organizationsData[id] = { ...org, ...saneMerge(org, scraped, org.name) };
      results[id] = 'success';
      success++;
    } catch (e) {
      organizationsData[id] = { ...org, error: e.message || 'refresh failed', lastUpdated: new Date().toISOString() };
      results[id] = 'error';
      errors++;
    }

    if (i < ids.length - 1) await sleep(config.batchDelayMs);
  }

  res.json({
    message: 'Bulk refresh completed',
    results,
    data: organizationsData,
    summary: { total: ids.length, success, errors }
  });
});

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

app.get('/api/export.csv', (req, res) => {
  const orgs = Object.values(organizationsData);
  const rows = [['Organization','Total Raised','Donors','Avg Gift','Goal','Goal %','Last Updated','Status']];
  for (const o of orgs) {
    const avgGift = o.donors ? (o.total / o.donors).toFixed(2) : '0.00';
    const goalPct = o.goal ? Math.round((o.total / o.goal) * 100) : 0;
    rows.push([
      `"${o.name}"`, o.total||0, o.donors||0, avgGift, o.goal||0, goalPct,
      `"${o.lastUpdated ? new Date(o.lastUpdated).toLocaleString() : 'Never'}"`,
      `"${o.error ? 'Error' : 'OK'}"`
    ].join(','));
  }
  const csv = rows.join('\n');
  const ts = new Date().toISOString().replace(/[:T]/g,'-').slice(0,16);
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="ntgd-export-${ts}.csv"`);
  res.send(csv);
});

// --- SPA fallback (non-API routes -> index.html) ---------------
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- export for Vercel/Node entrypoints -----------------------
module.exports = app;
