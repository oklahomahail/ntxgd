// api/index.js
// Vercel serverless entry — reuses the Express app.

const app = require('../server/app');

// Export the Express app; @vercel/node adapts it to a serverless handler.
module.exports = app;
