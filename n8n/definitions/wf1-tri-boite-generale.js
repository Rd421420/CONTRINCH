/**
 * WF-1 · Tri de la boîte générale.
 *
 * Le modèle de langage ne reçoit QUE le corps du message : ni la base de
 * lots, ni l'historique candidat, ni les coordonnées propriétaire. Et il
 * tourne sur le VPS via Ollama, donc aucune donnée candidat ne sort du
 * serveur — c'est ce qui laisse Twilio seul sous-traitant à déclarer.
 */

const { fabrique, noeudParametres } = require('../lib');

const FILTRE = `// Premier filtre, sans IA : expéditeurs connus et mots-clés du formulaire.
// Il n'a pas à être fin — il est là pour éviter d'envoyer au modèle les
// newsletters, les factures et les relances de syndic.
const EXPEDITEURS = [
  'seloger', 'leboncoin', 'bienici', 'bien-ici', 'pap.fr',
  'logic-immo', 'figaroimmo', 'avendrealouer', 'era-immobilier',
];
const MOTS_CLES = [
  'demande de visite', 'souhaite visiter', 'visiter', 'visite',
  'votre annonce', 'reference', 'référence', 'toujours disponible',
  'formulaire de contact', 'demande de renseignement',
];

function texteDe(mail) {
  return String(mail.text || mail.textPlain || mail.snippet || mail.html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function adresseDe(mail) {
  const brut = mail.from && mail.from.value ? mail.from.value[0] : null;
  return String((brut && brut.address) || mail.from || mail.From || '').toLowerCase();
}

const sortie = [];
for (const item of $input.all()) {
  const mail = item.json;
  const expediteur = adresseDe(mail);
  const sujet = String(mail.subject || '').toLowerCase();
  const corps = texteDe(mail);
  const recherche = \`\${sujet} \${corps}\`.toLowerCase();

  const connu = EXPEDITEURS.some((e) => expediteur.includes(e));
  const evocateur = MOTS_CLES.some((m) => recherche.includes(m));
  if (!connu && !evocateur) continue;

  // Le modèle ne voit que ça : le corps du message, tronqué.
  const extrait = corps.slice(0, 2000);

  sortie.push({
    json: {
      ...mail,
      expediteur_mail: expediteur,
      sujet_mail: mail.subject || '',
      corps_mail: extrait,
      invite: [
        "Tu analyses un message reçu par une agence immobilière.",
        "Réponds UNIQUEMENT en JSON, sans commentaire, avec ces clés :",
        '{"demande_visite": true|false, "reference": string|null, "nom": string|null, "mobile": string|null, "email": string|null}',
        "demande_visite vaut true seulement s'il s'agit d'une demande de visite d'un bien à louer.",
        "reference est la référence du bien citée dans le message, sinon null.",
        "mobile est un numéro de téléphone français, chiffres uniquement.",
        "N'invente aucune valeur : mets null si l'information est absente.",
        '',
        'Message :',
        extrait,
      ].join('\\n'),
    },
  });
}
return sortie;`;

const LECTURE = `// Sortie JSON stricte du modèle. Toute réponse illisible est ignorée :
// un mail non trié reste dans la boîte, ce qui est le comportement voulu.
const sortie = [];
const items = $input.all();

for (let i = 0; i < items.length; i += 1) {
  let source;
  try {
    source = $('Filtre expéditeurs et mots-clés').itemMatching(i).json;
  } catch (e) {
    source = $('Filtre expéditeurs et mots-clés').all()[i].json;
  }

  let lu = null;
  try {
    lu = JSON.parse(String(items[i].json.response || '{}'));
  } catch (e) {
    continue;
  }
  if (!lu || lu.demande_visite !== true) continue;

  const mobile = String(lu.mobile || '').replace(/\\D/g, '');
  sortie.push({
    json: {
      expediteur: source.expediteur,
      chat_id: source.chat_id,
      source: (source.expediteur_mail || '').split('@')[1] || 'autre',
      nom: lu.nom || null,
      // Le numéro français est ramené au format E.164 attendu par Twilio.
      mobile: mobile ? (mobile.startsWith('33') ? \`+\${mobile}\` : \`+33\${mobile.replace(/^0/, '')}\`) : null,
      email: lu.email || null,
      // La virgule est retirée : elle sert de séparateur aux paramètres SQL
      // de n8n, et une référence qui en contient décalerait la requête.
      reference: lu.reference ? String(lu.reference).replace(/,/g, ' ').trim() : null,
      sujet_mail: source.sujet_mail,
    },
  });
}
return sortie;`;

