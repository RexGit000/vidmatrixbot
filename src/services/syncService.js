const Media    = require('../models/Media');
const User     = require('../models/User');
const Settings = require('../models/Settings');
const { adminCache } = require('../cache');
const { sleep } = require('../utils/helpers');

async function checkChannelAccess(bot) {
  const channelId = await Settings.get('fileManagerChannel');
  if (!channelId) return;

  try {
    const me     = await bot.telegram.getMe();
    const member = await bot.telegram.getChatMember(channelId, me.id);
    if (!['administrator', 'creator'].includes(member.status)) {
      throw new Error('not admin');
    }
  } catch {
    const safeId = String(channelId).replace(/([_*`\[])/g, '\\$1');
    const msg = `⚠️ *File Channel Alert*\n\nThe bot has lost admin access to the file channel (\`${safeId}\`).\n\nPlease check channel permissions or set a new channel.`;
    for (const admin of adminCache.getAll().filter((a) => a.telegramId)) {
      bot.telegram.sendMessage(admin.telegramId, msg, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }
}

async function syncMediaPool(bot) {
  await checkChannelAccess(bot);

  const total = await Media.countDocuments();
  if (!total) {
    console.log('[sync] Media pool is empty, nothing to check');
    return;
  }

  const BOT_KEY = String(process.env.CURRENT_BOT_KEY || (process.env.BOT_TOKEN || '').split(':')[0] || 'default').trim();
  const seeded = await Media.countDocuments({ [`bot_file_ids.${BOT_KEY}`]: { $exists: true, $ne: null } });
  const needCold = total - seeded;

  console.log(`[sync] ${total} media record(s); BOT_KEY=${BOT_KEY} — seeded=${seeded}, will-cold-reseed-on-first-redemption=${needCold}`);
}

module.exports = { syncMediaPool };
