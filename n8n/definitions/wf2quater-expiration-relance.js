/**
 * WF-2 quater · Expiration des créneaux, relance unique, abandon.
 *
 * Le calendrier du §5 :
 *   T+0   deux créneaux proposés, bloqués 2 heures ouvrées
 *   T+2h  sans réponse → créneaux libérés, une relance avec deux créneaux
 *         recalculés, bloqués à leur tour
 *   T+4h  toujours sans réponse → abandon, récapitulatif Telegram de 18 h
 *
 * Une seule relance, pas deux : un candidat qui ne répond pas à deux
 * propositions successives ne répondra pas à la troisième, et chaque
 * message coûte.
 */

const { fabrique, noeudParametres } = require('../lib');

const EXPIRES = `-- Candidats dont TOUS les créneaux proposés ont expiré sans réponse,
-- plus le contexte nécessaire à un recalcul.
WITH en_attente AS (
    SELECT c.*
    FROM locatif.candidats c
    WHERE c.statut = 'en_cours'
      AND EXISTS (
          SELECT 1 FROM locatif.creneaux_reserves r
          WHERE r.candidat_id = c.id AND NOT r.confirme
      )
      AND NOT EXISTS (
          SELECT 1 FROM locatif.creneaux_reserves r
          WHERE r.candidat_id = c.id AND NOT r.confirme
            AND r.reserve_jusqu_a > now()
      )
    ORDER BY c.cree_le
    LIMIT 10
)
SELECT
  (
    SELECT COALESCE(json_agg(json_build_object('candidat', row_to_json(a), 'lot', row_to_json(l))), '[]'::json)
    FROM en_attente a
    JOIN locatif.lots l ON l.reference = a.ref_lot
  ) AS dossiers,
  (
    SELECT COALESCE(json_agg(j.jour), '[]'::json)
    FROM locatif.jours_feries j WHERE j.jour >= current_date - 7
  ) AS jours_feries,
  (
    SELECT COALESCE(json_agg(row_to_json(x)), '[]'::json)
    FROM (
      SELECT reference, commune, latitude, longitude
      FROM locatif.lots WHERE latitude IS NOT NULL
    ) x
  ) AS lots,
  (
    SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json)
    FROM locatif.creneaux_reserves r
    WHERE r.confirme OR r.reserve_jusqu_a > now()
  ) AS reservations,
  (
    -- Filet de sécurité : séquences parties sans message, ou muettes
    -- depuis plus de trois jours. Sans ce garde-fou, une fiche restée en
    -- « en_cours » n'est jamais revue par personne.
    SELECT COALESCE(json_agg(row_to_json(b)), '[]'::json)
    FROM (
      SELECT c.id, c.nom, c.mobile, c.etape_sms, c.cree_le
      FROM locatif.candidats c
      WHERE c.statut = 'en_cours'
        AND c.cree_le < now() - INTERVAL '3 days'
        AND NOT EXISTS (
            SELECT 1 FROM locatif.creneaux_reserves r
            WHERE r.candidat_id = c.id AND NOT r.confirme AND r.reserve_jusqu_a > now()
        )
        AND NOT EXISTS (
            SELECT 1 FROM locatif.file_sms f
            WHERE f.candidat_id = c.id AND f.envoye_le IS NULL
        )
      LIMIT 10
    ) b
  ) AS bloquees;`;

const LIBERER = `-- Suppression réelle, et non simple expiration : passé le délai sans
-- réponse, les deux créneaux proposés sortent de la table et redeviennent
-- proposables à d'autres candidats.
--
-- La suppression est limitée au candidat traité dans cette exécution. Une
-- suppression globale ferait disparaître le marqueur des candidats restés
-- hors du lot de dix, qui ne seraient alors jamais relancés.
DELETE FROM locatif.creneaux_reserves
WHERE candidat_id = $1::bigint
  AND NOT confirme
  AND reserve_jusqu_a <= now();`;

const FENETRE = `const contexte = $input.first().json;
const parametres = $('Paramètres').first().json;
const dossiers = contexte.dossiers || [];
const bloquees = contexte.bloquees || [];

if (!dossiers.length && !bloquees.length) return [];

const maintenant = new Date();
return [{
  json: {
    agenda: parametres.agenda,
    fenetre_debut: maintenant.toISOString(),
    fenetre_fin: new Date(maintenant.getTime() + 40 * 86400000).toISOString(),
  },
}];`;

