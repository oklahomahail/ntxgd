// server/app.js
// Main Express application for NTGD Monitor

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');

const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://ntxgd.vercel.app', 'https://your-domain.com'] 
    : true,
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Store organization data in memory (use database in production)
let organizationsData = {};

// Load organizations from config on startup
function loadOrganizations() {
  try {
    const configPath = path.join(__dirname, '../config/organizations.json');
    if (fs.existsSync(configPath)) {
      const orgsArray = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      // Convert array to object with URL-based IDs
      orgsArray.forEach(org => {
        const id = org.url.split('/organization/')[1] || org.name.toLowerCase().replace(/\s+/g, '-');
        organizationsData[id] = {
          id,
          name: org.name,
          url: org.url,
          total: 0,
          donors: 0,
          goal: 0,
          lastUpdated: null,
          error: null
        };
      });
      
      console.log(`✅ Loaded ${Object.keys(organizationsData).length} organizations from config`);
    }
  } catch (error) {
    console.warn('⚠️ Could not load organizations config:', error.message);
  }
}

// Initialize organizations
loadOrganizations();

// Enhanced data extraction with multiple strategies
function extractFundraisingData(html, orgId) {
  const $ = cheerio.load(html);
  
  let total = 0;
  let donors = 0;
  let goal = 0;
  
  try {
    // Strategy 1: Look for JSON-LD structured data
    $('script[type="application/ld+json"]').each((i, elem) => {
      try {
        const jsonData = JSON.parse($(elem).html());
        if (jsonData.amount || jsonData.totalDonated) {
          total = parseFloat(jsonData.amount || jsonData.totalDonated);
        }
        if (jsonData.donorCount) {
          donors = parseInt(jsonData.donorCount);
        }
        if (jsonData.goal) {
          goal = parseFloat(jsonData.goal);
        }
      } catch (e) {
        // Continue to next strategy
      }
    });
    
    // Strategy 2: Look for specific CSS selectors
    if (total === 0) {
      const totalSelectors = [
        '[data-testid*="raised"]',
        '[class*="total-raised"]',
        '[class*="amount-raised"]',
        '.donation-total',
        '.fundraising-total',
        '.campaign-total',
        '#total-raised',
        '[id*="raised"]'
      ];
      
      for (const selector of totalSelectors) {
        const element = $(selector);
        if (element.length > 0) {
          const text = element.text();
          const match = text.match(/\$?([\d,]+\.?\d*)/);
          if (match) {
            total = parseFloat(match[1].replace(/,/g, ''));
            break;
          }
        }
      }
    }
    
    // Strategy 3: Text pattern matching
    if (total === 0) {
      const bodyText = $('body').text();
      
      // Look for dollar amounts
      const dollarMatches = bodyText.match(/\$[\d,]+\.?\d*/g) || [];
      if (dollarMatches.length > 0) {
        const amounts = dollarMatches
          .map(amt => parseFloat(amt.replace(/[\$,]/g, '')))
          .filter(amt => !isNaN(amt) && amt > 0);
        
        if (amounts.length > 0) {
          total = Math.max(...amounts);
        }
      }
      
      // Look for "raised" patterns
      const raisedMatch = bodyText.match(/raised[:\s]*\$?([\d,]+\.?\d*)/i);
      if (raisedMatch) {
        total = parseFloat(raisedMatch[1].replace(/,/g, ''));
      }
    }
    
    // Extract donor count
    if (donors === 0) {
      const donorSelectors = [
        '[class*="donor"]',
        '[class*="supporter"]',
        '[data-testid*="donor"]',
        '.donor-count'
      ];
      
      for (const selector of donorSelectors) {
        const element = $(selector);
        if (element.length > 0) {
          const text = element.text();
          const match = text.match(/(\d+)/);
          if (match) {
            donors = parseInt(match[1]);
            break;
          }
        }
      }
      
      // Text pattern for donors
      if (donors === 0) {
        const bodyText = $('body').text();
        const donorMatch = bodyText.match(/(\d+)\s+(donor|supporter|giver)s?/i);
        if (donorMatch) {
          donors = parseInt(donorMatch[1]);
        }
      }
    }
    
    // Extract goal
    if (goal === 0) {
      const goalSelectors = [
        '[class*="goal"]',
        '[class*="target"]',
        '[data-testid*="goal"]',
        '.campaign-goal'
      ];
      
      for (const selector of goalSelectors) {
        const element = $(selector);
        if (element.length > 0) {
          const text = element.text();
          const match = text.match(/\$?([\d,]+\.?\d*)/);
          if (match) {
            goal = parseFloat(match[1].replace(/,/g, ''));
            break;
          }
        }
      }
      
      // Text pattern for goal
      if (goal === 0) {
        const bodyText = $('body').text();
        const goalMatch = bodyText.match(/goal[:\s]*\$?([\d,]+\.?\d*)/i);
        if (goalMatch) {
          goal = parseFloat(goalMatch[1].replace(/,/g, ''));
        }
      }
    }
    
  } catch (error) {
    console.error(`Error extracting data for ${orgId}:`, error.message);
  }
  
  return {
    total: total || 0,
    donors: donors || 0,
    goal: goal || 0,
    lastUpdated: new Date().toISOString(),
    error: null
  };
}

