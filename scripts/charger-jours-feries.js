#!/usr/bin/env node
/**
 * Alimente la table `locatif.jours_feries` depuis l'API Etalab.
 *
 * À lancer une fois par an — pas à chaque calcul. L'API est gratuite et
 * sans clé, et ne reçoit évidemment aucune donnée candidat.
 *
 *   node scripts/charger-jours-feries.js            # affiche le SQL
 *   node scripts/charger-jours-feries.js | psql -d era_loyers
 */

const { API_JOURS_FERIES } = require('../src/config');

async function main() {
  const reponse = await fetch(API_JOURS_FERIES, { headers: { Accept: 'application/json' } });
  if (!reponse.ok) {
    throw new Error(`API jours fériés : HTTP ${reponse.status}`);
  }
  const feries = await reponse.json();
  const lignes = Object.entries(feries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([jour, libelle]) => `  ('${jour}', ${quote(libelle)})`);

  process.stdout.write(
    `-- Généré le ${new Date().toISOString().slice(0, 10)} depuis ${API_JOURS_FERIES}\n` +
    'INSERT INTO locatif.jours_feries (jour, libelle) VALUES\n' +
    `${lignes.join(',\n')}\n` +
    'ON CONFLICT (jour) DO UPDATE SET libelle = EXCLUDED.libelle;\n',
  );
}

function quote(texte) {
  return `'${String(texte).replace(/'/g, "''")}'`;
}

main().catch((erreur) => {
  process.stderr.write(`${erreur.message}\n`);
  process.exit(1);
});
