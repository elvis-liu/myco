const gemini = require('./gemini');
const codex = require('./codex');
const custom = require('./custom');

const critics = {
  gemini,
  codex,
  custom
};

function getCritic(id) {
  const normalizedId = (id || '').toLowerCase().trim();
  return critics[normalizedId] || gemini;
}

module.exports = {
  getCritic,
  critics: Object.values(critics)
};
