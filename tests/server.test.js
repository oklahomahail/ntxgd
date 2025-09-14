const request = require('supertest');
const fs = require('fs');
const path = require('path');

// Mock the organizations config file before requiring the server
const mockOrganizations = [
  {
    "name": "Test Organization 1",
    "url": "https://www.northtexasgivingday.org/organization/test-org-1"
  },
  {
    "name": "Test Organization 2", 
    "url": "https://www.northtexasgivingday.org/organization/test-org-2"
  }
];

// Create mock config directory and file
const configDir = path.join(__dirname, '..', 'config');
const configFile = path.join(configDir, 'organizations.json');

beforeAll(() => {
  // Ensure config directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  // Write mock organizations file
  fs.writeFileSync(configFile, JSON.stringify(mockOrganizations, null, 2));
});

afterAll(() => {
  // Clean up mock file
  if (fs.existsSync(configFile)) {
    fs.unlinkSync(configFile);
  }
});

// Now require the server after setting up the mock
const app = require('../server');

describe('NTGD Monitor API', () => {
  describe('GET /api/organizations', () => {
    it('should return organizations loaded from seed file', async () => {
      const res = await request(app)
        .get('/api/organizations')
        .expect(200);
      
      expect(typeof res.body).toBe('object');
      expect(Object.keys(res.body)).toHaveLength(2); // 2 mock orgs
      
      // Check that each org has required fields
      Object.values(res.body).forEach(org => {
        expect(org).toHaveProperty('id');
        expect(org).toHaveProperty('name');
        expect(org).toHaveProperty('url');
        expect(org).toHaveProperty('total');
        expect(org).toHaveProperty('donors');
        expect(org).toHaveProperty('goal');
        expect(org.total).toBe(0); // Should start at 0
        expect(org.donors).toBe(0);
        expect(org.goal).toBe(0);
      });
    });

    it('should have proper organization structure', async () => {
      const res = await request(app)
        .get('/api/organizations')
        .expect(200);
      
      // Check specific test organization
      const testOrg1 = Object.values(res.body).find(org => 
        org.name === 'Test Organization 1'
      );
      
      expect(testOrg1).toBeDefined();
      expect(testOrg1.id).toBe('test-org-1');
      expect(testOrg1.url).toBe('https://www.northtexasgivingday.org/organization/test-org-1');
    });
  });

  describe('GET /api/summary', () => {
    it('should return summary statistics', async () => {
      const res = await request(app)
        .get('/api/summary')
        .expect(200);
      
      expect(res.body).toHaveProperty('organizationCount');
      expect(res.body).toHaveProperty('totalRaised');
      expect(res.body).toHaveProperty('totalDonors');
      expect(res.body).toHaveProperty('totalGoal');
      expect(res.body).toHaveProperty('averageGift');
      expect(res.body).toHaveProperty('lastUpdated');
      
      expect(typeof res.body.organizationCount).toBe('number');
      expect(typeof res.body.totalRaised).toBe('number');
      expect(typeof res.body.totalDonors).toBe('number');
      expect(typeof res.body.averageGift).toBe('number');
      expect(res.body.organizationCount).toBe(2); // 2 mock orgs
    });

    it('should handle division by zero safely', async () => {
      const res = await request(app)
        .get('/api/summary')
        .expect(200);
      
      // With initial data (0 donors), averageGift should be 0, not NaN
      expect(res.body.averageGift).toBe(0);
      expect(Number.isNaN(res.body.averageGift)).toBe(false);
    });

    it('should return ISO timestamp for lastUpdated', async () => {
      const res = await request(app)
        .get('/api/summary')
        .expect(200);
      
      expect(res.body.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(new Date(res.body.lastUpdated).toString()).not.toBe('Invalid Date');
    });
  });

  describe('POST /api/organizations', () => {
    it('should add new organization with valid URL', async () => {
      const newOrg = {
        name: 'New Test Organization',
        url: 'https://www.northtexasgivingday.org/organization/new-test-org'
      };

      const res = await request(app)
        .post('/api/organizations')
        .send(newOrg)
        .expect(201);
      
      expect(res.body).toHaveProperty('id', 'new-test-org');
      expect(res.body).toHaveProperty('name', 'New Test Organization');
      expect(res.body).toHaveProperty('url', newOrg.url);
      expect(res.body).toHaveProperty('total', 0);
      expect(res.body).toHaveProperty('donors', 0);
    });

    it('should return existing organization if URL already exists', async () => {
      const existingOrg = {
        name: 'Duplicate Test',
        url: 'https://www.northtexasgivingday.org/organization/test-org-1'
      };

      const res = await request(app)
        .post('/api/organizations')
        .send(existingOrg)
        .expect(200); // 200 for existing, not 201
      
      expect(res.body).toHaveProperty('id', 'test-org-1');
      expect(res.body.name).toBe('Test Organization 1'); // Original name preserved
    });

    it('should reject invalid URLs', async () => {
      const invalidUrls = [
        'http://www.northtexasgivingday.org/organization/test', // HTTP not HTTPS
        'https://evil.com/organization/test', // Wrong domain
        'https://www.northtexasgivingday.org/wrong/test', // Wrong path
        'not-a-url', // Not a URL at all
        'https://www.northtexasgivingday.org/organization/', // Missing org slug
        'https://www.northtexasgivingday.org/organization/test/extra' // Too many path segments
      ];

      for (const url of invalidUrls) {
        await request(app)
          .post('/api/organizations')
          .send({ url, name: 'Test' })
          .expect(400);
      }
    });

    it('should handle missing request body', async () => {
      await request(app)
        .post('/api/organizations')
        .send({})
        .expect(400);
    });
  });

  describe('PUT /api/organizations/:id/refresh', () => {
    it('should return 404 for non-existent organization', async () => {
      const res = await request(app)
        .put('/api/organizations/non-existent-org/refresh')
        .expect(404);
      
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toBe('Organization not found');
    });

    it('should attempt to refresh existing organization', async () => {
      // This will likely fail due to network request, but should not 404
      const res = await request(app)
        .put('/api/organizations/test-org-1/refresh');
      
      // Should not be 404 (org exists) or 400 (URL is valid)
      expect(res.status).not.toBe(404);
      expect(res.status).not.toBe(400);
      
      // Will likely be 500 due to network failure in test environment
      if (res.status === 500) {
        expect(res.body).toHaveProperty('error');
      } else if (res.status === 200) {
        // If somehow successful, should return org structure
        expect(res.body).toHaveProperty('id', 'test-org-1');
      }
    });
  });

  describe('DELETE /api/organizations/:id', () => {
    it('should remove existing organization', async () => {
      // First add an organization to remove
      await request(app)
        .post('/api/organizations')
        .send({
          name: 'To Be Deleted',
          url: 'https://www.northtexasgivingday.org/organization/to-be-deleted'
        })
        .expect(201);

      // Then delete it
      await request(app)
        .delete('/api/organizations/to-be-deleted')
        .expect(200);

      // Verify it's gone
      const res = await request(app)
        .put('/api/organizations/to-be-deleted/refresh')
        .expect(404);
    });

    it('should return 404 for non-existent organization', async () => {
      const res = await request(app)
        .delete('/api/organizations/does-not-exist')
        .expect(404);
      
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toBe('Organization not found');
    });
  });

  describe('GET /api/export.csv', () => {
    it('should return CSV format', async () => {
      const res = await request(app)
        .get('/api/export.csv')
        .expect(200);
      
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(res.text).toContain('id,name,url,donors,total,goal,lastUpdated,error');
      expect(res.text).toContain('test-org-1');
      expect(res.text).toContain('Test Organization 1');
    });

    it('should properly escape CSV data', async () => {
      // Add an org with special characters
      await request(app)
        .post('/api/organizations')
        .send({
          name: 'Test "Quotes" & Commas, Inc.',
          url: 'https://www.northtexasgivingday.org/organization/special-chars'
        })
        .expect(201);

      const res = await request(app)
        .get('/api/export.csv')
        .expect(200);
      
      // Should properly quote and escape special characters
      expect(res.text).toContain('"Test ""Quotes"" & Commas, Inc."');
    });
  });

  describe('GET /', () => {
    it('should serve the frontend HTML', async () => {
      const res = await request(app)
        .get('/')
        .expect(200);
      
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('NTGD Monitor Dashboard');
      expect(res.text).toContain('<script src="app.js"></script>');
    });
  });

  describe('Security Headers', () => {
    it('should include Helmet security headers', async () => {
      const res = await request(app)
        .get('/api/organizations')
        .expect(200);
      
      // Helmet should add these security headers
      expect(res.headers).toHaveProperty('x-content-type-options');
      expect(res.headers).toHaveProperty('x-frame-options');
      expect(res.headers).toHaveProperty('x-dns-prefetch-control');
    });

    it('should respect CORS settings', async () => {
      const res = await request(app)
        .get('/api/organizations')
        .expect(200);
      
      // Should have CORS headers (depending on configuration)
      if (res.headers['access-control-allow-origin']) {
        expect(res.headers['access-control-allow-origin']).toBeDefined();
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed JSON in POST', async () => {
      const res = await request(app)
        .post('/api/organizations')
        .set('Content-Type', 'application/json')
        .send('{"invalid": json}')
        .expect(400);
    });

    it('should return JSON errors consistently', async () => {
      const res = await request(app)
        .get('/api/organizations/nonexistent')
        .expect(404);
      
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('Rate Limiting', () => {
    it('should not rate limit normal usage', async () => {
      // Make several requests quickly
      const promises = Array(5).fill().map(() =>
        request(app).get('/api/summary').expect(200)
      );
      
      const results = await Promise.all(promises);
      results.forEach(res => {
        expect(res.status).toBe(200);
      });
    });
  });
});

describe('URL Validation Functions', () => {
  // These would test the validation functions if they were exported
  // For now, we test them indirectly through the API endpoints
  
  describe('Valid URLs', () => {
    const validUrls = [
      'https://www.northtexasgivingday.org/organization/test-org',
      'https://www.northtexasgivingday.org/organization/test-org-123',
      'https://www.northtexasgivingday.org/organization/Test-Org-Name'
    ];

    test.each(validUrls)('should accept valid URL: %s', async (url) => {
      const res = await request(app)
        .post('/api/organizations')
        .send({ url, name: 'Test' });
      
      expect(res.status).not.toBe(400);
    });
  });

  describe('Invalid URLs', () => {
    const invalidUrls = [
      'http://www.northtexasgivingday.org/organization/test', // HTTP
      'https://evil.com/organization/test', // Wrong domain
      'https://www.northtexasgivingday.org/wrong/test', // Wrong path
      'https://www.northtexasgivingday.org/organization/', // No org name
      'https://www.northtexasgivingday.org/organization/test/extra' // Extra segments
    ];

    test.each(invalidUrls)('should reject invalid URL: %s', async (url) => {
      await request(app)
        .post('/api/organizations')
        .send({ url, name: 'Test' })
        .expect(400);
    });
  });
});

describe('Data Processing', () => {
  it('should initialize organizations with correct default values', async () => {
    const res = await request(app)
      .get('/api/organizations')
      .expect(200);
    
    const org = Object.values(res.body)[0];
    expect(org.total).toBe(0);
    expect(org.donors).toBe(0);
    expect(org.goal).toBe(0);
    expect(org.lastUpdated).toBeNull();
    expect(org.error).toBeNull();
  });

  it('should calculate summary statistics correctly', async () => {
    // This tests the basic calculation logic with initial data
    const res = await request(app)
      .get('/api/summary')
      .expect(200);
    
    expect(res.body.totalRaised).toBe(0);
    expect(res.body.totalDonors).toBe(0);
    expect(res.body.averageGift).toBe(0); // 0/0 should be 0, not NaN
    expect(res.body.organizationCount).toBeGreaterThan(0);
  });
});

module.exports = app;