const Media    = require('../models/Media');
const Settings = require('../models/Settings');
const { adminCache } = require('../cache');
const { enqueue } = require('../services/queue');
const { mirrorChannelPost } = require('../services/advertisedRelay');

const BOT_KEY = String(process.env.CURRENT_BOT_KEY || (process.env.BOT_TOKEN || '').split(':')[0] || 'default').trim();

module.exports = (bot) => {
  bot.on('channel_post', async (ctx) => {
    try {
      const post      = ctx.channelPost;
      const channelId = post.chat.id.toString();

      const configured = await Settings.get('fileManagerChannel');
      if (!configured || channelId !== configured.toString()) return;

      let fileId, fileType, file_unique_id, mime_type = '', file_name = '', file_size = 0;

      if (post.photo && post.photo.length) {
        const photo = post.photo[post.photo.length - 1];
        fileId   = photo.file_id;
        fileType = 'photo';
        file_unique_id = photo.file_unique_id || undefined;
        file_size = photo.file_size || 0;
      } else if (post.video && post.video.file_id) {
        fileId   = post.video.file_id;
        fileType = 'video';
        file_unique_id = post.video.file_unique_id || undefined;
        mime_type = post.video.mime_type || '';
        file_name = post.video.file_name || '';
        file_size = post.video.file_size || 0;
      } else if (post.document && post.document.file_id) {
        fileId   = post.document.file_id;
        fileType = 'document';
        file_unique_id = post.document.file_unique_id || undefined;
        mime_type = post.document.mime_type || '';
        file_name = post.document.file_name || '';
        file_size = post.document.file_size || 0;
      } else {
        return;
      }

      const uploaded_at = post.date ? new Date(post.date * 1000) : new Date();

      const bot_file_ids = {};
      bot_file_ids[BOT_KEY] = fileId;

      const doc = await Media.create({
        source: {
          channel_id: channelId,
          message_id: post.message_id,
        },
        metadata: {
          kind: fileType,
          mime_type,
          file_name,
          file_size,
          uploaded_at,
        },
        bot_file_ids,
        file_unique_id: file_unique_id || undefined,
        last_seen_at: new Date(),
      });

      mirrorChannelPost(bot.telegram, { channelId, messageId: post.message_id });

      const total = await Media.countDocuments();

      const emojiMap = { photo: '📷', video: '🎬', document: '📄' };
      const emoji = emojiMap[fileType] || '📦';
      const msg   = `${emoji} New media added.\nType: ${fileType} | Total: ${total}`;

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
