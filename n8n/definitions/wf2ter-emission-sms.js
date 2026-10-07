/**
 * WF-2 ter · Émission des SMS.
 *
 * Seul endroit du dispositif qui envoie un message, et seul endroit qui
 * connaît la plage d'envoi. Tout le reste écrit dans `file_sms` sans se
 * demander l'heure qu'il est.
 *
 * Un message resté en file parce qu'il est 22 h partira le lendemain 9 h,
 * sans qu'aucune exécution n'ait besoin de rester en attente : une purge
 * qui ne tourne pas est une purge qui n'a pas lieu, et le raisonnement
 * vaut aussi pour une file d'attente en mémoire.
 */

const { fabrique, noeudParametres } = require('../lib');

const A_ENVOYER = `-- Une seule ligne, portant deux agrégats JSON : le référentiel de fériés
-- et les messages dus. Un node Postgres renvoie un item par ligne — sans
-- cette agrégation, les fériés multiplieraient les items.
SELECT
  (
    SELECT COALESCE(json_agg(j.jour), '[]'::json)
    FROM locatif.jours_feries j
    WHERE j.jour >= current_date - 7
  ) AS jours_feries,
  (
    SELECT COALESCE(json_agg(row_to_json(m)), '[]'::json)
    FROM (
      SELECT id, candidat_id, mobile, texte, type_message
      FROM locatif.file_sms
      WHERE envoye_le IS NULL
        AND envoyer_apres <= now()
        AND tentatives < 5
      ORDER BY envoyer_apres
      LIMIT 20
    ) m
  ) AS messages;`;

const FILTRER = `// La règle des heures ouvrées est appliquée par le socle, pas réécrite
// ici : lundi–vendredi, 9 h – 19 h, jours fériés exclus.
const { jours_feries: feries, messages } = $input.first().json;
const parametres = $('Paramètres').first().json;

if (!ERA.calendrier.dansPlageEnvoi(new Date(), feries || [])) {
  // Hors plage : rien ne part, les messages restent en file. La prochaine
  // exécution qui tombe dans la plage les prendra.
  return [];
}

return (messages || []).map((message) => ({
  json: { ...message, expediteur: parametres.expediteur },
}));`;

const RESULTAT = `// Le node Twilio est en « continuer malgré l'erreur » : un échec ne doit
// pas bloquer les autres messages de la fournée. On relit donc son résultat
// item par item pour distinguer l'envoi réussi de l'échec.
const sortie = [];
const items = $input.all();

for (let i = 0; i < items.length; i += 1) {
  let message;
  try {
    message = $('Messages à envoyer').itemMatching(i).json;
  } catch (e) {
    message = $('Messages à envoyer').all()[i].json;
  }
  const resultat = items[i].json || {};

  sortie.push({
    json: {
      id: message.id,
      sid: resultat.sid || '',
      // Les virgules sont remplacées : n8n découpe la liste des paramètres
      // SQL dessus, et un message Twilio en contient presque toujours.
      erreur: resultat.sid
        ? ''
        : String(resultat.error || resultat.message || 'échec Twilio').replace(/,/g, ';').slice(0, 500),
    },
  });
}
return sortie;`;

const MARQUER = `-- Un envoi réussi porte un SID : il clôt la ligne. Un échec incrémente
-- seulement le compteur, et la ligne repassera — cinq fois au plus, après
-- quoi la requête d'émission ne la reprend plus.
UPDATE locatif.file_sms
SET envoye_le  = CASE WHEN $2 <> '' THEN now() ELSE envoye_le END,
    sid_twilio = NULLIF($2, ''),
    tentatives = tentatives + 1,
    erreur     = NULLIF($3, '')
WHERE id = $1::bigint;`;

module.exports = {
  fichier: 'wf2ter-emission-sms.json',
  description:
    'Toutes les 5 minutes : vide la file des SMS dus, mais uniquement dans la plage lundi–vendredi 9 h–19 h.',

  construire(socle) {
    const f = fabrique('ERA · WF-2 ter · Émission des SMS');

    f.planification('Toutes les 5 minutes', [-260, 300], {
      interval: [{ field: 'minutes', minutesInterval: 5 }],
    });
    noeudParametres(f, [-40, 300]);
    f.requete('Messages dus et jours fériés', [180, 300], A_ENVOYER);
    f.code('Messages à envoyer', [400, 300], FILTRER, { socle });
    f.twilio('Twilio — envoyer', [620, 300], { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 2 });
    f.code('Résultat d’envoi', [840, 300], RESULTAT);
    f.requete('Clore la ligne de file', [1060, 300], MARQUER, {
      remplacements: '={{ $json.id }}, {{ $json.sid }}, {{ $json.erreur }}',
    });

    f.chaine(
      'Toutes les 5 minutes',
      'Paramètres',
      'Messages dus et jours fériés',
      'Messages à envoyer',
      'Twilio — envoyer',
      'Résultat d’envoi',
      'Clore la ligne de file',
    );

    return f.construire({ description: module.exports.description });
  },
};
