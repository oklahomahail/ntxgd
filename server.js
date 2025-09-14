// North Texas Giving Day Monitor Backend
// Run with: node server.js

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
// If you don't have express-rate-limit installed, either `npm i express-rate-limit` or remove the block below.
const rateLimit = require('express-rate-limit');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3001;

/* ===================== Security & middleware ===================== */
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(helmet());
app.use(cors({ origin: ALLOWED.length ? ALLOWED : '*' })); // use ALLOWED_ORIGINS in prod
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (rateLimit) {
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false
    })
  );
}

/* ===================== In-memory store ===================== */
// (Swap for a DB in production)
let organizationsData = {};

/* ===================== Helpers ===================== */
const UA_HEADERS = { 'User-Agent': 'NTXGD-Monitor/1.0 (+https://example.com)' };

function isValidOrgUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    if (u.hostname !== 'www.northtexasgivingday.org') return false;
    const parts = u.pathname.split('/').filter(Boolean);
    // Expect: /organization/<slug>
    return parts.length === 2 && parts[0] === 'organization' && parts[1].length > 0;
  } catch {
    return false;
  }
}
function urlToId(raw) {
  const u = new URL(raw);
  return u.pathname.split('/').filter(Boolean)[1].toLowerCase();
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getWithRetry(url, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await axios.get(url, { headers: UA_HEADERS, timeout: 12000 });
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (status === 429 || status >= 500) {
        await sleep(1500 * (i + 1));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

/* ===================== Parser ===================== */
function extractFundraisingData(html, orgId) {
  const $ = cheerio.load(html);
  let total = 0, donors = 0, goal = 0;

  // 1) Try targeted phrases like "raised $123"
  const candidates = [];
  $('*').each((_, el) => {
    const t = $(el).text().trim();
    if (!t) return;
    if (/raised/i.test(t) && /\$\s*[\d,]+(?:\.\d{2})?/.test(t)) candidates.push(t);
  });

  const pickDollar = (arr) => {
    const nums = arr.flatMap(t => t.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || []);
    const parsed = nums.map(n => parseFloat(n.replace(/[\$\s,]/g, ''))).filter(Number.isFinite);
    return parsed.length ? Math.max(...parsed) : 0;
  };
  total = pickDollar(candidates);

  // 2) Donors & goal from body text
  const body = $('body').text();
  const donorMatch = body.match(/(\d{1,3}(?:,\d{3})*|\d+)\s+(donor|supporter|giver)s?/i);
  if (donorMatch) donors = parseInt(donorMatch[1].replace(/,/g, ''), 10) || 0;

  const goalMatch = body.match(/goal[:\s]*\$?\s*([\d,]+)/i);
  if (goalMatch) goal = parseInt(goalMatch[1].replace(/,/g, ''), 10) || 0;

  // 3) Fallback: choose a median-ish dollar if nothing clear
  if (!total) {
    const anyDollars = body.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || [];
    const parsed = anyDollars.map(n => parseFloat(n.replace(/[\$\s,]/g, ''))).filter(Number.isFinite);
    if (parsed.length) {
      parsed.sort((a, b) => a - b);
      total = parsed[Math.floor(parsed.length / 2)];
    }
  }

  return {
    total: total || 0,
    donors: donors || 0,
    goal: goal || 0,
    lastUpdated: new Date().toISOString(),
    error: null
  };
}

/* ===================== Seed loader (+ /api/reseed) ===================== */
function loadSeeds({ replace = false } = {}) {
  const seedPath = path.join(__dirname, 'config', 'organizations.json');
  if (!fs.existsSync(seedPath)) {
    return { loaded: 0, total: Object.keys(organizationsData).length, message: 'No seed file found' };
  }
  const seeds = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  if (!Array.isArray(seeds)) {
    return { loaded: 0, total: Object.keys(organizationsData).length, message: 'Seed file must be an array' };
  }

  if (replace) organizationsData = {};

  let loaded = 0;
  for (const s of seeds) {
    if (!s?.url || !isValidOrgUrl(s.url)) continue;
    const id = urlToId(s.url);
    if (!organizationsData[id]) {
      organizationsData[id] = {
        id,
        url: s.url,
        name: s.name || id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        total: 0,
        donors: 0,
        goal: 0,
        lastUpdated: null,
        error: null
      };
      loaded++;
    }
  }
  return { loaded, total: Object.keys(organizationsData).length, message: 'Seeds loaded' };
}

// Boot-time seed load
try {
  const { loaded, total, message } = loadSeeds();
  console.log(`${message}: added ${loaded}, now tracking ${total} orgs`);
} catch (e) {
  console.error('Failed to load seeds:', e.message);
}

/* ===================== Routes ===================== */
app.get('/api/organizations', (req, res) => {
  res.json(organizationsData);
});

app.post('/api/organizations', async (req, res) => {
  const { url, name } = req.body || {};
  if (!isValidOrgUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL. Must be a North Texas Giving Day organization URL.' });
  }
  const id = urlToId(url);
  if (organizationsData[id]) return res.json(organizationsData[id]);

  try {
    const response = await getWithRetry(url, 2);
    const data = extractFundraisingData(response.data, id);
    organizationsData[id] = {
      id,
      url,
      name: name || id.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      ...data
    };
    res.status(201).json(organizationsData[id]);
  } catch (error) {
    console.error(`Error fetching data for ${url}:`, error.message);
    res.status(502).json({ error: `Failed to fetch organization data: ${error.message}` });
  }
});

app.put('/api/organizations/:id/refresh', async (req, res) => {
  const { id } = req.params;
  const org = organizationsData[id];
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  try {
    const response = await getWithRetry(org.url, 2);
    const data = extractFundraisingData(response.data, id);

    // Preserve last good data if new parse looks bogus
    organizationsData[id] = {
      ...org,
      total: (data.total || 0) > 0 ? data.total : org.total,
      donors: (data.donors || 0) > 0 ? data.donors : org.donors,
      goal: data.goal || org.goal,
      lastUpdated: new Date().toISOString(),
      error: null
    };
    res.json(organizationsData[id]);
  } catch (error) {
    console.error(`Error refreshing data for ${id}:`, error.message);
    organizationsData[id].error = `Failed to refresh: ${error.message}`;
    organizationsData[id].lastUpdated = new Date().toISOString();
    res.status(502).json(organizationsData[id]);
  }
});

// Bulk refresh with pacing
app.put('/api/organizations/refresh', async (req, res) => {
  const results = {};
  const ids = Object.keys(organizationsData);

  for (const id of ids) {
    const org = organizationsData[id];
    try {
      const response = await getWithRetry(org.url, 2);
      const data = extractFundraisingData(response.data, id);

      organizationsData[id] = {
        ...org,
        total: (data.total || 0) > 0 ? data.total : org.total,
        donors: (data.donors || 0) > 0 ? data.donors : org.donors,
        goal: data.goal || org.goal,
        lastUpdated: new Date().toISOString(),
        error: null
      };
      results[id] = 'success';
    } catch (error) {
      console.error(`Error refreshing ${id}:`, error.message);
      organizationsData[id].error = `Failed to refresh: ${error.message}`;
      organizationsData[id].lastUpdated = new Date().toISOString();
      results[id] = 'error';
    }
    await sleep(1000); // polite delay
  }

  res.json({ message: 'Bulk refresh completed', results, data: organizationsData });
});

// Delete (enabled now that you have reseed)
app.delete('/api/organizations/:id', (req, res) => {
  const { id } = req.params;
  if (!organizationsData[id]) return res.status(404).json({ error: 'Organization not found' });
  delete organizationsData[id];
  res.json({ message: `Deleted organization ${id}` });
});

// Summary
app.get('/api/summary', (req, res) => {
  const orgs = Object.values(organizationsData);
  const totalRaised = orgs.reduce((sum, org) => sum + (org.total || 0), 0);
  const totalDonors = orgs.reduce((sum, org) => sum + (org.donors || 0), 0);
  const totalGoal = orgs.reduce((sum, org) => sum + (org.goal || 0), 0);

  res.json({
    organizationCount: orgs.length,
    totalRaised,
    totalDonors,
    totalGoal,
    averageGift: totalDonors > 0 ? Math.round((totalRaised / totalDonors) * 100) / 100 : 0,
    lastUpdated: new Date().toISOString()
  });
});

// CSV export
app.get('/api/export.csv', (req, res) => {
  const rows = [['id', 'name', 'url', 'donors', 'total', 'goal', 'lastUpdated', 'error']];
  for (const o of Object.values(organizationsData)) {
    rows.push([
      o.id,
      o.name,
      o.url,
      o.donors || 0,
      o.total || 0,
      o.goal || 0,
      o.lastUpdated || '',
      o.error || ''
    ]);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ntgd-organizations.csv"');
  res.send(rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'));
});

// Reseed endpoint
app.post('/api/reseed', (req, res) => {
  const token = req.query.token || req.headers['x-reseed-token'];
  if (!process.env.RESEED_TOKEN) {
    return res.status(501).json({ error: 'RESEED_TOKEN not configured on server' });
  }
  if (token !== process.env.RESEED_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const replace = String(req.query.replace || '').toLowerCase() === 'true';
  try {
    const result = loadSeeds({ replace });
    return res.json({ replaced: replace, ...result, data: organizationsData });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* ===================== Start server ===================== */
app.listen(PORT, () => {
  console.log(`NTGD Monitor running at http://localhost:${PORT}`);
});

module.exports = app;
