const { LRUCache } = require('lru-cache');

let admins = [];

const adminCache = {
  set(list) {
    admins = list;
  },

  getAll() {
    return admins;
  },

  isAdmin(telegramId, username) {
    return admins.some((a) => {
      if (telegramId && a.telegramId === telegramId) return true;
      if (username && a.username) {
        return a.username.toLowerCase() === `@${username}`.toLowerCase();
      }
      return false;
    });
  },

  isSuperAdmin(telegramId, username) {
    return admins.some((a) => {
      if (!a.isSuperAdmin) return false;
      if (telegramId && a.telegramId === telegramId) return true;
      if (username && a.username) {
        return a.username.toLowerCase() === `@${username}`.toLowerCase();
      }
      return false;
    });
  },

  add(admin) {
    admins.push(admin);
  },

  removeById(telegramId) {
    admins = admins.filter((a) => a.telegramId !== telegramId);
  },

  removeByUsername(username) {
    const normalized = username.toLowerCase();
    admins = admins.filter(
      (a) => !a.username || a.username.toLowerCase() !== normalized
    );
  },

  getAllSuperAdminIds() {
    return admins
      .filter((a) => a.isSuperAdmin && a.telegramId)
      .map((a) => Number(a.telegramId))
      .filter((n) => Number.isFinite(n));
  },
};

const deliveryCache = new LRUCache({
  max: 2000,
  ttl: 1000 * 60 * 60 * 4,
  updateAgeOnGet: true,
});

module.exports = { adminCache, deliveryCache };
