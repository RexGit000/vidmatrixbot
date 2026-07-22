let enabled = true;

module.exports = {
  get: () => enabled,
  set: (v) => { enabled = Boolean(v); },
};
