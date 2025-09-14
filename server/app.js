// North Texas Giving Day Monitor Backend
// Run with: node server.js

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store organization data in memory (use database in production)
let organizationsData = {};

// Function to extract fundraising data from HTML
function extractFundraisingData(html, orgId) {
    const $ = cheerio.load(html);
    
    let total = 0;
    let donors = 0;
    let goal = 0;
    
    // Common patterns for fundraising totals
    const totalSelectors = [
        '[class*="raised"]',
        '[class*="total"]',
        '[class*="amount"]',
        '[id*="raised"]',
        '[id*="total"]',
        '.donation-total',
        '.fundraising-total',
        '.campaign-total'
    ];
    
    // Common patterns for donor counts
    const donorSelectors = [
        '[class*="donor"]',
        '[class*="supporter"]',
        '[class*="giver"]',
        '.donor-count',
        '.supporter-count'
    ];
    
    // Common patterns for goals
    const goalSelectors = [
        '[class*="goal"]',
        '[class*="target"]',
        '.campaign-goal',
        '.fundraising-goal'
    ];
    
    // Extract amounts using regex patterns
    const text = $('body').text();
    const dollarAmounts = text.match(/\$[\d,]+\.?\d*/g) || [];
    const numberPatterns = text.match(/[\d,]+/g) || [];
    
    // Try to find the largest dollar amount (likely the total)
    if (dollarAmounts.length > 0) {
        const amounts = dollarAmounts.map(amt => 
            parseFloat(amt.replace(/[\$,]/g, ''))
        ).filter(amt => !isNaN(amt));
        
        if (amounts.length > 0) {
            total = Math.max(...amounts);
        }
    }
    
    // Look for donor count patterns
    const donorMatches = text.match(/(\d+)\s+(donor|supporter|giver)s?/gi);
    if (donorMatches && donorMatches.length > 0) {
        donors = parseInt(donorMatches[0].match(/\d+/)[0]);
    }
    
    // Look for goal patterns
    const goalMatches = text.match(/goal[:\s]*\$?([\d,]+)/gi);
    if (goalMatches && goalMatches.length > 0) {
        goal = parseInt(goalMatches[0].match(/[\d,]+/)[0].replace(/,/g, ''));
    }
    
    return {
        total: total || 0,
        donors: donors || 0,
        goal: goal || 0,
        lastUpdated: new Date().toISOString(),
        error: null
    };
}

// API Routes
app.get('/api/organizations', (req, res) => {
    res.json(organizationsData);
});

app.post('/api/organizations', async (req, res) => {
    const { url } = req.body;
    
    if (!url || !url.includes('northtexasgivingday.org/organization/')) {
        return res.status(400).json({ 
            error: 'Invalid URL. Must be a North Texas Giving Day organization URL.' 
        });
    }
    
    try {
        const orgId = url.split('/organization/')[1];
        const orgName = orgId.replace(/-/g, ' ')
            .replace(/\b\w/g, l => l.toUpperCase());
        
        // Fetch the organization page
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000
        });
        
        const data = extractFundraisingData(response.data, orgId);
        
        organizationsData[orgId] = {
            id: orgId,
            url: url,
            name: orgName,
            ...data
        };
        
        res.json(organizationsData[orgId]);
        
    } catch (error) {
        console.error(`Error fetching data for ${url}:`, error.message);
        res.status(500).json({ 
            error: `Failed to fetch organization data: ${error.message}` 
        });
    }
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
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000
        });
        
        const data = extractFundraisingData(response.data, id);
        organizationsData[id] = { ...org, ...data };
        
        res.json(organizationsData[id]);
        
    } catch (error) {
        console.error(`Error refreshing data for ${id}:`, error.message);
        organizationsData[id].error = `Failed to refresh: ${error.message}`;
        organizationsData[id].lastUpdated = new Date().toISOString();
        
        res.status(500).json(organizationsData[id]);
    }
});

app.delete('/api/organizations/:id', (req, res) => {
    // Remove delete functionality since organizations are pre-configured
    res.status(405).json({ error: 'Organizations cannot be removed - they are pre-configured' });
});

// Bulk refresh endpoint
app.put('/api/organizations/refresh', async (req, res) => {
    const results = {};
    
    for (const [id, org] of Object.entries(organizationsData)) {
        try {
            const response = await axios.get(org.url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                timeout: 10000
            });
            
            const data = extractFundraisingData(response.data, id);
            organizationsData[id] = { ...org, ...data };
            results[id] = 'success';
            
        } catch (error) {
            console.error(`Error refreshing ${id}:`, error.message);
            organizationsData[id].error = `Failed to refresh: ${error.message}`;
            organizationsData[id].lastUpdated = new Date().toISOString();
            results[id] = 'error';
        }
        
        // Add delay between requests to be respectful
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    res.json({ 
        message: 'Bulk refresh completed',
        results,
        data: organizationsData 
    });
});

// Get summary statistics with safe division
app.get('/api/summary', (req, res) => {
    const orgs = Object.values(organizations);
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

// CSV export endpoint
app.get('/api/export.csv', (req, res) => {
    const rows = [['id', 'name', 'url', 'donors', 'total', 'goal', 'lastUpdated', 'error']];
    for (const o of Object.values(organizations)) {
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
    res.send(rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n'));
});

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server only if this file is run directly (not imported for testing)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`✅ Seeded ${Object.keys(organizations).length} organizations from config/organizations.json`);
        console.log(`North Texas Giving Day Monitor server running on port ${PORT}`);
        console.log(`Frontend available at: http://localhost:${PORT}`);
        console.log(`API available at: http://localhost:${PORT}/api`);
    });
}

// Export for testing
module.exports = app;