// Validation helper
function isValidNTGDUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname === 'www.northtexasgivingday.org' && 
           urlObj.pathname.includes('/organization/');
  } catch {
    return false;
  }
}

// API Routes
app.get('/api/organizations', (req, res) => {
  res.json(organizationsData);
});

app.put('/api/organizations/:id/refresh', async (req, res) => {
  const { id } = req.params;
  const org = organizationsData[id];
  
  if (!org) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  
  try {
    const response = await axios.get(org.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NTGD-Monitor/1.0; +https://your-site.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      timeout: 15000,
      maxRedirects: 5
    });
    
    const data = extractFundraisingData(response.data, id);
    organizationsData[id] = { ...org, ...data };
    
    res.json(organizationsData[id]);
    
  } catch (error) {
    console.error(`Error refreshing data for ${id}:`, error.message);
    organizationsData[id] = {
      ...org,
      error: `Failed to refresh: ${error.message}`,
      lastUpdated: new Date().toISOString()
    };
    
    res.status(500).json(organizationsData[id]);
  }
});

// Bulk refresh endpoint
app.put('/api/organizations/refresh', async (req, res) => {
  const results = {};
  const orgIds = Object.keys(organizationsData);
  
  console.log(`Starting bulk refresh for ${orgIds.length} organizations...`);
  
  for (const id of orgIds) {
    const org = organizationsData[id];
    
    try {
      const response = await axios.get(org.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NTGD-Monitor/1.0; +https://your-site.com)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 15000,
        maxRedirects: 5
      });
      
      const data = extractFundraisingData(response.data, id);
      organizationsData[id] = { ...org, ...data };
      results[id] = 'success';
      
      console.log(`✅ Refreshed ${org.name}: $${data.total} from ${data.donors} donors`);
      
    } catch (error) {
      console.error(`❌ Error refreshing ${org.name}:`, error.message);
      organizationsData[id] = {
        ...org,
        error: `Failed to refresh: ${error.message}`,
        lastUpdated: new Date().toISOString()
      };
      results[id] = 'error';
    }
    
    // Rate limiting: wait between requests
    if (orgIds.indexOf(id) < orgIds.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  const successCount = Object.values(results).filter(r => r === 'success').length;
  console.log(`Bulk refresh completed: ${successCount}/${orgIds.length} successful`);
  
  res.json({ 
    message: 'Bulk refresh completed',
    results,
    data: organizationsData 
  });
});

// Summary statistics
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
  const headers = ['id', 'name', 'url', 'total', 'donors', 'goal', 'lastUpdated', 'error'];
  const rows = [headers];
  
  Object.values(organizationsData).forEach(org => {
    rows.push([
      org.id,
      org.name,
      org.url,
      org.total || 0,
      org.donors || 0,
      org.goal || 0,
      org.lastUpdated || '',
      org.error || ''
    ]);
  });
  
  const csvContent = rows
    .map(row => row.map(field => `"${String(field).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ntgd-data.csv"');
  res.send(csvContent);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    organizations: Object.keys(organizationsData).length
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Handle SPA routing
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'API endpoint not found' });
  } else {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

module.exports = app;