// server/local.js
// Local development runner for NTGD Monitor

const app = require('./app');

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || 'localhost';

app.listen(PORT, HOST, () => {
  console.log('\n🚀 NTGD Monitor started successfully!');
  console.log(`📍 Frontend: http://${HOST}:${PORT}`);
  console.log(`🔌 API: http://${HOST}:${PORT}/api`);
  console.log(`💚 Health Check: http://${HOST}:${PORT}/api/health`);
  console.log('\n⏱️  Auto-refresh ready - visit the dashboard to start monitoring');
  console.log('🛑 Press Ctrl+C to stop\n');
});