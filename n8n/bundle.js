/**
 * Empaquetage des modules `src/` pour les nodes Code de n8n.
 *
 * Le bac à sable des nodes Code n'autorise pas `require` sur le système de
 * fichiers, sauf à ouvrir NODE_FUNCTION_ALLOW_EXTERNAL et à monter le
 * répertoire dans le conteneur. On préfère un paquet auto-porteur : les
 * workflows exportés s'importent tels quels, sur n'importe quelle instance,
 * sans variable d'environnement ni volume.
 *
 * La contrepartie est une duplication du code dans quelques nodes. Elle est
 * assumée parce qu'elle est générée : `npm run n8n:build` régénère les
 * workflows depuis `src/`, et `npm test` vérifie qu'ils sont à jour.
 */

const fs = require('node:fs');
const path = require('node:path');

const RACINE = path.join(__dirname, '..', 'src');

/** Ordre sans importance : la résolution est paresseuse, comme dans Node. */
const MODULES = [
  'config', 'temps', 'calendrier', 'geo', 'immoagenda',
  'eligibilite', 'parsing', 'messages', 'creneaux', 'sequence',
  'justificatifs', 'index',
];

/**
 * Construit le paquet, exposé sous le nom `ERA`.
 *
 * On reproduit le minimum du chargeur CommonJS : un registre de fabriques,
 * un cache posé AVANT l'exécution du module (sans quoi le moindre cycle
 * boucle à l'infini), et une normalisation des chemins './x.js' → 'x'.
 */
function construireSocle() {
  const fabriques = MODULES.map((nom) => {
    const source = fs.readFileSync(path.join(RACINE, `${nom}.js`), 'utf8');
    return `__d[${JSON.stringify(nom)}] = function (module, exports, require) {\n${source}\n};`;
  });

  return [
    '// ===== Socle ERA — généré par n8n/bundle.js, ne pas modifier ici =====',
    '// Régénérer avec : npm run n8n:build',
    'const ERA = (function () {',
    '  const __d = {};',
    '  const __c = {};',
    '  function __require(id) {',
    "    const cle = String(id).replace(/^\\.\\//, '').replace(/\\.js$/, '');",
    '    if (__c[cle]) return __c[cle].exports;',
    '    if (!__d[cle]) throw new Error("Module absent du socle : " + id);',
    '    const module = { exports: {} };',
    '    __c[cle] = module;',
    '    __d[cle](module, module.exports, __require);',
    '    return module.exports;',
    '  }',
    ...fabriques.map((f) => `  ${f}`),
    "  return __require('index');",
    '})();',
    '// ===== Fin du socle ERA =====',
  ].join('\n');
}

/** Empreinte du socle, pour détecter une régénération oubliée. */
function empreinte(socle) {
  return require('node:crypto').createHash('sha256').update(socle).digest('hex').slice(0, 12);
}

module.exports = { construireSocle, empreinte, MODULES };
