const Admin = require('../models/Admin');
const adminCache = require('../cache');

module.exports = async (ctx, next) => {
  if (!ctx.from) return next();

  const { id, username } = ctx.from;

  // Reload from DB if cache is empty (server started before seeding)
  if (adminCache.getAll().length === 0) {
    try {
      const all = await Admin.find().lean();
      adminCache.set(all);
    } catch (err) {
      console.error('[auth middleware] cache reload error:', err);
    }
  }

  ctx.state.isAdmin      = adminCache.isAdmin(id, username);
  ctx.state.isSuperAdmin = adminCache.isSuperAdmin(id, username);

  // If this admin was stored by username only, backfill their telegramId
  if (ctx.state.isAdmin && username) {
    try {
      const doc = await Admin.findOne({ username: `@${username}`, telegramId: null });
      if (doc) {
        doc.telegramId = id;
        await doc.save();
        const all = await Admin.find().lean();
        adminCache.set(all);
      }
    } catch (err) {
      console.error('[auth middleware] backfill error:', err);
    }
  }

  return next();
};
