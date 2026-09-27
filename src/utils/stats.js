const Media    = require('../models/Media');
const Package  = require('../models/Package');
const User     = require('../models/User');
const Admin    = require('../models/Admin');
const Settings = require('../models/Settings');

/**
 * Builds the admin dashboard stats string.
 * Pass `telegram` to resolve the channel name; omit it to show the raw ID only.
 */
async function buildAdminStats(telegram) {
  const [channelId, mediaCount, pkgCount, userCount, adminCount] = await Promise.all([
    Settings.get('fileManagerChannel'),
    Media.countDocuments(),
    Package.countDocuments({ isActive: true }),
    User.countDocuments(),
    Admin.countDocuments(),
  ]);

  let channelLine;
  if (!channelId) {
    channelLine = '📺 File channel: _not set_';
  } else {
    let label = channelId;
    if (telegram) {
      try {
        const chat = await telegram.getChat(channelId);
        if (chat.title) {
          const safeTitle = chat.title.replace(/([_*`\[])/g, '\\$1');
          label = `${safeTitle} (\`${channelId}\`)`;
        } else {
          label = `\`${channelId}\``;
        }
      } catch {
        label = `\`${channelId}\``;
      }
    }
    channelLine = `📺 File channel: ${label} ✅`;
  }

  return (
    `📊 *Dashboard*\n\n` +
    `${channelLine}\n` +
    `🎬 Media in bot: *${mediaCount}*\n` +
    `📦 Active packages: *${pkgCount}*\n` +
    `👥 Total users: *${userCount}*\n` +
    `👤 Total admins: *${adminCount}*`
  );
}

module.exports = { buildAdminStats };
