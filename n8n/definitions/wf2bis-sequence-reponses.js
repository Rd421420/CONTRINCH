/**
 * WF-2 bis · Séquence SMS — réponses entrantes.
 *
 * Le cœur du dispositif. Twilio appelle le webhook, le workflow recharge
 * tout le contexte en une requête, passe la main au socle, puis exécute
 * les actions que le socle a décidées.
 *
 * Aucune règle métier n'est écrite ici : ni seuil, ni horaire, ni texte de
 * message. Le workflow est un câblage, il ne décide de rien — c'est ce qui
 * permet de rejouer une conversation entière en test sans n8n.
 *
 * Les réponses entrantes sont traitées à toute heure (§5) : c'est seulement
 * l'émission qui attend la plage 9 h – 19 h.
 */

const { fabrique, noeudParametres } = require('../lib');

const CONTEXTE = `-- Tout le contexte en une seule ligne. Les agrégats JSON évitent qu'un
-- référentiel à plusieurs lignes (fériés, lots, réservations) ne multiplie
-- les items et ne casse l'appariement des nodes suivants.
--
-- Le rapprochement se fait sur les 9 derniers chiffres : Twilio annonce
-- « +33612345678 » là où la fiche peut porter « 06 12 34 56 78 ».
WITH candidat AS (
    SELECT *
    FROM locatif.candidats
    WHERE right(regexp_replace(mobile, '\\D', '', 'g'), 9)
        = right(regexp_replace($1::text, '\\D', '', 'g'), 9)
      AND statut IN ('nouveau', 'en_cours')
    ORDER BY cree_le DESC
    LIMIT 1
)
SELECT
  (SELECT row_to_json(c) FROM candidat c) AS candidat,
  (
    SELECT row_to_json(l)
    FROM locatif.lots l
    JOIN candidat c ON l.reference = c.ref_lot
  ) AS lot,
  (
    SELECT COALESCE(json_agg(j.jour), '[]'::json)
    FROM locatif.jours_feries j
    WHERE j.jour >= current_date - 7
  ) AS jours_feries,
  (
    -- Sert à localiser les ancres lues dans l'agenda : un événement
    -- ImmoAgenda ne porte que la référence du lot, pas ses coordonnées.
    SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json)
    FROM (
      SELECT reference, commune, latitude, longitude
      FROM locatif.lots
      WHERE latitude IS NOT NULL
    ) x
  ) AS lots,
  (
    SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json)
    FROM locatif.creneaux_reserves r
    WHERE r.confirme OR r.reserve_jusqu_a > now()
  ) AS reservations,
  (
    -- Les deux créneaux proposés à CE candidat, dans l'ordre où le SMS les
    -- a listés : A puis B. C'est la colonne rang qui le garantit.
    SELECT COALESCE(json_agg(row_to_json(p) ORDER BY p.rang), '[]'::json)
    FROM (
      SELECT r.id, r.debut, r.fin, r.rang
      FROM locatif.creneaux_reserves r
      JOIN candidat c ON r.candidat_id = c.id
      -- Le filtre sur l'expiration n'est pas cosmétique : après une
      -- relance, le candidat a deux jeux de créneaux en base et « B »
      -- désignerait n'importe lequel des deux.
      WHERE NOT r.confirme AND r.reserve_jusqu_a > now()
    ) p
  ) AS creneaux_proposes;`;

