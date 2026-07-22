const { parseAdvertisedChannelIds } = require('../constants/advertised');
const { enqueue } = require('./queue');

/**
 * Silently copy a file-manager channel post into each configured advertised channel.
 * This project's bot must be able to post in the file channel and each destination.
 */
function mirrorChannelPost(telegram, { channelId, messageId }) {
  const destIds = parseAdvertisedChannelIds();
  if (!destIds.length) return;

  const silent = { disable_notification: true };

  for (const destId of destIds) {
    enqueue(async () => {
      try {
        await telegram.copyMessage(destId, channelId, messageId, silent);
      } catch (err) {
        console.error('[advertisedRelay] copy failed:', destId, err.message);
      }
    });
  }
}

module.exports = { mirrorChannelPost };
