const addAdminScene    = require('./addAdmin');
const removeAdminScene = require('./removeAdmin');
const setChannelScene  = require('./setChannel');
const setUpdatesChannelScene = require('./setUpdatesChannel');
const broadcastScene   = require('./broadcast');
const editPackageScene = require('./editPackage');
const giftMediaScene   = require('./giftMedia');
const userbotLoginScene = require('./userbotLogin');

module.exports = [
  addAdminScene,
  removeAdminScene,
  setChannelScene,
  setUpdatesChannelScene,
  broadcastScene,
  editPackageScene,
  giftMediaScene,
  userbotLoginScene,
];