const FENETRE = `// Prépare la lecture d'agenda. Renvoyer zéro item arrête proprement la
// branche : c'est le cas d'un SMS venu d'un numéro inconnu, ou d'une
// séquence déjà close.
const contexte = $input.first().json;
const parametres = $('Paramètres').first().json;

const corps = $('Webhook Twilio').first().json;
const recu = corps.body || corps;
const texte = String(recu.Body || '').trim();
const numero = String(recu.From || '');

if (!contexte.candidat) {
  // Personne ne répond dans le vide : le message est remonté tel quel.
  return [{
    json: {
      __sans_candidat: true,
      chat_id: parametres.chat_id,
      texte: ['<b>SMS reçu hors séquence</b>', \`De : \${numero}\`, \`« \${texte} »\`].join('\\n'),
    },
  }];
}

// Fenêtre de lecture large : le J+2 ouvré peut tomber loin quand la
// demande arrive un jeudi et qu'un pont suit.
const maintenant = new Date();
const fin = new Date(maintenant.getTime() + 40 * 86400000);

return [{
  json: {
    agenda: parametres.agenda,
    fenetre_debut: maintenant.toISOString(),
    fenetre_fin: fin.toISOString(),
    texte_recu: texte,
  },
}];`;

const TRAITER = `// Passe la main au socle, puis traduit sa décision en lignes à écrire.
// Chaque item de sortie porte un champ __action, que les branches suivantes
// filtrent. Un node Code qui ne renvoie rien arrête sa branche.
const parametres = $('Paramètres').first().json;
const fenetre = $('Fenêtre de lecture').first().json;

// Numéro inconnu : la branche s'arrête sur une simple notification.
if (fenetre.__sans_candidat) {
  return [{ json: { __action: 'telegram', chat_id: fenetre.chat_id, texte: fenetre.texte } }];
}

const contexte = $('Charger le contexte').first().json;
const candidat = contexte.candidat;
const lot = contexte.lot;
const feries = contexte.jours_feries || [];
const reservations = contexte.reservations || [];

const lotsParReference = {};
for (const l of contexte.lots || []) lotsParReference[l.reference] = l;

// Filtre d'occupation : TOUS les événements comptent, y compris un
// déjeuner. Le filtre d'ancre, lui, est appliqué par le socle, qui ne
// retient que ceux portant un bloc ImmoAgenda.
const evenements = $input.all()
  .map((item) => item.json)
  .filter((e) => e && e.start && (e.start.dateTime || e.start.date))
  .map((e) => ({
    debut: e.start.dateTime || e.start.date,
    fin: (e.end && (e.end.dateTime || e.end.date)) || e.start.dateTime || e.start.date,
    summary: e.summary || '',
    description: e.description || '',
  }));

const communs = {
  lot,
  evenements,
  reservations,
  joursFeries: feries,
  lots: lotsParReference,
  candidatId: candidat.id,
  maintenant: new Date(),
};

const proposer = () =>
  ERA.creneaux.proposerCreneaux({ ...communs, dateDemande: new Date(candidat.cree_le) }).creneaux;

const resultat = ERA.sequence.traiterReponse(candidat, fenetre.texte_recu, {
  lot,
  temps: ERA.temps,
  proposerCreneaux: proposer,
  reproposer: proposer,
  creneauxProposes: contexte.creneaux_proposes || [],
  // Vérification systématique AVANT écriture : le blocage en base ne
  // connaît que les réservations du système, pas les visites posées à la
  // main dans ImmoFacile.
  creneauEncoreLibre: (creneau) =>
    ERA.creneaux.creneauEncoreLibre(creneau, evenements, reservations, {
      maintenant: new Date(),
      candidatId: candidat.id,
    }),
});

const actions = [];

// 1. La fiche candidat, telle que le socle l'a fait évoluer.
// L'entrée en file d'arbitrage est datée ici : c'est de cet instant que
// part le compteur de relance, pas du récapitulatif de 18 h.
const bascule = resultat.sortie && !candidat.arbitrage_depuis
  ? { arbitrage_depuis: new Date().toISOString() }
  : {};
actions.push({ json: { __action: 'candidat', id: candidat.id, ...resultat.patch, ...bascule } });

// 2. Les messages, qui partiront quand la plage d'envoi le permettra.
for (const message of resultat.envois) {
  actions.push({
    json: {
      __action: 'sms',
      candidat_id: candidat.id,
      mobile: candidat.mobile,
      texte: message.texte,
      type_message: message.type,
      envoyer_apres: new Date().toISOString(),
    },
  });
}

// 3. Les deux créneaux proposés sont bloqués, pas seulement celui que le
//    candidat choisira : sinon deux candidats reçoivent la même option B.
const proposes = resultat.creneaux || [];
if (proposes.length) {
  const expiration = ERA.calendrier.expirationBlocage(new Date(), feries).toISOString();
  proposes.forEach((creneau, index) => {
    actions.push({
      json: {
        __action: 'creneau',
        candidat_id: candidat.id,
        ref_lot: lot.reference,
        debut: creneau.debut.toISOString(),
        fin: creneau.fin.toISOString(),
        reserve_jusqu_a: expiration,
        rang: index + 1,
        confirme: false,
      },
    });
  });
}

// 4. Journal des dossiers écartés — anonyme, donc jamais purgé. C'est lui
//    qui dira, à trois mois, ce que le système fait perdre.
const evaluation = resultat.eligibilite;
if (evaluation && ['hors_criteres', 'non_assurable'].includes(evaluation.verdict)) {
  const revenus = Number(candidat.revenus_nets) || 0;
  const seuil = Number(evaluation.seuil_revenus);
  actions.push({
    json: {
      __action: 'refus',
      ref_lot: lot.reference,
      commune: lot.commune,
      loyer_cc: lot.loyer_cc,
      type_lot: lot.type_lot,
      situation: candidat.situation,
      garantie: candidat.garantie,
      verdict: evaluation.verdict,
      motif: evaluation.motif,
      ecart_seuil: Number.isFinite(seuil) ? Math.round((revenus - seuil) * 100) / 100 : null,
    },
  });
}

// 5. Arbitrage. La file immédiate part tout de suite ; la file différée
//    est reprise par le récapitulatif de 18 h, via candidats.notifie_le.
if (resultat.sortie && resultat.sortie.file === 'immediate') {
  actions.push({
    json: {
      __action: 'telegram',
      chat_id: parametres.chat_id,
      texte: [
        '<b>Demande de rappel</b>',
        \`\${candidat.nom || 'Candidat'} — \${candidat.mobile}\`,
        \`Bien \${lot.reference} (\${lot.commune}), \${lot.loyer_cc} € CC\`,
        \`Motif : \${resultat.patch.motif || resultat.sortie.motif}\`,
      ].join('\\n'),
    },
  });
}

// 6. Rendez-vous confirmé : l'événement s'écrit au format ImmoAgenda,
//    au caractère près, pour que les workflows de relance 24 h et d'avis
//    Google le lisent sans modification.
if (resultat.creneauRetenu) {
  const donnees = {
    type: 'Visite',
    client: { nom: candidat.nom, email: candidat.email, telephone: candidat.mobile },
    lot: {
      reference: lot.reference,
      loyer_cc: lot.loyer_cc,
      adresse: lot.adresse,
      proprietaire: lot.proprietaire,
      tel_proprietaire: lot.tel_proprietaire,
    },
  };
  actions.push({
    json: {
      __action: 'agenda',
      agenda: parametres.agenda,
      candidat_id: candidat.id,
      debut: resultat.creneauRetenu.debut.toISOString(),
      fin: resultat.creneauRetenu.fin.toISOString(),
      summary: ERA.immoagenda.construireTitre(donnees),
      location: lot.adresse || lot.commune,
      description: ERA.immoagenda.construireDescription(donnees),
    },
  });
}

return actions;`;

