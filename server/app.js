// server/app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
let rateLimit; try { rateLimit = require('express-rate-limit'); } catch (_) {}
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const app = express();

/* -------- Security & middleware -------- */
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(helmet());
app.use(cors({ origin: ALLOWED.length ? ALLOWED : '*' }));
app.use(express.json());

// static for local dev; on Vercel, /public is routed by vercel.json
app.use(express.static(path.join(__dirname, '..', 'public')));

if (rateLimit) {
  app.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
}

/* -------- In-memory store -------- */
let organizationsData = {};

/* -------- Helpers -------- */
const UA_HEADERS = { 'User-Agent': 'NTXGD-Monitor/1.0 (+https://example.com)' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isValidOrgUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.hostname !== 'www.northtexasgivingday.org') return false;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length === 2 && parts[0] === 'organization' && parts[1].length > 0;
  } catch { return false; }
}
function urlToId(raw) {
  const u = new URL(raw);
  return u.pathname.split('/').filter(Boolean)[1].toLowerCase();
}
async function getWithRetry(url, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await axios.get(url, { headers: UA_HEADERS, timeout: 12000 }); }
    catch (e) {
      lastErr = e; const s = e.response?.status;
      if (s === 429 || s >= 500) { await sleep(1500 * (i + 1)); continue; }
      break;
    }
  } throw lastErr;
}

/* -------- Parser -------- */
function extractFundraisingData(html) {
  const $ = cheerio.load(html);
  let total = 0, donors = 0, goal = 0;

  const candidates = [];
  $('*').each((_, el) => {
    const t = $(el).text().trim();
    if (t && /raised/i.test(t) && /\$\s*[\d,]+(?:\.\d{2})?/.test(t)) candidates.push(t);
  });

  const pickDollar = (arr) => {
    const nums = arr.flatMap(t => t.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || []);
    const parsed = nums.map(n => parseFloat(n.replace(/[\$\s,]/g, ''))).filter(Number.isFinite);
    return parsed.length ? Math.max(...parsed) : 0;
  };
  total = pickDollar(candidates);

  const body = $('body').text();
  const donorMatch = body.match(/(\d{1,3}(?:,\d{3})*|\d+)\s+(donor|supporter|giver)s?/i);
  if (donorMatch) donors = parseInt(donorMatch[1].replace(/,/g, ''), 10) || 0;

  const goalMatch = body.match(/goal[:\s]*\$?\s*([\d,]+)/i);
  if (goalMatch) goal = parseInt(goalMatch[1].replace(/,/g, ''), 10) || 0;

  if (!total) {
    const any = body.match(/\$\s*[\d,]+(?:\.\d{2})?/g) || [];
    const nums = any.map(n => parseFloat(n.replace(/[\$\s,]/g, ''))).filter(Number.isFinite);
    if (nums.length) {
      nums.sort((a,b)=>a-b);
      total = nums[Math.floor(nums.length/2)];
    }
  }

  return { total: total||0, donors: donors||0, goal: goal||0, lastUpdated: new Date().toISOString(), error: null };
}

/* -------- Seeds + /api/reseed -------- */
function loadSeeds({ replace = false } = {}) {
  const seedPath = path.join(__dirname, '..', 'config', 'organizations.json');
  if (!fs.existsSync(seedPath)) return { loaded: 0, total: Object.keys(organizationsData).length, message: 'No seed file found' };
  const seeds = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  if (!Array.isArray(seeds)) return { loaded: 0, total: Object.keys(organizationsData).length, message: 'Seed file must be an array' };
  if (replace) organizationsData = {};
  let loaded = 0;
  for (const s of seeds) {
    if (!s?.url || !isValidOrgUrl(s.url)) continue;
    const id = urlToId(s.url);
    if (!organizationsData[id]) {
      organizationsData[id] = {
        id, url: s.url, name: s.name || id.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase()),
        total: 0, donors: 0, goal: 0, lastUpdated: null, error: null
      };
      loaded++;
    }
  }
  return { loaded, total: Object.keys(organizationsData).length, message: 'Seeds loaded' };
}
try {
  const { loaded, total, message } = loadSeeds();
  console.log(`${message}: added ${loaded}, now tracking ${total} orgs`);
} catch (e) { console.error('Failed to load seeds:', e.message); }

/* -------- Routes -------- */
app.get('/api/organizations', (req,res)=> res.json(organizationsData));

app.post('/api/organizations', async (req,res)=>{
  const { url, name } = req.body || {};
  if (!isValidOrgUrl(url)) return res.status(400).json({ error: 'Invalid URL. Must be a North Texas Giving Day organization URL.' });
  const id = urlToId(url);
  if (organizationsData[id]) return res.json(organizationsData[id]);
  try {
    const resp = await getWithRetry(url, 2);
    const data = extractFundraisingData(resp.data);
    organizationsData[id] = { id, url, name: name || id.replace(/-/g,' ').replace(/\b\w/g,l=>l.toUpperCase()), ...data };
    res.status(201).json(organizationsData[id]);
  } catch (e) {
    console.error(`Error fetching data for ${url}:`, e.message);
    res.status(502).json({ error: `Failed to fetch organization data: ${e.message}` });
  }
});

app.put('/api/organizations/:id/refresh', async (req,res)=>{
  const { id } = req.params;
  const org = organizationsData[id];
  if (!org) return res.status(404).json({ error: 'Organization not found' });
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
    console.error(`Error refreshing ${id}:`, e.message);
    organizationsData[id].error = `Failed to refresh: ${e.message}`;
    organizationsData[id].lastUpdated = new Date().toISOString();
    res.status(502).json(organizationsData[id]);
  }
});

app.put('/api/organizations/refresh', async (req,res)=>{
  const results = {};
  for (const id of Object.keys(organizationsData)) {
    const org = organizationsData[id];
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
      console.error(`Error refreshing ${id}:`, e.message);
      organizationsData[id].error = `Failed to refresh: ${e.message}`;
      organizationsData[id].lastUpdated = new Date().toISOString();
      results[id] = 'error';
    }
    await sleep(400); // keep small for serverless
  }
  res.json({ message: 'Bulk refresh completed', results, data: organizationsData });
});

app.delete('/api/organizations/:id', (req,res)=>{
  const { id } = req.params;
  if (!organizationsData[id]) return res.status(404).json({ error: 'Organization not found' });
  delete organizationsData[id];
  res.json({ message: `Deleted organization ${id}` });
});

app.get('/api/summary', (req,res)=>{
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

app.get('/api/export.csv', (req,res)=>{
  const rows = [['id','name','url','donors','total','goal','lastUpdated','error']];
  for (const o of Object.values(organizationsData)) {
    rows.push([o.id,o.name,o.url,o.donors||0,o.total||0,o.goal||0,o.lastUpdated||'',o.error||'']);
  }
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="ntgd-organizations.csv"');
  res.send(rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n'));
});

// Reseed (protect with RESEED_TOKEN)
app.post('/api/reseed', (req,res)=>{
  const token = req.query.token || req.headers['x-reseed-token'];
  if (!process.env.RESEED_TOKEN) return res.status(501).json({ error: 'RESEED_TOKEN not configured on server' });
  if (token !== process.env.RESEED_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  const replace = String(req.query.replace||'').toLowerCase()==='true';
  try {
    const result = loadSeeds({ replace });
    res.json({ replaced: replace, ...result, data: organizationsData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = app;
