/**
 * WF-7 · Commandes Telegram.
 *
 * Un seul déclencheur Telegram pour tout le dispositif : deux workflows qui
 * écoutent le même jeton se volent les mises à jour. Toutes les commandes
 * passent donc par ici.
 *
 *   /lot 12345 Bompas T3 780 visale-ok
 *   /loue 12345
 *   /pieces 42
 *
 * La table `lots` ne contient pas le portefeuille, seulement les biens
 * disponibles : une poignée de lignes, saisies au moment du préavis, dans
 * un geste déjà fait.
 */

const { fabrique, noeudParametres } = require('../lib');

const LIRE = `// Analyse positionnelle tolérante : la commune peut tenir en plusieurs
// mots (« Le Soler »), et les drapeaux se placent librement en fin de ligne.
const parametres = $('Paramètres').first().json;
const message = $input.first().json.message || {};
const texte = String(message.text || '').trim();
const chat_id = String((message.chat && message.chat.id) || parametres.chat_id);

function repondre(contenu) {
  return [{ json: { __action: 'reponse', chat_id, texte: contenu } }];
}

const AIDE = [
  '<b>Lots</b>',
  '/lot RÉF COMMUNE TYPE LOYER [visale-ok] [zone1|zone2|zone3]',
  '   ex. <code>/lot 12345 Le Soler T3 780 visale-ok zone3</code>',
  '/loue RÉF — sort le bien de la liste des disponibles',
  '',
  '<b>Dossiers</b>',
  '/traite ID — clôt un arbitrage : seul moyen d’arrêter les rappels',
  '/pieces ID — envoie la demande de pièces au candidat retenu',
  '',
  '<b>Absence</b>',
  '/absence AAAA-MM-JJ AAAA-MM-JJ [chat suppléant]',
  '/retour — met fin à l’absence en cours',
].join('\\n');

if (/^\\/(aide|help|start)/i.test(texte)) return repondre(AIDE);

const loue = texte.match(/^\\/loue\\s+(\\S+)/i);
if (loue) return [{ json: { __action: 'loue', chat_id, reference: loue[1] } }];

const pieces = texte.match(/^\\/pieces\\s+(\\d+)/i);
if (pieces) return [{ json: { __action: 'pieces', chat_id, candidat_id: Number(pieces[1]) } }];

// Clôture d'un arbitrage. C'est la SEULE chose qui arrête les rappels
// quotidiens de WF-8 — un dossier qu'on oublie de clore reste bruyant.
const traite = texte.match(/^\\/traite\\s+(\\d+)/i);
if (traite) return [{ json: { __action: 'traite', chat_id, candidat_id: Number(traite[1]) } }];

if (/^\\/retour\\b/i.test(texte)) return [{ json: { __action: 'retour', chat_id } }];

const absence = texte.match(/^\\/absence\\s+(\\d{4}-\\d{2}-\\d{2})\\s+(\\d{4}-\\d{2}-\\d{2})(?:\\s+(\\S+))?/i);
if (absence) {
  if (absence[2] < absence[1]) return repondre('La date de fin précède la date de début.');
  return [{
    json: {
      __action: 'absence',
      chat_id,
      debut: absence[1],
      fin: absence[2],
      // Sans suppléant, le dispositif ne s'arrête pas pour autant : les
      // candidats reçoivent simplement leur mot d'attente plus tôt.
      chat_id_suppleant: absence[3] || null,
    },
  }];
}
if (/^\\/absence\\b/i.test(texte)) return repondre('Format : /absence AAAA-MM-JJ AAAA-MM-JJ [chat suppléant]');

const lot = texte.match(/^\\/lot\\s+(.+)$/i);
if (!lot) return repondre(AIDE);

const mots = lot[1].trim().split(/\\s+/);
const reference = mots.shift();

const drapeaux = [];
while (mots.length && /^(visale-ok|visale-non|zone[123])$/i.test(mots[mots.length - 1])) {
  drapeaux.push(mots.pop().toLowerCase());
}

const indexType = mots.findIndex((m) => /^T\\d$/i.test(m));
if (indexType < 0 || !mots[indexType + 1]) {
  return repondre('Format attendu : /lot RÉF COMMUNE TYPE LOYER [visale-ok]\\n' + AIDE);
}

const commune = mots.slice(0, indexType).join(' ');
const type_lot = mots[indexType].toUpperCase();
const loyer_cc = Number(String(mots[indexType + 1]).replace(',', '.'));

if (!commune || !Number.isFinite(loyer_cc)) {
  return repondre('Commune ou loyer illisible.\\n' + AIDE);
}

const zone = drapeaux.find((d) => /^zone[123]$/.test(d));

return [{
  json: {
    __action: 'lot',
    chat_id,
    reference,
    commune,
    type_lot,
    loyer_cc,
    // Sans ce champ, le système proposerait Visale sur des lots où le
    // propriétaire a pris la GLI — les deux ne se cumulent pas.
    accepte_visale: drapeaux.includes('visale-ok'),
    zone_visale: zone ? Number(zone.slice(4)) : null,
  },
}];`;