function filtre(action, commentaire) {
  return `// ${commentaire}
return $input.all()
  .filter((item) => item.json.__action === '${action}')
  .map((item) => {
    const { __action, ...reste } = item.json;
    return { json: reste };
  });`;
}

const ENREGISTRER_RDV = `-- Confirme le créneau retenu et pose l'identifiant de l'événement sur la
-- fiche. Les autres créneaux proposés restent non confirmés et seront
-- libérés à l'expiration.
WITH confirme AS (
    UPDATE locatif.creneaux_reserves
    SET confirme = TRUE
    WHERE candidat_id = $2::bigint
      AND debut = $3::timestamptz
    RETURNING candidat_id
)
UPDATE locatif.candidats
SET rdv_event_id = $1::text,
    statut       = 'rdv_pose',
    purge_le     = $3::timestamptz + INTERVAL '90 days'
WHERE id = $2::bigint;`;

module.exports = {
  fichier: 'wf2bis-sequence-reponses.json',
  description:
    'Webhook Twilio : lit la réponse du candidat, fait avancer la séquence, propose ou confirme un créneau.',

  construire(socle) {
    const f = fabrique('ERA · WF-2 bis · Séquence SMS — réponses');

    f.webhook('Webhook Twilio', [-480, 400], 'twilio/sms');
    // Twilio coupe au bout de 15 s : on répond immédiatement, le travail
    // continue derrière. Une réponse TwiML vide n'envoie rien au candidat.
    f.repondre('Répondre à Twilio', [-260, 400], '<Response></Response>', 'text/xml');
    noeudParametres(f, [-40, 400]);
    f.requete('Charger le contexte', [180, 400], CONTEXTE, {
      remplacements: '={{ ($json.body || $json).From }}',
    });
    f.code('Fenêtre de lecture', [400, 400], FENETRE);
    f.agendaLire('Google Agenda — occupation', [620, 400]);
    f.code('Traiter la réponse', [840, 400], TRAITER, { socle });

    f.code('Branche — fiche candidat', [1080, 40], filtre('candidat', 'La fiche, telle que le socle l’a fait évoluer.'));
    f.mettreAJour('Mettre à jour la fiche', [1300, 40], 'candidats');

    f.code('Branche — messages', [1080, 200], filtre('sms', 'Les messages partent en file : la plage d’envoi est gérée ailleurs.'));
    f.inserer('Mettre en file', [1300, 200], 'file_sms');

    f.code('Branche — créneaux bloqués', [1080, 360], filtre('creneau', 'Les DEUX créneaux proposés sont bloqués, pas seulement le choisi.'));
    f.inserer('Bloquer les créneaux', [1300, 360], 'creneaux_reserves');

    f.code('Branche — journal des écartés', [1080, 520], filtre('refus', 'Journal anonyme : aucune donnée nominative, donc jamais purgé.'));
    f.inserer('Journaliser', [1300, 520], 'refus_log');

    f.code('Branche — arbitrage immédiat', [1080, 680], filtre('telegram', 'File immédiate uniquement : la file différée part à 18 h.'));
    f.telegram('Prévenir sur Telegram', [1300, 680]);

    f.code('Branche — rendez-vous', [1080, 840], filtre('agenda', 'Écriture au format ImmoAgenda, séparateur U+2500 compris.'));
    f.agendaCreer('Google Agenda — créer la visite', [1300, 840]);
    f.requete('Enregistrer le rendez-vous', [1520, 840], ENREGISTRER_RDV, {
      remplacements:
        "={{ $json.id }}, {{ $('Branche — rendez-vous').item.json.candidat_id }}, {{ $('Branche — rendez-vous').item.json.debut }}",
    });

    f.chaine(
      'Webhook Twilio',
      'Répondre à Twilio',
      'Paramètres',
      'Charger le contexte',
      'Fenêtre de lecture',
      'Google Agenda — occupation',
      'Traiter la réponse',
    );

    for (const branche of [
      ['Branche — fiche candidat', 'Mettre à jour la fiche'],
      ['Branche — messages', 'Mettre en file'],
      ['Branche — créneaux bloqués', 'Bloquer les créneaux'],
      ['Branche — journal des écartés', 'Journaliser'],
      ['Branche — arbitrage immédiat', 'Prévenir sur Telegram'],
      ['Branche — rendez-vous', 'Google Agenda — créer la visite'],
    ]) {
      f.relier('Traiter la réponse', branche[0]);
      f.relier(branche[0], branche[1]);
    }
    f.relier('Google Agenda — créer la visite', 'Enregistrer le rendez-vous');

    return f.construire({ description: module.exports.description });
  },
};
