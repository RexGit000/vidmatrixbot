const Media    = require('../models/Media');
const User     = require('../models/User');
const Settings = require('../models/Settings');
const adminCache = require('../cache');

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

  const all = await Media.find({}, { _id: 1, fileId: 1 }).lean();
  if (!all.length) {
    console.log('[sync] Media pool is empty, nothing to check');
    return;
  }

  console.log(`[sync] Checking ${all.length} media record(s)...`);

  const results = await Promise.allSettled(
    all.map((m) => bot.telegram.getFile(m.fileId).then(() => null).catch(() => m._id))
  );

  const stale = results
    .filter((r) => r.status === 'fulfilled' && r.value !== null)
    .map((r) => r.value);

  if (!stale.length) {
    console.log('[sync] All media accessible — pool is clean');
    return;
  }

  const failRate = stale.length / all.length;
  if (failRate > 0.2) {
    console.warn(`[sync] ${stale.length}/${all.length} files failed (${Math.round(failRate * 100)}%) — looks like a token or connectivity issue, skipping deletion to avoid data loss`);
    return;
  }

  await Media.deleteMany({ _id: { $in: stale } });
  await User.updateMany(
    { receivedMedia: { $in: stale } },
    { $pull: { receivedMedia: { $in: stale } } }
  );

  console.log(`[sync] Removed ${stale.length} inaccessible record(s) and cleared from user history`);
}

module.exports = { syncMediaPool };
