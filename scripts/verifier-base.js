#!/usr/bin/env node
/**
 * Vérifie que le schéma et les requêtes des workflows tiennent, sur une
 * vraie base PostgreSQL.
 *
 * Trois contrôles, dans cet ordre :
 *   1. les trois fichiers de `db/` s'appliquent sans erreur, et sont
 *      rejouables — ils sont tous en IF NOT EXISTS ;
 *   2. les 21 requêtes des workflows se PRÉPARENT : la syntaxe, les noms de
 *      tables et de colonnes, et les types des paramètres sont vérifiés par
 *      PostgreSQL lui-même, sans rien exécuter ;
 *   3. les lignes que produisent les nodes Code correspondent, clé par clé,
 *      à de vraies colonnes — c'est le mode d'échec des nodes Postgres en
 *      « autoMapInputData », qui n'apparaît qu'à l'exécution.
 *
 *   node scripts/verifier-base.js --base era_verif
 *   SOCKET=1 node scripts/verifier-base.js --base era_verif   # via postgres
 *
 * À lancer sur une base JETABLE : le premier contrôle écrit le schéma.
 * Sur ta base de production, il ne ferait que recréer ce qui existe déjà,
 * mais autant ne pas prendre l'habitude.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RACINE = path.join(__dirname, '..');
const MIGRATIONS = ['db/schema.sql', 'db/002-file-sms.sql', 'db/003-arbitrage.sql'];

function options() {
  const i = process.argv.indexOf('--base');
  const base = i > -1 ? process.argv[i + 1] : process.env.PGDATABASE;
  if (!base) {
    process.stderr.write(
      'Nom de base requis :\n  node scripts/verifier-base.js --base era_verif\n\n' +
      'Utilise une base jetable : le contrôle écrit le schéma.\n',
    );
    process.exit(1);
  }
  return { base, verbeux: process.argv.includes('--verbeux') };
}

/**
 * SOCKET=1 passe par « sudo -u postgres », sur la socket unix : c'est le
 * seul chemin qui marche sur une installation Debian par défaut, où root
 * n'a aucun rôle PostgreSQL.
 */
