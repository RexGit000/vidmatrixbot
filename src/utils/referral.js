const { POINTS_PER_MEDIA } = require('../constants');

const REFERRAL_TIERS = [
  { id: 'bronze',   name: 'Bronze',   emoji: '🥉', invites: 2,   reward: 10   },
  { id: 'silver',   name: 'Silver',   emoji: '🥈', invites: 5,   reward: 25   },
  { id: 'gold',     name: 'Gold',     emoji: '🥇', invites: 10,  reward: 50   },
  { id: 'diamond',  name: 'Diamond',  emoji: '💎', invites: 25,  reward: 125  },
  { id: 'crystal',  name: 'Crystal',  emoji: '🔷', invites: 50,  reward: 250  },
  { id: 'champion', name: 'Champion', emoji: '👑', invites: 100, reward: 500  },
  { id: 'legend',   name: 'Legend',   emoji: '🔥', invites: 200, reward: 1000 },
];

function getCurrentTier(inviteCount) {
  let current = null;
  for (const tier of REFERRAL_TIERS) {
    if (inviteCount >= tier.invites) current = tier;
    else break;
  }
  return current;
}

function getNextTier(inviteCount) {
  return REFERRAL_TIERS.find((t) => t.invites > inviteCount) || null;
}

// Awards newly unlocked tiers to the user. Mutates user.points and user.claimedTiers.
// Returns array of newly unlocked tiers.
function checkAndAwardTiers(user) {
  if (!user.claimedTiers) user.claimedTiers = [];
  const claimed = new Set(user.claimedTiers);
  const newlyUnlocked = [];

  for (const tier of REFERRAL_TIERS) {
    if (user.inviteCount >= tier.invites && !claimed.has(tier.id)) {
      newlyUnlocked.push(tier);
      user.claimedTiers.push(tier.id);
      user.points = (user.points || 0) + tier.reward * POINTS_PER_MEDIA;
    }
  }

  return newlyUnlocked;
}

function buildTiersList() {
  return REFERRAL_TIERS
    .map((t) => `└ ${t.emoji} ${t.invites} invites = ${t.reward} free videos`)
    .join('\n');
}

module.exports = { REFERRAL_TIERS, getCurrentTier, getNextTier, checkAndAwardTiers, buildTiersList };
