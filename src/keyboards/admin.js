const { Markup } = require('telegraf');
const botState   = require('../services/botState');

function mainAdminKeyboard() {
  const toggleBtn = botState.get() ? '🔴 Disable Bot' : '🟢 Enable Bot';
  return Markup.keyboard([
    ['📁 Media Management', '👥 Admin Management'],
    ['📢 Broadcast',        '📦 Package Settings'],
    ['📺 File Channel',     '📢 Updates Channel'],
    ['📋 User List',        '🎁 Gift Media'],
    [toggleBtn],
    ['👤 Switch to User View'],
  ]).resize();
}

function cancelKeyboard() {
  return Markup.keyboard([['❌ Cancel']]).resize();
}

function mediaManageKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📋 List Media',  'media_list:0')],
    [Markup.button.callback('🗑 Delete Media', 'media_list:0')],
    [Markup.button.callback('📊 Total Count', 'media_count')],
  ]);
}

function adminManageKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Add Admin',   'admin_add')],
    [Markup.button.callback('➖ Remove Admin', 'admin_remove')],
    [Markup.button.callback('📋 List Admins', 'admin_list')],
  ]);
}

module.exports = {
  mainAdminKeyboard,
  cancelKeyboard,
  mediaManageKeyboard,
  adminManageKeyboard,
};
