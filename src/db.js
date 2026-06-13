require('dotenv').config({ override: true });
const mongoose = require('mongoose');

async function connectDB() {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        dbName: process.env.DB_NAME || 'client_rex_stm_2',
      });
      console.log(`MongoDB connected → DB: ${mongoose.connection.db.databaseName}`);
      return;
    } catch (err) {
      const delay = Math.min(5000 * attempt, 30000);
      console.error(`[db] Connection failed (attempt ${attempt}), retrying in ${delay / 1000}s: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

module.exports = connectDB;
