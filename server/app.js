// server/app.js (hard-wired orgs, scraper enabled, crash-proof imports)
'use strict';

const express = require('express');

// make these safe so boot never crashes
let cors;   try { cors   = require('cors');   } catch { cors   = () => (req,res,next)=>next(); }
let helmet; try { helmet = require('helmet'); } catch { helmet = () => (req,res,next)=>next(); }
let rateLimit; try { rateLimit = require('express-rate-limit'); } catch { rateLimit = null; }
let axios;  try { axios  = require('axios');  } catch { axios  = null; }
let cheerio;try { cheerio= require('cheerio');} catch { cheerio= null; }

const path = require('path');

const HARDCODED_ORGS = [
  { name: "Brother Bill's Helping Hand", url: "https://www.northtexasgivingday.org/organization/bbhh" },
  { name: "Casa del Lago", url: "https://www.northtexasgivingday.org/organization/casa-del-lago" },
  { name: "Dallas LIFE", url: "https://www.northtexasgivingday.org/organization/dallas-life-homeless-shelter" },
  { name: "The Kessler School", url: "https://www.northtexasgivingday.org/organization/the-kessler-school" },
  { name: "CityBridge Health Foundation", url: "https://www.northtexasgivingday.org/organization/Citybridge-Health-Foundation" },
  { name: "Dallas Area Rape Crisis Center (DARCC)", url: "https://www.northtexasgivingday.org/organization/darcc" },
  { name: "International Student Foundation (ISF)", url: "https://www.northtexasgivingday.org/organization/ISF" },
  { name: "Girlstart", url: "https://www.northtexasgivingday.org/organization/Girlstart" }
];

const UA_HEADERS = { 'User-Agent': 'NTXGD-Monitor/1.0 (+vercel)' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// safer slug extractor for /organization/<slug>
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

function extractFundraisingData(html) {
  if (!cheerio) return { total: 0, donors: 0, goal: 0, lastUpdated: new Date().toISOString(), error: 'cheerio not available' };
  const $ = cheerio.load(html);
  let total = 0, donors = 0, goal = 0;

  // prefer amounts near 'raised'
  const candidates = [];
  $('*').each((_, el) => {
    const t = $(el).text().trim();
    if (t && /raised/i.test(t) && /\$\s*[\d,]+(?:\.\d{2})?/.test(t)) candidates.push(t);
  });
  const dollars = candidates.flatMap(t => t.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || [])
    .map(n => parseFloat(n.replace(/[\$\s,]/g, '')))
    .filter(Number.isFinite);
  if (dollars.length) total = Math.max(...dollars);

  const body = $('body').text();
  const donorMatch = body.match(/(\d{1,3}(?:,\d{3})*|\d+)\s+(donor|supporter|giver)s?/i);
  if (donorMatch) donors = parseInt(donorMatch[1].replace(/,/g, ''), 10) || 0;

  const goalMatch = body.match(/goal[:\s]*\$?\s*([\d,]+)/i);
  if (goalMatch) goal = parseInt(goalMatch[1].replace(/,/g, ''), 10) || 0;

  // fallback: a middle-ish value of any money found
  if (!total) {
    const any = body.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || [];
    const nums = any.map(n => parseFloat(n.replace(/[\$\s,]/g, ''))).filter(Number.isFinite);
    if (nums.length) { nums.sort((a,b)=>a-b); total = nums[Math.floor(nums.length/2)]; }
  }
  return { total: total||0, donors: donors||0, goal: goal||0, lastUpdated: new Date().toISOString(), error: null };
}

const app = express();

// basic middleware (safe no-ops if modules are missing)
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json());
// static for local dev; on vercel, /public is routed by vercel.json
app.use(express.static(path.join(__dirname, '..', 'public')));
if (rateLimit) app.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));

// seed in memory
let organizationsData = {};
for (const { name, url } of HARDCODED_ORGS) {
  const id = urlToId(url);
  if (!id) continue;
  organizationsData[id] = { id, name, url, total: 0, donors: 0, goal: 0, lastUpdated: null, error: null };
}
console.log('[BOOT] seeded orgs:', Object.keys(organizationsData));

// sanity routes
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/_debug', (req, res) => {
  const keys = Object.keys(organizationsData || {});
  res.json({ count: keys.length, keys, axios: !!axios, cheerio: !!cheerio });
});

// data routes
app.get('/api/organizations', (req, res) => res.json(organizationsData));

app.put('/api/organizations/:id/refresh', async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  const org = organizationsData[id];
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  if (!axios || !cheerio) return res.status(503).json({ ...org, error: 'Scraper unavailable', lastUpdated: new Date().toISOString() });

  try {
    const resp = await getWithRetry(org.url, 2);
    const data = extractFundraisingData(resp.data);
    organizationsData[id] = {
      ...org,
      total: (data.total||0) > 0 ? data.total : org.total,
      donors: (data.donors||0) > 0 ? data.donors : org.donors,
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
        total: (data.total||0) > 0 ? data.total : org.total,
        donors: (data.donors||0) > 0 ? data.donors : org.donors,
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
    await sleep(400);
  }
  res.json({ message: 'Bulk refresh completed', results, data: organizationsData });
});

app.get('/api/summary', (req, res) => {
  const orgs = Object.values(organizationsData);
  const totalRaised = orgs.reduce((s,o)=>s+(o.total||0),0);
  const totalDonors = orgs.reduce((s,o)=>s+(o.donors||0),0);
  const totalGoal   = orgs.reduce((s,o)=>s+(o.goal||0),0);
  res.json({
    organizationCount: orgs.length,
    totalRaised,
    totalDonors,
    totalGoal,
    averageGift: totalDonors>0 ? Math.round((totalRaised/totalDonors)*100)/100 : 0,
    lastUpdated: new Date().toISOString()
  });
});

// local dev index (vercel routes /public already)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

module.exports = app;