function filtre(action) {
  return `return $input.all()
  .filter((item) => item.json.__action === '${action}')
  .map((item) => {
    const { __action, ...reste } = item.json;
    return { json: reste };
  });`;
}

const LIGNE_LOT = `// Le géocodage se fait à la commune : à 12 km de seuil, l'adresse exacte
// ne change jamais la décision entre Bompas et Le Soler.
const demande = $('Branche — nouveau lot').first().json;
const reponse = $input.first().json;
const trouve = reponse && reponse.features && reponse.features[0];

if (!trouve) {
  return [{
    json: {
      __action: 'reponse',
      chat_id: demande.chat_id,
      texte: \`Commune « \${demande.commune} » introuvable dans l'API Adresse. Lot non créé.\`,
    },
  }];
}

const [longitude, latitude] = trouve.geometry.coordinates;
return [{
  json: {
    reference: demande.reference,
    commune: trouve.properties.city || trouve.properties.name || demande.commune,
    code_postal: trouve.properties.postcode || null,
    type_lot: demande.type_lot,
    loyer_cc: demande.loyer_cc,
    accepte_visale: demande.accepte_visale,
    zone_visale: demande.zone_visale,
    latitude,
    longitude,
    statut: 'disponible',
    __chat_id: demande.chat_id,
  },
}];`;

const CONFIRMER_LOT = `// Les items sans coordonnées sont des messages d'erreur déjà formés.
return $input.all().map((item) => {
  const lot = item.json;
  if (lot.__action === 'reponse') return { json: lot };
  return {
    json: {
      chat_id: lot.__chat_id,
      texte: [
        \`<b>Lot \${lot.reference} enregistré</b>\`,
        \`\${lot.commune} \${lot.code_postal || ''} · \${lot.type_lot} · \${lot.loyer_cc} € CC\`,
        \`Visale : \${lot.accepte_visale ? 'acceptée' : 'non (GLI)'}\`,
        lot.zone_visale ? \`Zone Visale : \${lot.zone_visale}\` : 'Zone Visale : à relever',
      ].join('\\n'),
    },
  };
});`;

const TRAITE = `-- Idempotent : re-clore un dossier déjà clos ne renvoie aucune ligne,
-- et la confirmation le dit plutôt que de mentir.
UPDATE locatif.candidats
SET arbitre_le = now()
WHERE id = $1::bigint
  AND statut = 'arbitrage'
  AND arbitre_le IS NULL
RETURNING id, nom;`;

const CONFIRMER_TRAITE = `const demande = $('Branche — arbitrage clos').first().json;
const ligne = $input.first().json;
return [{
  json: {
    chat_id: demande.chat_id,
    texte: ligne && ligne.id
      ? \`Dossier #\${ligne.id} (\${ligne.nom || 'sans nom'}) clos. Il ne reviendra plus dans les rappels.\`
      : \`Aucun arbitrage ouvert ne porte le numéro \${demande.candidat_id} — déjà clos, ou identifiant erroné.\`,
  },
}];`;

const LIGNE_ABSENCE = `// Le chat_id de la conversation ne va pas en base : ce n'est pas une
// colonne de la table, c'est juste l'adresse où répondre.
return $input.all().map((item) => ({
  json: {
    debut: item.json.debut,
    fin: item.json.fin,
    chat_id_suppleant: item.json.chat_id_suppleant,
  },
}));`;

const CONFIRMER_ABSENCE = `const demande = $('Branche — absence').first().json;
const ligne = $input.first().json;
return [{
  json: {
    chat_id: demande.chat_id,
    texte: [
      \`<b>Absence enregistrée</b> du \${ligne.debut} au \${ligne.fin}.\`,
      ligne.chat_id_suppleant
        ? \`Les arbitrages en attente partiront vers \${ligne.chat_id_suppleant}.\`
        : 'Aucun suppléant : les candidats dont le dossier traîne recevront un mot d’attente dès le premier jour ouvré.',
      '/retour pour y mettre fin plus tôt.',
    ].join('\\n'),
  },
}];`;

const RETOUR = `-- Clôt l'absence en cours à hier : la période reste en base, elle ne
-- couvre simplement plus aujourd'hui.
UPDATE locatif.absences
SET fin = current_date - 1
WHERE current_date BETWEEN debut AND fin
RETURNING id, debut, fin;`;

const CONFIRMER_RETOUR = `const demande = $('Branche — retour').first().json;
const ligne = $input.first().json;
return [{
  json: {
    chat_id: demande.chat_id,
    texte: ligne && ligne.id
      ? 'Absence terminée. Les arbitrages en attente te reviennent.'
      : 'Aucune absence en cours.',
  },
}];`;

const LOUE = `UPDATE locatif.lots
SET statut = 'loue'
WHERE reference = $1::text
RETURNING reference, commune;`;

