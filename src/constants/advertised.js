/**
 * Five advertised channels (private). Each entry has Bot API chat id and alternate invite links.
 * Override via ADVERTISED_CHANNEL_IDS in .env (comma-separated, same order).
 */
const ADVERTISED_CHANNELS = [
  {
    name: '💖Spicy Adults🔞💦',
    id: '-1003815431984',
    inviteLinks: [
      'https://t.me/+HZubUSzoY54zODBk',
      'https://t.me/+6CoASZDsauUxMWJk',
      'https://t.me/+-vwYZdAjH_Y3NGZk',
    ],
  },
  {
    name: '🎉💋 Sexy Body 🍆',
    id: '-1003384263165',
    inviteLinks: [
      'https://t.me/+JXU8To7RAA02ZTQ8',
      'https://t.me/+a-kmGFQjKVRjZjc0',
      'https://t.me/+SPz3iZY_hV9lODY0',
    ],
  },
  {
    name: 'Juicy Desires 🎉👙💦',
    id: '-1003925770556',
    inviteLinks: [
      'https://t.me/+6DOiVD4WFNY4ZWJk',
      'https://t.me/+MAxpIVjWPSQ2OGY0',
      'https://t.me/+klAHwPY3IzlkMjRk',
    ],
  },
  {
    name: '🥵 Hot Baddies 👙💦',
    id: '-1003989148295',
    inviteLinks: [
      'https://t.me/+kizJn4a_4UM1ODY8',
      'https://t.me/+dzaQ6brbuw5mMmE0',
      'https://t.me/+68t2XADzxrY5MTNk',
    ],
  },
  {
    name: '🥹🍆Lovely Babies💧',
    id: '-1003913997868',
    inviteLinks: [
      'https://t.me/+8AO4nCIqE101Nzlk',
      'https://t.me/+41tphR-yeQk0Yzhk',
      'https://t.me/+t12_SIXP5ggxNmNk',
    ],
  },
];

const DEFAULT_ADVERTISED_CHANNEL_IDS = ADVERTISED_CHANNELS.map((c) => c.id);

function parseAdvertisedChannelIds() {
  const raw = process.env.ADVERTISED_CHANNEL_IDS || '';
  const fromEnv = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_ADVERTISED_CHANNEL_IDS;
}

module.exports = {
  ADVERTISED_CHANNELS,
  DEFAULT_ADVERTISED_CHANNEL_IDS,
  parseAdvertisedChannelIds,
};
