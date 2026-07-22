const Media    = require('../models/Media');
const Settings = require('../models/Settings');
const adminCache = require('../cache');
const { enqueue } = require('../services/queue');
const { mirrorChannelPost } = require('../services/advertisedRelay');

module.exports = (bot) => {
  bot.on('channel_post', async (ctx) => {
    try {
      const post      = ctx.channelPost;
      const channelId = post.chat.id.toString();

      const configured = await Settings.get('fileManagerChannel');
      if (!configured || channelId !== configured.toString()) return;

      // Only handle photo and video — ignore everything else silently
      let fileId, fileType;
      if (post.photo?.length) {
        fileId   = post.photo[post.photo.length - 1].file_id;
        fileType = 'photo';
      } else if (post.video?.file_id) {
        fileId   = post.video.file_id;
        fileType = 'video';
      } else {
        return;
      }

      await Media.create({
        fileId,
        fileType,
        channelMessageId: post.message_id,
        channelId,
      });

      mirrorChannelPost(bot.telegram, { channelId, messageId: post.message_id });

      const total = await Media.countDocuments();

      const emoji = fileType === 'photo' ? '📷' : '🎬';
      const msg   = `${emoji} New media added.\nType: ${fileType} | Total: ${total}`;

      // Notify all admins — error handling is inside the queued fn so queue
      // reject event is never triggered by unreachable admins
      const admins = adminCache.getAll().filter((a) => a.telegramId);
      for (const admin of admins) {
        enqueue(async () => {
          try {
            await bot.telegram.sendMessage(admin.telegramId, msg);
          } catch { /* ignore unreachable admins */ }
        });
      }
    } catch (err) {
      console.error('[channel_post handler]', err.message);
    }
  });
};