const DECIDER = `const parametres = $('Paramètres').first().json;
const contexte = $('Créneaux expirés').first().json;
const feries = contexte.jours_feries || [];
const reservations = contexte.reservations || [];

const lotsParReference = {};
for (const l of contexte.lots || []) lotsParReference[l.reference] = l;

const evenements = $input.all()
  .map((item) => item.json)
  .filter((e) => e && e.start && (e.start.dateTime || e.start.date))
  .map((e) => ({
    debut: e.start.dateTime || e.start.date,
    fin: (e.end && (e.end.dateTime || e.end.date)) || e.start.dateTime || e.start.date,
    summary: e.summary || '',
    description: e.description || '',
  }));

const actions = [];

for (const dossier of contexte.dossiers || []) {
  const candidat = dossier.candidat;
  const lot = dossier.lot;

  // Quoi qu'il advienne ensuite — relance ou abandon — les propositions
  // périmées de ce candidat sont supprimées, pas seulement ignorées.
  actions.push({ json: { __action: 'liberer', candidat_id: candidat.id } });

  // Une seule relance. Au-delà, la séquence s'arrête et le dossier entre
  // dans le récapitulatif de 18 h.
  if (Number(candidat.nb_relances) >= ERA.config.RELANCES_MAX) {
    actions.push({
      json: {
        __action: 'candidat',
        id: candidat.id,
        statut: 'arbitrage',
        arbitrage_depuis: new Date().toISOString(),
        motif: 'Sans réponse après deux propositions de créneaux',
      },
    });
    continue;
  }

  const creneaux = ERA.creneaux.proposerCreneaux({
    lot,
    dateDemande: new Date(candidat.cree_le),
    maintenant: new Date(),
    evenements,
    reservations,
    joursFeries: feries,
    lots: lotsParReference,
    candidatId: candidat.id,
  }).creneaux;

  // Plus aucun créneau cohérent : jamais de déplacement isolé, donc
  // arbitrage humain plutôt qu'une proposition hors secteur.
  if (creneaux.length < 2) {
    actions.push({
      json: {
        __action: 'candidat',
        id: candidat.id,
        statut: 'arbitrage',
        arbitrage_depuis: new Date().toISOString(),
        motif: 'Aucun créneau disponible lors de la relance',
      },
    });
    continue;
  }

  const expiration = ERA.calendrier.expirationBlocage(new Date(), feries).toISOString();

  actions.push({
    json: {
      __action: 'candidat',
      id: candidat.id,
      nb_relances: Number(candidat.nb_relances || 0) + 1,
    },
  });
  actions.push({
    json: {
      __action: 'sms',
      candidat_id: candidat.id,
      mobile: candidat.mobile,
      texte: ERA.messages.relanceCreneaux({ creneaux, temps: ERA.temps }),
      type_message: 'relance_creneaux',
      envoyer_apres: new Date().toISOString(),
    },
  });
  creneaux.forEach((creneau, index) => {
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

// Séquences bloquées : signalées, jamais réparées automatiquement.
const bloquees = contexte.bloquees || [];
if (bloquees.length) {
  actions.push({
    json: {
      __action: 'telegram',
      chat_id: parametres.chat_id,
      texte: [
        \`<b>\${bloquees.length} séquence(s) sans suite</b>\`,
        ...bloquees.map((b) => \`• \${b.nom || 'Candidat'} — \${b.mobile} (étape \${b.etape_sms})\`),
      ].join('\\n'),
    },
  });
}

return actions;`;

function filtre(action) {
  return `return $input.all()
  .filter((item) => item.json.__action === '${action}')
  .map((item) => {
    const { __action, ...reste } = item.json;
    return { json: reste };
  });`;
}

module.exports = {
  fichier: 'wf2quater-expiration-relance.json',
  description:
    'Toutes les 15 minutes : libère les créneaux expirés, envoie une relance unique, puis abandonne.',

  construire(socle) {
    const f = fabrique('ERA · WF-2 quater · Expiration et relance');

    f.planification('Toutes les 15 minutes', [-480, 400], {
      interval: [{ field: 'minutes', minutesInterval: 15 }],
    });
    noeudParametres(f, [-260, 400]);
    f.requete('Créneaux expirés', [-40, 400], EXPIRES);
    f.code('Fenêtre de lecture', [180, 400], FENETRE);
    f.agendaLire('Google Agenda — occupation', [400, 400]);
    f.code('Relancer ou abandonner', [620, 400], DECIDER, { socle });

    f.code('Branche — fiche candidat', [860, 200], filtre('candidat'));
    f.mettreAJour('Mettre à jour la fiche', [1080, 200], 'candidats');
    f.code('Branche — messages', [860, 360], filtre('sms'));
    f.inserer('Mettre en file', [1080, 360], 'file_sms');
    f.code('Branche — créneaux', [860, 520], filtre('creneau'));
    f.remplacerCreneau('Bloquer les créneaux', [1080, 520]);
    f.code('Branche — libération', [860, 840], filtre('liberer'));
    f.requete('Supprimer les propositions périmées', [1080, 840], LIBERER, {
      remplacements: '={{ $json.candidat_id }}',
    });
    f.code('Branche — alerte', [860, 680], filtre('telegram'));
    f.telegram('Prévenir sur Telegram', [1080, 680]);

    f.chaine(
      'Toutes les 15 minutes',
      'Paramètres',
      'Créneaux expirés',
      'Fenêtre de lecture',
      'Google Agenda — occupation',
      'Relancer ou abandonner',
    );
    for (const [branche, ecriture] of [
      ['Branche — fiche candidat', 'Mettre à jour la fiche'],
      ['Branche — messages', 'Mettre en file'],
      ['Branche — créneaux', 'Bloquer les créneaux'],
      ['Branche — libération', 'Supprimer les propositions périmées'],
      ['Branche — alerte', 'Prévenir sur Telegram'],
    ]) {
      f.relier('Relancer ou abandonner', branche);
      f.relier(branche, ecriture);
    }

    return f.construire({ description: module.exports.description });
  },
};