function psql(base, sql) {
  const arguments_ = ['-d', base, '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-f', '-'];
  const [commande, tous] = process.env.SOCKET === '1'
    ? ['sudo', ['-u', 'postgres', 'psql', ...arguments_]]
    : ['psql', arguments_];

  return execFileSync(commande, tous, {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Toutes les requêtes libres des workflows, avec leur provenance. */
function requetes() {
  const dossier = path.join(RACINE, 'n8n', 'workflows');
  const sortie = [];
  for (const fichier of fs.readdirSync(dossier).sort()) {
    const workflow = JSON.parse(fs.readFileSync(path.join(dossier, fichier), 'utf8'));
    for (const noeud of workflow.nodes) {
      if (noeud.type !== 'n8n-nodes-base.postgres') continue;
      if (noeud.parameters.operation !== 'executeQuery') continue;
      sortie.push({
        origine: `${fichier.replace('.json', '')} / ${noeud.name}`,
        sql: noeud.parameters.query.trim().replace(/;$/, ''),
      });
    }
  }
  return sortie;
}

/** Tables et colonnes réellement présentes dans le schéma `locatif`. */
function colonnes(base) {
  const lignes = psql(
    base,
    "SELECT table_name || '|' || column_name FROM information_schema.columns WHERE table_schema = 'locatif';",
  ).trim().split('\n').filter(Boolean);

  const parTable = {};
  for (const ligne of lignes) {
    const [table, colonne] = ligne.split('|');
    (parTable[table] = parTable[table] || new Set()).add(colonne);
  }
  return parTable;
}

/**
 * Les tables visées par les nodes d'écriture, et les champs qu'ils
 * reçoivent. La correspondance est tenue à la main parce qu'elle est
 * courte et qu'elle vaut mieux qu'une inférence fragile.
 */
const ECRITURES = [
  ['candidats', ['id', 'etape_sms', 'statut', 'echecs_parsing', 'situation', 'duree_contrat_mois',
    'garantie', 'nb_cautions', 'revenus_cautions', 'visale_visa_obtenu', 'visale_montant_visa',
    'revenus_nets', 'revenus_complementaires', 'couple', 'verdict', 'motif', 'capacite_loyer',
    'arbitrage_depuis', 'nb_relances', 'relances_arbitrage', 'source', 'nom', 'mobile', 'email',
    'ref_lot', 'purge_le']],
  ['file_sms', ['candidat_id', 'mobile', 'texte', 'type_message', 'envoyer_apres']],
  ['creneaux_reserves', ['candidat_id', 'ref_lot', 'debut', 'fin', 'reserve_jusqu_a', 'rang', 'confirme']],
  ['refus_log', ['ref_lot', 'commune', 'loyer_cc', 'type_lot', 'situation', 'garantie', 'verdict',
    'motif', 'ecart_seuil']],
  ['lots', ['reference', 'commune', 'code_postal', 'type_lot', 'loyer_cc', 'accepte_visale',
    'latitude', 'longitude', 'statut']],
  ['absences', ['debut', 'fin', 'chat_id_suppleant']],
];

function main() {
  const { base, verbeux } = options();
  let ecarts = 0;
  const dire = (etat, texte) => process.stdout.write(`${etat.padEnd(6)}${texte}\n`);

  // --- 1. les migrations, appliquées deux fois pour prouver l'idempotence
  for (const passe of ['première', 'seconde']) {
    for (const migration of MIGRATIONS) {
      try {
        psql(base, fs.readFileSync(path.join(RACINE, migration), 'utf8'));
      } catch (erreur) {
        ecarts += 1;
        dire('ÉCHEC', `${migration} (${passe} passe)`);
        process.stdout.write(`      ${String(erreur.stderr || erreur.message).trim().split('\n')[0]}\n`);
      }
    }
  }
  if (!ecarts) dire('OK', `${MIGRATIONS.length} migrations, appliquées deux fois — rejouables`);

  // --- 2. les requêtes des workflows
  const toutes = requetes();
  let mauvaises = 0;
  toutes.forEach((requete, index) => {
    try {
      psql(base, `PREPARE verif_${index} AS\n${requete.sql};`);
      if (verbeux) dire('OK', requete.origine);
    } catch (erreur) {
      mauvaises += 1;
      ecarts += 1;
      dire('ÉCHEC', requete.origine);
      const detail = String(erreur.stderr || erreur.message).split('\n').filter((l) => /ERROR|LINE/.test(l));
      process.stdout.write(detail.slice(0, 2).map((l) => `      ${l.trim()}\n`).join(''));
    }
  });
  if (!mauvaises) dire('OK', `${toutes.length} requêtes de workflow préparées par PostgreSQL`);

  // --- 3. les colonnes attendues par les nodes d'écriture
  const presentes = colonnes(base);
  for (const [table, champs] of ECRITURES) {
    const absentes = champs.filter((c) => !presentes[table] || !presentes[table].has(c));
    if (absentes.length) {
      ecarts += 1;
      dire('ÉCHEC', `${table} : colonnes absentes — ${absentes.join(', ')}`);
    } else if (verbeux) {
      dire('OK', `${table} : ${champs.length} colonnes`);
    }
  }
  if (!ECRITURES.some(([t, c]) => c.some((x) => !presentes[t] || !presentes[t].has(x)))) {
    dire('OK', `${ECRITURES.length} tables d'écriture, toutes les colonnes présentes`);
  }

  process.stdout.write(ecarts ? `\n${ecarts} écart(s).\n` : '\nSchéma et requêtes conformes.\n');
  process.exit(ecarts ? 1 : 0);
}

if (require.main === module) main();
module.exports = { requetes, ECRITURES, MIGRATIONS };