const CONFIRMER_LOUE = `const demande = $('Branche — bien loué').first().json;
const ligne = $input.first().json;
return [{
  json: {
    chat_id: demande.chat_id,
    texte: ligne && ligne.reference
      ? \`Lot \${ligne.reference} (\${ligne.commune}) sorti des biens disponibles.\`
      : \`Aucun lot disponible ne porte la référence \${demande.reference}.\`,
  },
}];`;

module.exports = {
  fichier: 'wf7-telegram-commandes.json',
  description:
    'Déclencheur Telegram unique : /lot et /loue alimentent la table des lots, /pieces lance la demande de justificatifs.',

  construire(socle) {
    const f = fabrique('ERA · WF-7 · Commandes Telegram');

    f.telegramTrigger('Message Telegram', [-480, 400]);
    noeudParametres(f, [-260, 400]);
    f.code('Lire la commande', [-40, 400], LIRE);

    f.code('Branche — nouveau lot', [200, 120], filtre('lot'));
    f.http('API Adresse — géocoder la commune', [420, 120], {
      method: 'GET',
      url: 'https://api-adresse.data.gouv.fr/search/',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'q', value: '={{ $json.commune }}' },
          { name: 'type', value: 'municipality' },
          { name: 'limit', value: '1' },
        ],
      },
      options: { timeout: 20000 },
    });
    f.code('Ligne de lot', [640, 120], LIGNE_LOT);
    f.inserer('Créer le lot', [860, 120], 'lots');
    f.code('Confirmer la création', [1080, 120], CONFIRMER_LOT);
    f.telegram('Répondre — lot créé', [1300, 120]);

    f.code('Branche — bien loué', [200, 320], filtre('loue'));
    f.requete('Sortir le lot', [420, 320], LOUE, {
      remplacements: '={{ $json.reference }}',
      extra: { alwaysOutputData: true },
    });
    f.code('Confirmer la sortie', [640, 320], CONFIRMER_LOUE);
    f.telegram('Répondre — lot loué', [860, 320]);

    f.code('Branche — demande de pièces', [200, 520], filtre('pieces'));
    f.executer('Lancer WF-5', [420, 520], 'ERA · WF-5 · Demande de pièces');

    f.code('Branche — arbitrage clos', [200, 700], filtre('traite'));
    f.requete('Clore le dossier', [420, 700], TRAITE, {
      remplacements: '={{ $json.candidat_id }}',
      extra: { alwaysOutputData: true },
    });
    f.code('Confirmer la clôture', [640, 700], CONFIRMER_TRAITE);
    f.telegram('Répondre — dossier clos', [860, 700]);

    f.code('Branche — absence', [200, 880], filtre('absence'));
    f.code('Ligne d’absence', [420, 880], LIGNE_ABSENCE);
    f.inserer('Créer l’absence', [640, 880], 'absences');
    f.code('Confirmer l’absence', [860, 880], CONFIRMER_ABSENCE);
    f.telegram('Répondre — absence', [1080, 880]);

    f.code('Branche — retour', [200, 1060], filtre('retour'));
    f.requete('Terminer l’absence', [420, 1060], RETOUR, { extra: { alwaysOutputData: true } });
    f.code('Confirmer le retour', [640, 1060], CONFIRMER_RETOUR);
    f.telegram('Répondre — retour', [860, 1060]);

    f.code('Branche — réponse directe', [200, 1240], filtre('reponse'));
    f.telegram('Répondre — aide', [420, 1240]);

    f.chaine('Message Telegram', 'Paramètres', 'Lire la commande');
    f.relier('Lire la commande', 'Branche — nouveau lot');
    f.chaine(
      'Branche — nouveau lot',
      'API Adresse — géocoder la commune',
      'Ligne de lot',
      'Créer le lot',
      'Confirmer la création',
      'Répondre — lot créé',
    );
    f.relier('Lire la commande', 'Branche — bien loué');
    f.chaine('Branche — bien loué', 'Sortir le lot', 'Confirmer la sortie', 'Répondre — lot loué');
    f.relier('Lire la commande', 'Branche — demande de pièces');
    f.relier('Branche — demande de pièces', 'Lancer WF-5');
    f.relier('Lire la commande', 'Branche — arbitrage clos');
    f.chaine('Branche — arbitrage clos', 'Clore le dossier', 'Confirmer la clôture', 'Répondre — dossier clos');
    f.relier('Lire la commande', 'Branche — absence');
    f.chaine('Branche — absence', 'Ligne d’absence', 'Créer l’absence', 'Confirmer l’absence', 'Répondre — absence');
    f.relier('Lire la commande', 'Branche — retour');
    f.chaine('Branche — retour', 'Terminer l’absence', 'Confirmer le retour', 'Répondre — retour');
    f.relier('Lire la commande', 'Branche — réponse directe');
    f.relier('Branche — réponse directe', 'Répondre — aide');

    return f.construire({ description: module.exports.description });
  },
};
