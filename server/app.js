// server/app.js - Enhanced NTXGD Monitor with all improvements + data sanity protection
'use strict';

const express = require('express');
const path = require('path');

// Safe/optional imports (won't crash if missing in some environments)
let cors;      try { cors = require('cors'); } catch { cors = () => (req,res,next)=>next(); }
let helmet;    try { helmet = require('helmet'); } catch { helmet = () => (req,res,next)=>next(); }
let rateLimit; try { rateLimit = require('express-rate-limit'); } catch { rateLimit = null; }
let axios;     try { axios = require('axios'); } catch { axios = null; }
let cheerio;   try { cheerio = require('cheerio'); } catch { cheerio = null; }

// --------------------------- Configuration ---------------------------
const config = {
  // Server
  port: parseInt(process.env.PORT) || 3001,
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Security
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  
  // Scraping
  batchDelayMs: parseInt(process.env.BATCH_DELAY_MS) || 600,
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS) || 12000,
  maxRetries: parseInt(process.env.MAX_RETRIES) || 2,
  userAgent: process.env.USER_AGENT || 'NTXGD-Monitor/2.0 (+vercel)',
  
  // Rate limiting
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 200,
  
  // Monitoring
  logLevel: process.env.LOG_LEVEL || 'info',
  
  // Organizations
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

// Logging utility
const logger = {
  debug: (...args) => config.logLevel === 'debug' && console.log('[DEBUG]', ...args),
  info: (...args) => ['debug', 'info'].includes(config.logLevel) && console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args)
};

