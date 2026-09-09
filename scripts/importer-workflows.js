#!/usr/bin/env node
/**
 * Importe les workflows dans n8n par son API publique.
 *
 * Remplace les douze imports manuels par une commande, et refait le seul
 * relien que l'import par fichier ne sait pas faire : le lien de WF-7 vers
 * WF-5, que n8n référence par identifiant interne.
 *
 * Le script est idempotent : relancé, il met à jour les workflows existants
 * au lieu d'en créer des doublons. C'est ce qui permet de le rejouer après
 * chaque `npm run n8n:build`.
 *
 *   export N8N_URL=https://n8n.example.fr
 *   export N8N_API_KEY=...          # n8n → Settings → API → Create an API key
 *   node scripts/importer-workflows.js --essai     # montre sans rien écrire
 *   node scripts/importer-workflows.js
 *
 * La clé ne quitte jamais ta machine : le script parle directement à ton
 * n8n, sans intermédiaire.
 *
 * Ce qu'il ne fait PAS, volontairement :
 *   — il n'active aucun workflow. L'activation est une décision, et la
 *     procédure la place en toute fin (docs/INSTALLATION.md, étape 11) ;
 *   — il ne rattache aucun identifiant. L'API publique de n8n ne sait pas
 *     lister les identifiants existants, donc ça reste manuel.
 */

const fs = require('node:fs');
const path = require('node:path');

const DOSSIER = path.join(__dirname, '..', 'n8n', 'workflows');

/**
 * Ordre d'import. WF-5 doit exister avant WF-7, qui l'appelle.
 * Le reste de l'ordre suit la procédure d'installation.
 */
const ORDRE = [
  'wf3-eligibilite.json',
  'wf4-creneaux.json',
  'wf5-demande-pieces.json',
  'wf1-tri-boite-generale.json',
  'wf2-sequence-demarrage.json',
  'wf2bis-sequence-reponses.json',
  'wf2ter-emission-sms.json',
  'wf2quater-expiration-relance.json',
  'wf5bis-recapitulatif-telegram.json',
  'wf6-controle.json',
  'wf8-arbitrages-en-attente.json',
  'wf7-telegram-commandes.json',
];

/**
 * L'API refuse tout champ qu'elle ne connaît pas — « request/body must NOT
 * have additional properties ». Les fichiers portent `tags`, `pinData` et
 * `meta` pour l'import par l'interface : ils sont retirés ici.
 */
const CHAMPS_ACCEPTES = ['name', 'nodes', 'connections', 'settings'];

function corpsWorkflow(workflow) {
  const corps = {};
  for (const champ of CHAMPS_ACCEPTES) {
    if (workflow[champ] !== undefined) corps[champ] = workflow[champ];
  }
  return corps;
}

/** Le node de WF-7 qui appelle WF-5, s'il est présent. */
function noeudSousWorkflow(workflow) {
  return (workflow.nodes || []).find((n) => n.type === 'n8n-nodes-base.executeWorkflow') || null;
}

/**
 * Remplace le nom du sous-workflow par son identifiant réel.
 *
 * Le fichier exporté porte le NOM de WF-5, parce que son identifiant n8n
 * n'existe pas avant l'import. C'est ce qui oblige, après un import par
 * l'interface, à rouvrir le node et à re-sélectionner le workflow.
 */
function relier(workflow, identifiants) {
  const noeud = noeudSousWorkflow(workflow);
  if (!noeud) return false;

  const cible = noeud.parameters.workflowId;
  const identifiant = identifiants.get(cible.cachedResultName || cible.value);
  if (!identifiant || cible.value === identifiant) return false;

  noeud.parameters.workflowId = {
    __rl: true,
    value: identifiant,
    mode: 'list',
    cachedResultName: cible.cachedResultName || cible.value,
  };
  return true;
}

