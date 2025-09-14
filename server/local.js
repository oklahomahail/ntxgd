// server/local.js
// Local runner to test the app on your machine.

require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`NTGD Monitor (local) at http://${HOST}:${PORT}`);
});
