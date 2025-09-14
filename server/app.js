// server/app.js — minimal, crash-proof, hard-wired orgs (scraper disabled)
'use strict';

const express = require('express');
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

function urlToId(raw) {
  const m = String(raw).match(/\/organization\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

const app = express();
app.use(express.json());
// static only helps local dev; on Vercel /public is routed by vercel.json
app.use(express.static(path.join(__dirname, '..', 'public')));

// Seed in memory
let organizationsData = {};
for (const { name, url } of HARDCODED_ORGS) {
  const id = urlToId(url);
  if (!id) continue;
  organizationsData[id] = { id, name, url, total: 0, donors: 0, goal: 0, lastUpdated: null, error: null };
}
console.log('[BOOT] seeded orgs (minimal):', Object.keys(organizationsData));

// Health/debug
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/_debug', (req, res) => {
  const keys = Object.keys(organizationsData || {});
  res.json({ count: keys.length, keys });
});

// Data endpoints
app.get('/api/organizations', (req, res) => res.json(organizationsData));

app.put('/api/organizations/:id/refresh', (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  const org = organizationsData[id];
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  // scraper intentionally disabled in this minimal build
  res.status(503).json({ ...org, error: 'Scraper unavailable in minimal build', lastUpdated: new Date().toISOString() });
});

app.put('/api/organizations/refresh', (req, res) => {
  const results = {};
  for (const id of Object.keys(organizationsData)) {
    organizationsData[id].error = 'Scraper unavailable in minimal build';
    organizationsData[id].lastUpdated = new Date().toISOString();
    results[id] = 'skipped';
  }
  res.status(503).json({ message: 'Bulk refresh skipped (scraper disabled)', results, data: organizationsData });
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

// Local dev index (Vercel routes /public already)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

module.exports = app;
