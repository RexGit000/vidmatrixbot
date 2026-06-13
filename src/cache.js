// In-memory admin cache — reloaded on every server start
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
};

module.exports = adminCache;
