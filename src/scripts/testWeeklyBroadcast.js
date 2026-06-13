require('dotenv').config({ override: true });
const { Telegraf } = require('telegraf');
const connectDB = require('../db');
const Settings = require('../models/Settings');
const {
  buildMockWeeklyEntriesFromAdmins,
  publishWeeklyResults,
} = require('../services/weeklyCycleService');
const { getPreviousISTWeekWindow } = require('../utils/time');

async function main() {
  await connectDB();

  const updatesChannelUsername = await Settings.get('updatesChannelUsername');
  const entries = await buildMockWeeklyEntriesFromAdmins();

  if (!entries.length) {
    console.log('No admins with telegramId found for weekly test broadcast.');
    process.exit(0);
    return;
  }

  const bot = new Telegraf(process.env.BOT_TOKEN);
  const result = await publishWeeklyResults(bot, entries, {
    weekWindow: getPreviousISTWeekWindow(),
    updatesChannelUsername,
    persistUsers: false,
  });

  console.log(
    `Weekly test broadcast sent. Winners processed: ${result.winnerCount}. ` +
    `Updates channel: ${updatesChannelUsername || 'not set'}. No DB writes performed.`
  );
  process.exit(0);
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('Weekly test broadcast failed:', err);
    process.exit(1);
  });
}
