/**
 * WF-2 · Séquence SMS — démarrage.
 *
 * Prend les fiches `nouveau` et envoie le SMS 1. La requête réserve les
 * lignes et les fait passer à `en_cours` dans le même mouvement
 * (FOR UPDATE SKIP LOCKED) : deux exécutions qui se chevauchent ne peuvent
 * pas envoyer deux fois le même premier message.
 */

const { fabrique, noeudParametres } = require('../lib');

const RESERVER = `-- Réserve les fiches et les fait passer à « en_cours » dans la même
-- transaction : c'est ce qui garantit qu'un candidat ne reçoit jamais deux
-- fois le SMS 1, même si deux exécutions se chevauchent.
WITH reservees AS (
    UPDATE locatif.candidats
    SET statut        = 'en_cours',
        dernier_envoi = now(),
        purge_le      = COALESCE(purge_le, cree_le + INTERVAL '30 days')
    WHERE id IN (
        SELECT id
        FROM locatif.candidats
        WHERE statut = 'nouveau'
          AND mobile IS NOT NULL
          AND ref_lot IS NOT NULL
        ORDER BY cree_le
        LIMIT 20
        FOR UPDATE SKIP LOCKED
    )
    RETURNING id, mobile, ref_lot
)
SELECT r.id AS candidat_id,
       r.mobile,
       row_to_json(l) AS lot
FROM reservees r
JOIN locatif.lots l ON l.reference = r.ref_lot;`;

const PREMIER_MESSAGE = `// Le socle décide du texte ET de l'étape à écrire : la machine à états
// vit dans src/sequence.js, jamais dans le workflow.
const sortie = [];

for (const item of $input.all()) {
  const { candidat_id, mobile, lot } = item.json;
  const depart = ERA.sequence.demarrer({ lot });

  for (const message of depart.envois) {
    sortie.push({
      json: {
        candidat_id,
        mobile,
        texte: message.texte,
        type_message: message.type,
        // La plage 9 h – 19 h n'est PAS appliquée ici : c'est le workflow
        // d'émission qui la fait respecter, en un seul endroit.
        envoyer_apres: new Date().toISOString(),
      },
    });
  }

  // L'étape décidée par le socle est reportée en base par le node suivant.
  sortie[sortie.length - 1].json.etape_sms = depart.patch.etape_sms;
}
return sortie;`;

const MARQUER = `-- L'étape vient du socle, pas d'une constante recopiée dans le workflow.
UPDATE locatif.candidats
SET etape_sms = $2::smallint
WHERE id = $1::bigint;`;

module.exports = {
  fichier: 'wf2-sequence-demarrage.json',
  description:
    'Toutes les 5 minutes : prend les fiches candidat nouvelles et met le SMS 1 en file d’attente.',

  construire(socle) {
    const f = fabrique('ERA · WF-2 · Séquence SMS — démarrage');

    f.planification('Toutes les 5 minutes', [-260, 300], {
      interval: [{ field: 'minutes', minutesInterval: 5 }],
    });
    noeudParametres(f, [-40, 300]);
    f.requete('Réserver les fiches nouvelles', [180, 300], RESERVER);
    f.code('Premier message', [400, 300], PREMIER_MESSAGE, { socle });
    f.inserer('Mettre en file', [620, 300], 'file_sms');
    f.requete('Enregistrer l’étape', [840, 300], MARQUER, {
      remplacements: '={{ $json.candidat_id }}, {{ $(\'Premier message\').item.json.etape_sms }}',
    });

    f.chaine(
      'Toutes les 5 minutes',
      'Paramètres',
      'Réserver les fiches nouvelles',
      'Premier message',
      'Mettre en file',
      'Enregistrer l’étape',
    );

    return f.construire({ description: module.exports.description });
  },
};