const PREPARER = `// Le lot est renvoyé en colonne JSON par la requête précédente : elle
// produit toujours exactement une ligne, même sans correspondance, ce qui
// préserve l'appariement avec les items d'entrée.
const sortie = [];
const items = $input.all();

for (let i = 0; i < items.length; i += 1) {
  let extrait;
  try {
    extrait = $('Lire la réponse du modèle').itemMatching(i).json;
  } catch (e) {
    extrait = $('Lire la réponse du modèle').all()[i].json;
  }
  const lot = items[i].json.lot;

  // Sans référence connue ou sans mobile, la séquence SMS ne peut pas
  // démarrer. Le dossier part en arbitrage plutôt que d'échouer en base
  // sur la clé étrangère ref_lot.
  if (!lot || !extrait.mobile) {
    sortie.push({
      json: {
        __action: 'telegram',
        chat_id: extrait.chat_id,
        texte: [
          '<b>Demande de visite non rattachée</b>',
          \`Référence lue : \${extrait.reference || '—'}\`,
          \`Nom : \${extrait.nom || '—'}\`,
          \`Mobile : \${extrait.mobile || '— (absent)'}\`,
          \`Objet : \${extrait.sujet_mail || '—'}\`,
          '',
          lot ? 'Mobile manquant.' : 'Aucun lot disponible ne porte cette référence.',
        ].join('\\n'),
      },
    });
    continue;
  }

  sortie.push({
    json: {
      __action: 'candidat',
      source: extrait.source,
      nom: extrait.nom,
      mobile: extrait.mobile,
      email: extrait.email,
      ref_lot: lot.reference,
      statut: 'nouveau',
      // Purge à 30 jours dès l'écriture : une fiche sans suite ne doit pas
      // dépendre d'un workflow pour disparaître.
      purge_le: new Date(Date.now() + 30 * 86400000).toISOString(),
    },
  });
}
return sortie;`;

function filtre(action) {
  return `// Sépare la branche « ${action} ». Un node Code qui ne renvoie aucun item
// arrête sa branche : c'est ce qui remplace ici un node IF.
return $input.all()
  .filter((item) => item.json.__action === '${action}')
  .map((item) => {
    const { __action, ...reste } = item.json;
    return { json: reste };
  });`;
}

module.exports = {
  fichier: 'wf1-tri-boite-generale.json',
  description:
    'Trie la boîte générale toutes les 10 minutes, extrait la demande de visite avec un modèle local et crée la fiche candidat.',

  construire(socle) {
    const f = fabrique('ERA · WF-1 · Tri de la boîte générale');

    f.gmail('Boîte générale', [-260, 300], 10);
    noeudParametres(f, [-40, 300]);
    f.code('Filtre expéditeurs et mots-clés', [180, 300], FILTRE);

    f.http('Ollama — est-ce une demande de visite ?', [400, 300], {
      method: 'POST',
      url: '={{ $json.ollama }}',
      sendBody: true,
      specifyBody: 'json',
      jsonBody:
        '={{ JSON.stringify({ model: $json.modele, prompt: $json.invite, format: "json", stream: false, options: { temperature: 0 } }) }}',
      options: { timeout: 120000 },
    });

    f.code('Lire la réponse du modèle', [620, 300], LECTURE);

    f.requete(
      'Retrouver le lot',
      [840, 300],
      [
        '-- Aucune clause FROM : la requête renvoie toujours exactement une',
        "-- ligne par item d'entrée, avec `lot` à NULL si rien ne correspond.",
        'SELECT (',
        '  SELECT row_to_json(l)',
        '  FROM locatif.lots l',
        "  WHERE l.reference = $1::text AND l.statut = 'disponible'",
        ') AS lot;',
      ].join('\n'),
      { remplacements: '={{ $json.reference }}' },
    );

    f.code('Préparer la fiche', [1060, 300], PREPARER);
    f.code('Branche — nouveau candidat', [1280, 200], filtre('candidat'));
    f.inserer('Créer le candidat', [1500, 200], 'candidats');
    f.code('Branche — arbitrage', [1280, 420], filtre('telegram'));
    f.telegram('Prévenir sur Telegram', [1500, 420]);

    f.chaine(
      'Boîte générale',
      'Paramètres',
      'Filtre expéditeurs et mots-clés',
      'Ollama — est-ce une demande de visite ?',
      'Lire la réponse du modèle',
      'Retrouver le lot',
      'Préparer la fiche',
    );
    f.relier('Préparer la fiche', 'Branche — nouveau candidat');
    f.relier('Préparer la fiche', 'Branche — arbitrage');
    f.relier('Branche — nouveau candidat', 'Créer le candidat');
    f.relier('Branche — arbitrage', 'Prévenir sur Telegram');

    return f.construire({ description: module.exports.description });
  },
};
