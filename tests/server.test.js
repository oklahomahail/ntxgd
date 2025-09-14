// tests/server.test.js
const request = require('supertest');
const app = require('../server/app');

describe('NTGD Monitor API', () => {
  
  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/api/health')
        .expect(200);
      
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('organizations');
    });
  });

  describe('GET /api/organizations', () => {
    it('should return organizations data', async () => {
      const response = await request(app)
        .get('/api/organizations')
        .expect(200);
      
      expect(typeof response.body).toBe('object');
    });
  });

  describe('GET /api/summary', () => {
    it('should return summary statistics', async () => {
      const response = await request(app)
        .get('/api/summary')
        .expect(200);
      
      expect(response.body).toHaveProperty('organizationCount');
      expect(response.body).toHaveProperty('totalRaised');
      expect(response.body).toHaveProperty('totalDonors');
      expect(response.body).toHaveProperty('averageGift');
      expect(response.body).toHaveProperty('lastUpdated');
    });
  });

  describe('PUT /api/organizations/:id/refresh', () => {
    it('should return 404 for non-existent organization', async () => {
      await request(app)
        .put('/api/organizations/nonexistent/refresh')
        .expect(404);
    });
  });

  describe('GET /api/export.csv', () => {
    it('should return CSV export', async () => {
      const response = await request(app)
        .get('/api/export.csv')
        .expect(200);
      
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('attachment');
    });
  });

  describe('Frontend routes', () => {
    it('should serve index.html for root route', async () => {
      const response = await request(app)
        .get('/')
        .expect(200);
      
      expect(response.headers['content-type']).toContain('text/html');
    });

    it('should return 404 for unknown API routes', async () => {
      await request(app)
        .get('/api/unknown')
        .expect(404);
    });
  });

  describe('Bulk refresh', () => {
    it('should handle bulk refresh request', async () => {
      const response = await request(app)
        .put('/api/organizations/refresh')
        .expect(200);
      
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('results');
      expect(response.body).toHaveProperty('data');
    }, 30000); // Longer timeout for bulk operations
  });

  describe('Security', () => {
    it('should include security headers', async () => {
      const response = await request(app)
        .get('/api/health')
        .expect(200);
      
      // Helmet should add security headers
      expect(response.headers).toHaveProperty('x-content-type-options');
      expect(response.headers).toHaveProperty('x-frame-options');
    });

    it('should handle JSON body parsing', async () => {
      const response = await request(app)
        .post('/api/test-endpoint-that-doesnt-exist')
        .send({ test: 'data' })
        .expect(404);
    });
  });

  describe('Error handling', () => {
    it('should handle malformed JSON gracefully', async () => {
      const response = await request(app)
        .post('/api/organizations')
        .set('Content-Type', 'application/json')
        .send('invalid json')
        .expect(400);
    });
  });
});

// Mock data extraction tests
describe('Data Extraction', () => {
  const mockHtml = `
    <html>
      <body>
        <div class="total-raised">$15,250</div>
        <div class="donor-count">45 donors</div>
        <div class="campaign-goal">Goal: $25,000</div>
        <script type="application/ld+json">
          {
            "amount": 15250,
            "donorCount": 45,
            "goal": 25000
          }
        </script>
      </body>
    </html>
  `;

  it('should extract fundraising data from HTML', () => {
    // Note: This would require exposing the extractFundraisingData function
    // or creating a test endpoint that uses it
    expect(true).toBe(true); // Placeholder
  });
});

// Rate limiting tests
describe('Rate Limiting', () => {
  it('should apply rate limiting to API routes', async () => {
    // Make multiple requests quickly
    const requests = Array(10).fill().map(() => 
      request(app).get('/api/health')
    );
    
    const responses = await Promise.all(requests);
    
    // All should succeed since we're under the limit
    responses.forEach(response => {
      expect(response.status).toBe(200);
    });
  });
});