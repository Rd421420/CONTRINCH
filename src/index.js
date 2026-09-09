/**
 * Point d'entrée unique — c'est ce que les nodes Code de n8n requièrent.
 *
 *   const { evaluer } = require('/data/era/src');
 *   return items.map((i) => ({ json: { ...i.json, ...evaluer(i.json) } }));
 */

module.exports = {
  config: require('./config'),
  temps: require('./temps'),
  calendrier: require('./calendrier'),
  geo: require('./geo'),
  immoagenda: require('./immoagenda'),
  parsing: require('./parsing'),
  messages: require('./messages'),
  creneaux: require('./creneaux'),
  sequence: require('./sequence'),
  ...require('./eligibilite'),
};
