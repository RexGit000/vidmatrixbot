const botState = require('../services/botState');

module.exports = (ctx, next) => {
  if (!botState.get() && !ctx.state.isAdmin) return;
  return next();
};