// --------------------------- Utils ---------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Extract /organization/<slug>
function urlToId(raw) {
  const m = String(raw).match(/\/organization\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

// Enhanced HTTP client with retries
async function getWithRetry(url, tries = 3) {
  if (!axios) throw new Error('axios not available');
  
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const response = await axios.get(url, { 
        headers: { 
          'User-Agent': config.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        }, 
        timeout: config.requestTimeoutMs,
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 400
      });
      
      return response;
      
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      
      // Don't retry on client errors (4xx) except 429
      if (status >= 400 && status < 500 && status !== 429) {
        break;
      }
      
      // Exponential backoff for retries
      if (i < tries - 1) {
        const delay = Math.min(1000 * Math.pow(2, i), 5000);
        logger.debug(`Retry attempt ${i + 1} failed for ${url}, retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  
  throw lastErr;
}

// Enhanced data extraction
function extractFundraisingData(html) {
  if (!cheerio) return { total: 0, donors: 0, goal: 0, lastUpdated: new Date().toISOString(), error: 'cheerio not available' };
  
  const $ = cheerio.load(html);
  
  // Try structured data first (JSON-LD, microdata)
  let structuredData = {};
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const data = JSON.parse($(el).html());
      if (data.amount || data.totalRaised || data.donationAmount) {
        structuredData = data;
      }
    } catch (e) {
      // Ignore malformed JSON
    }
  });

  const toNum = (s) => {
    if (!s) return 0;
    const cleaned = String(s).replace(/[^0-9.]/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  };

  let total = 0, donors = 0, goal = 0;

  // Try structured data first
  if (structuredData.amount || structuredData.totalRaised) {
    total = toNum(structuredData.amount || structuredData.totalRaised);
  }
  if (structuredData.donorCount || structuredData.supporters) {
    donors = toNum(structuredData.donorCount || structuredData.supporters);
  }
  if (structuredData.goal || structuredData.target) {
    goal = toNum(structuredData.goal || structuredData.target);
  }

  // Fallback to text parsing if structured data not found
  if (!total || !donors || !goal) {
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    
    // Enhanced patterns for total raised
    if (!total) {
      const patterns = [
        /\$\s*([\d,]+(?:\.\d{2})?)\s*raised/i,
        /raised\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /total\s*raised[:\s]*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /amount\s*raised[:\s]*\$?\s*([\d,]+(?:\.\d{2})?)/i
      ];
      
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          total = toNum(match[1]);
          break;
        }
      }
    }

    // Enhanced patterns for donors
    if (!donors) {
      const patterns = [
        /by\s+([\d,]+)\s+donors?/i,
        /([\d,]+)\s+donors?/i,
        /([\d,]+)\s+supporters?/i,
        /supporters?[:\s]*([\d,]+)/i
      ];
      
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          donors = toNum(match[1]);
          break;
        }
      }
    }

    // Enhanced patterns for goal
    if (!goal) {
      const patterns = [
        /\$\s*([\d,]+(?:\.\d{2})?)\s*goal/i,
        /goal[:\s]*\$?\s*([\d,]+(?:\.\d{2})?)/i,
        /target[:\s]*\$?\s*([\d,]+(?:\.\d{2})?)/i
      ];
      
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          goal = toNum(match[1]);
          break;
        }
      }
    }

    // Try to derive missing values from percentage
    const percentMatch = text.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:complete|of\s+goal|raised)/i);
    if (percentMatch) {
      const percent = parseFloat(percentMatch[1]);
      if (percent > 0 && percent <= 100) {
        if (!total && goal) total = Math.round((goal * percent) / 100);
        if (!goal && total) goal = Math.round((total * 100) / percent);
      }
    }
  }

  // Look for specific selectors that might contain the data
  const selectors = [
    '[class*="raised"], [id*="raised"]',
    '[class*="total"], [id*="total"]',
    '[class*="amount"], [id*="amount"]',
    '[class*="donors"], [id*="donors"]',
    '[class*="supporters"], [id*="supporters"]',
    '[class*="goal"], [id*="goal"]',
    '[class*="target"], [id*="target"]'
  ];

  selectors.forEach(selector => {
    $(selector).each((i, el) => {
      const text = $(el).text().trim();
      const dollarMatch = text.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
      const numberMatch = text.match(/\b([\d,]+)\b/);
      
      if (dollarMatch && !total && (text.toLowerCase().includes('raised') || text.toLowerCase().includes('total'))) {
        total = toNum(dollarMatch[1]);
      }
      if (numberMatch && !donors && (text.toLowerCase().includes('donor') || text.toLowerCase().includes('supporter'))) {
        donors = toNum(numberMatch[1]);
      }
      if (dollarMatch && !goal && text.toLowerCase().includes('goal')) {
        goal = toNum(dollarMatch[1]);
      }
    });
  });

  return { 
    total: total || 0, 
    donors: donors || 0, 
    goal: goal || 0, 
    lastUpdated: new Date().toISOString(), 
    error: null 
  };
}

// Data sanity protection function
function saneMerge(prev, next, orgName = 'Unknown') {
  const safeTotal = 
    (next.total <= 0 || !Number.isFinite(next.total)) ? prev.total :
    (prev.total > 0 && next.total > prev.total * 5) ? 
      (logger.warn(`Rejecting suspicious total jump: $${prev.total} -> $${next.total} for ${orgName}`), prev.total) : 
      next.total;

  const safeDonors = 
    (next.donors < 0 || !Number.isFinite(next.donors)) ? prev.donors : next.donors;

  const safeGoal = 
    (next.goal < 0 || !Number.isFinite(next.goal)) ? prev.goal : next.goal;

  return { 
    total: safeTotal, 
    donors: safeDonors, 
    goal: safeGoal,
    lastUpdated: next.lastUpdated,
    error: next.error
  };
}

// --------------------------- Express App Setup ---------------------------
const app = express();

// Request logging middleware
const logRequest = (req, res, next) => {
  const start = Date.now();
  const originalSend = res.send;
  
  res.send = function(data) {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    originalSend.call(this, data);
  };
  
  next();
};

app.use(logRequest);

// Security / CORS
app.use(helmet());
if (config.allowedOrigins.length) {
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || config.allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'), false);
    }
  }));
} else {
  app.use(cors());
}

app.use(express.json());

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Rate limiting
if (rateLimit) {
  app.use('/api', rateLimit({ 
    windowMs: config.rateLimitWindowMs, 
    max: config.rateLimitMaxRequests,
    standardHeaders: true, 
    legacyHeaders: false,
    message: {
      error: 'Too many requests, please try again later',
      retryAfter: '60 seconds'
    },
    skip: (req) => req.path === '/api/health' || req.path === '/api/ping'
  }));
}

// Initialize organizations data
let organizationsData = {};
for (const { name, url } of config.organizations) {
  const id = urlToId(url);
  if (!id) continue;
  organizationsData[id] = { 
    id, name, url, 
    total: 0, donors: 0, goal: 0, 
    lastUpdated: null, error: null 
  };
}

logger.info(`Initialized ${Object.keys(organizationsData).length} organizations`);

// --------------------------- API Routes ---------------------------

// Health check
app.get('/api/health', (req, res) => {
  const orgs = Object.values(organizationsData);
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    organizations: orgs.length,
    lastUpdate: orgs.reduce((latest, org) => {
      if (!org.lastUpdated) return latest;
      const orgTime = new Date(org.lastUpdated).getTime();
      return orgTime > latest ? orgTime : latest;
    }, 0),
    dependencies: {
      axios: !!axios,
      cheerio: !!cheerio
    }
  });
});

// Legacy ping endpoint
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Debug info
app.get('/api/_debug', (req, res) => {
  const keys = Object.keys(organizationsData || {});
  res.json({ count: keys.length, keys, axios: !!axios, cheerio: !!cheerio });
});

// Configuration endpoint
app.get('/api/config', (req, res) => {
  const safeConfig = {
    nodeEnv: config.nodeEnv,
    organizationCount: config.organizations.length,
    batchDelayMs: config.batchDelayMs,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    dependencies: {
      axios: !!axios,
      cheerio: !!cheerio,
      rateLimit: !!rateLimit,
      cors: !!cors,
      helmet: !!helmet
    }
  };
  
  if (config.nodeEnv === 'development') {
    safeConfig.organizations = config.organizations.map(org => ({
      name: org.name,
      hasUrl: !!org.url
    }));
  }
  
  res.json(safeConfig);
});

// Metrics endpoint
app.get('/api/metrics', (req, res) => {
  const orgs = Object.values(organizationsData);
  
  const metrics = {
    timestamp: new Date().toISOString(),
    organizations: {
      total: orgs.length,
      withErrors: orgs.filter(o => o.error).length,
      lastUpdated: orgs.reduce((latest, org) => {
        if (!org.lastUpdated) return latest;
        const orgTime = new Date(org.lastUpdated).getTime();
        return orgTime > latest ? orgTime : latest;
      }, 0),
      averageRefreshDuration: orgs
        .filter(o => o.lastRefreshDuration)
        .reduce((sum, o, _, arr) => sum + o.lastRefreshDuration / arr.length, 0)
    },
    fundraising: {
      totalRaised: orgs.reduce((sum, o) => sum + (o.total || 0), 0),
      totalDonors: orgs.reduce((sum, o) => sum + (o.donors || 0), 0),
      totalGoal: orgs.reduce((sum, o) => sum + (o.goal || 0), 0),
      organizationsWithGoals: orgs.filter(o => o.goal > 0).length
    },
    system: {
      uptime: process.uptime(),
      nodeVersion: process.version,
      dependencies: {
        axios: !!axios,
        cheerio: !!cheerio
      }
    }
  };
  
  res.json(metrics);
});

// Read all organizations
app.get('/api/organizations', (req, res) => res.json(organizationsData));

// Refresh single organization with sanity protection
app.put('/api/organizations/:id/refresh', async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  const org = organizationsData[id];
  
  if (!org) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  
  if (!axios || !cheerio) {
    const error = 'Scraper dependencies unavailable';
    organizationsData[id] = {
      ...org,
      error,
      lastUpdated: new Date().toISOString()
    };
    return res.status(503).json(organizationsData[id]);
  }

  const startTime = Date.now();
  
  try {
    logger.debug(`Starting refresh for ${org.name} (${org.url})`);
    
    const resp = await getWithRetry(org.url, config.maxRetries);
    const data = extractFundraisingData(resp.data);
    
    const duration = Date.now() - startTime;
    logger.info(`Completed ${org.name} in ${duration}ms - Total: $${data.total}, Donors: ${data.donors}`);
    
    // Apply sanity checking to prevent bad data
    const saneData = saneMerge(org, data, org.name);
    const updatedOrg = {
      ...org,
      ...saneData,
      lastRefreshDuration: duration
    };
    
    organizationsData[id] = updatedOrg;
    res.json(updatedOrg);
    
  } catch (e) {
    const duration = Date.now() - startTime;
    let errorType = 'unknown';
    let errorMessage = e.message;
    
    // Categorize errors
    if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') {
      errorType = 'network';
      errorMessage = 'Network connection failed';
    } else if (e.response?.status === 404) {
      errorType = 'not_found';
      errorMessage = 'Page not found';
    } else if (e.response?.status === 429) {
      errorType = 'rate_limited';
      errorMessage = 'Rate limited by server';
    } else if (e.response?.status >= 500) {
      errorType = 'server_error';
      errorMessage = 'Server error';
    } else if (e.code === 'ECONNABORTED' || e.message.includes('timeout')) {
      errorType = 'timeout';
      errorMessage = 'Request timed out';
    }
    
    logger.error(`${org.name}: ${errorType} - ${errorMessage} (${duration}ms)`);
    
    organizationsData[id] = {
      ...org,
      error: `${errorType}: ${errorMessage}`,
      lastUpdated: new Date().toISOString(),
      lastRefreshDuration: duration
    };
    
    res.status(502).json(organizationsData[id]);
  }
});

// Bulk refresh with sanity protection
app.put('/api/organizations/refresh', async (req, res) => {
  const startTime = Date.now();
  const results = {};
  const errors = [];
  const orgIds = Object.keys(organizationsData);
  
  logger.info(`Starting bulk refresh of ${orgIds.length} organizations`);
  
  for (const [index, id] of orgIds.entries()) {
    const org = organizationsData[id];
    
    if (!axios || !cheerio) {
      organizationsData[id] = {
        ...org,
        error: 'Scraper unavailable',
        lastUpdated: new Date().toISOString()
      };
      results[id] = 'skipped';
      continue;
    }
    
    try {
      const resp = await getWithRetry(org.url, config.maxRetries);
      const data = extractFundraisingData(resp.data);
      
      // Apply sanity checking to prevent bad data
      const saneData = saneMerge(org, data, org.name);
      organizationsData[id] = {
        ...org,
        ...saneData
      };
      
      results[id] = 'success';
      
    } catch (e) {
      const errorMsg = `Failed to refresh: ${e.message}`;
      organizationsData[id] = {
        ...org,
        error: errorMsg,
        lastUpdated: new Date().toISOString()
      };
      
      results[id] = 'error';
      errors.push({ org: org.name, error: errorMsg });
    }
    
    // Add delay between requests
    if (index < orgIds.length - 1) {
      await sleep(config.batchDelayMs);
    }
  }
  
  const duration = Date.now() - startTime;
  const successCount = Object.values(results).filter(r => r === 'success').length;
  const errorCount = Object.values(results).filter(r => r === 'error').length;
  
  logger.info(`Bulk refresh completed in ${duration}ms - Success: ${successCount}, Errors: ${errorCount}`);
  
  res.json({ 
    message: 'Bulk refresh completed', 
    results, 
    data: organizationsData,
    summary: {
      total: orgIds.length,
      success: successCount,
      errors: errorCount,
      duration: duration
    },
    errors: errors.length > 0 ? errors : undefined
  });
});

// Summary endpoint
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

// CSV export endpoint
app.get('/api/export.csv', (req, res) => {
  const orgs = Object.values(organizationsData);
  const headers = ['Organization', 'Total Raised', 'Donors', 'Avg Gift', 'Goal', 'Goal %', 'Last Updated', 'Status'];
  
  const rows = [headers.join(',')];
  
  orgs.forEach(org => {
    const avgGift = org.donors > 0 ? (org.total / org.donors).toFixed(2) : '0.00';
    const goalPercent = org.goal > 0 ? Math.round((org.total / org.goal) * 100) : 0;
    const lastUpdated = org.lastUpdated ? new Date(org.lastUpdated).toLocaleString() : 'Never';
    const status = org.error ? 'Error' : 'OK';
    
    const row = [
      `"${org.name}"`,
      org.total || 0,
      org.donors || 0,
      avgGift,
      org.goal || 0,
      goalPercent,
      `"${lastUpdated}"`,
      `"${status}"`
    ];
    rows.push(row.join(','));
  });
  
  const csv = rows.join('\n');
  const timestamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="ntgd-export-${timestamp}.csv"`);
  res.send(csv);
});

// Frontend route for local dev
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// Handle unknown API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Error handling middleware
const errorHandler = (err, req, res, next) => {
  logger.error('Request error:', {
    method: req.method,
    path: req.path,
    error: err.message,
    stack: config.nodeEnv === 'development' ? err.stack : undefined
  });

  const isDev = config.nodeEnv !== 'production';
  
  res.status(err.status || 500).json({
    error: isDev ? err.message : 'Internal server error',
    ...(isDev && { stack: err.stack })
  });
};

app.use(errorHandler);

module.exports = app;