function creerClient({ url, cle, fetchImpl = fetch }) {
  const base = String(url).replace(/\/+$/, '');

  return async function appeler(chemin, options = {}) {
    const reponse = await fetchImpl(`${base}/api/v1${chemin}`, {
      ...options,
      headers: {
        'X-N8N-API-KEY': cle,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    const texte = await reponse.text();
    if (!reponse.ok) {
      // Le corps porte le motif exact du refus : on le remonte tel quel.
      throw new Error(`${options.method || 'GET'} ${chemin} → HTTP ${reponse.status} ${texte.slice(0, 400)}`);
    }
    return texte ? JSON.parse(texte) : null;
  };
}

/** Nom → identifiant, pour savoir quoi créer et quoi mettre à jour. */
async function inventaire(appeler) {
  const connus = new Map();
  let curseur = null;

  do {
    const page = await appeler(`/workflows?limit=100${curseur ? `&cursor=${curseur}` : ''}`);
    for (const w of page.data || []) connus.set(w.name, w.id);
    curseur = page.nextCursor || null;
  } while (curseur);

  return connus;
}

async function importer({ url, cle, essai = false, journal = console.log, fetchImpl = fetch }) {
  const appeler = creerClient({ url, cle, fetchImpl });
  const connus = essai ? new Map() : await inventaire(appeler);
  const resultats = [];

  for (const fichier of ORDRE) {
    const chemin = path.join(DOSSIER, fichier);
    if (!fs.existsSync(chemin)) {
      throw new Error(`${fichier} est absent — lancer d'abord : npm run n8n:build`);
    }

    const workflow = JSON.parse(fs.readFileSync(chemin, 'utf8'));
    const relie = relier(workflow, connus);
    const existant = connus.get(workflow.name);
    const action = existant ? 'mis à jour' : 'créé';

    if (!essai) {
      const reponse = await appeler(
        existant ? `/workflows/${existant}` : '/workflows',
        { method: existant ? 'PUT' : 'POST', body: JSON.stringify(corpsWorkflow(workflow)) },
      );
      connus.set(workflow.name, reponse.id);
    }

    resultats.push({ fichier, nom: workflow.name, action, relie });
    journal(
      `${essai ? '[essai] ' : ''}${workflow.name.padEnd(44)} ${action}${relie ? ' + lien vers le sous-workflow rétabli' : ''}`,
    );
  }

  return resultats;
}

async function main() {
  const essai = process.argv.includes('--essai') || process.argv.includes('--dry-run');
  const url = process.env.N8N_URL;
  const cle = process.env.N8N_API_KEY;

  if (!essai && (!url || !cle)) {
    process.stderr.write(
      'N8N_URL et N8N_API_KEY sont requis.\n' +
      '  export N8N_URL=https://n8n.example.fr\n' +
      '  export N8N_API_KEY=...   (n8n → Settings → API → Create an API key)\n\n' +
      'Pour voir ce que le script ferait, sans rien écrire :\n' +
      '  node scripts/importer-workflows.js --essai\n',
    );
    process.exit(1);
  }

  const resultats = await importer({ url, cle, essai });

  process.stdout.write(`\n${resultats.length} workflows traités.\n`);
  if (essai) {
    process.stdout.write('Aucune écriture : relance sans --essai pour importer.\n');
    return;
  }
  process.stdout.write(
    '\nIl reste à faire à la main :\n' +
    '  1. rattacher les identifiants (Postgres, Twilio, Telegram, Google, SMTP)\n' +
    '  2. renseigner le node « Paramètres » de chaque workflow\n' +
    '  3. activer les workflows, en dernier — voir docs/INSTALLATION.md étape 11\n',
  );
}

if (require.main === module) {
  main().catch((erreur) => {
    process.stderr.write(`${erreur.message}\n`);
    process.exit(1);
  });
}

module.exports = { importer, corpsWorkflow, relier, noeudSousWorkflow, ORDRE, CHAMPS_ACCEPTES };
