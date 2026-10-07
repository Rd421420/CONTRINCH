/**
 * WF-5 bis · Récapitulatif Telegram de 18 h.
 *
 * Destinataire unique : toi. Les conseillers ne reçoivent rien.
 *
 * La file différée s'accumule dans la journée et part en UN SEUL message,
 * dans le bloc « Clôture — micro-tâches ». Deux notifications par jour
 * arrivées n'importe quand, c'est exactement le mécanisme de dispersion
 * que la semaine type cherche à supprimer.
 */

const { fabrique, noeudParametres } = require('../lib');

const A_TRAITER = `-- Une seule ligne : la liste complète des dossiers en attente
-- d'arbitrage jamais encore signalés.
SELECT COALESCE(json_agg(row_to_json(d) ORDER BY d.cree_le), '[]'::json) AS dossiers
FROM (
    SELECT c.id, c.nom, c.mobile, c.situation, c.garantie,
           c.verdict, c.motif, c.revenus_nets, c.cree_le,
           l.reference, l.commune, l.loyer_cc
    FROM locatif.candidats c
    LEFT JOIN locatif.lots l ON l.reference = c.ref_lot
    WHERE c.statut = 'arbitrage'
      AND c.notifie_le IS NULL
) d;`;

const COMPOSER = `const parametres = $('Paramètres').first().json;
const dossiers = $input.first().json.dossiers || [];

// Rien à arbitrer : aucun message. Un récapitulatif vide tous les soirs
// apprend surtout à ne plus lire les récapitulatifs.
if (!dossiers.length) return [];

const lignes = dossiers.map((d, i) => [
  \`<b>\${i + 1}. \${d.nom || 'Candidat'}</b> — \${d.mobile || '—'}\`,
  \`    \${d.reference || '—'} \${d.commune || ''} · \${d.loyer_cc || '?'} € CC\`,
  \`    \${d.situation || 'situation inconnue'} · garantie : \${d.garantie || '—'}\`,
  \`    \${d.motif || d.verdict || 'sans motif'}\`,
  \`    /pieces \${d.id}\`,
].join('\\n'));

return [{
  json: {
    chat_id: parametres.chat_id,
    ids: dossiers.map((d) => d.id).join('|'),
    texte: [
      \`<b>Arbitrages du jour — \${dossiers.length} dossier(s)</b>\`,
      '',
      ...lignes,
    ].join('\\n\\n'),
  },
}];`;

const MARQUER = `-- Marqué seulement après l'envoi : un échec Telegram doit laisser les
-- dossiers dans la file, pas les faire disparaître silencieusement.
--
-- Les identifiants arrivent séparés par « | » et non par une virgule :
-- n8n découpe la liste des paramètres sur les virgules, une valeur qui en
-- contient décalerait tous les paramètres suivants.
UPDATE locatif.candidats
SET notifie_le = now()
WHERE id = ANY (string_to_array($1::text, '|')::bigint[]);`;

module.exports = {
  fichier: 'wf5bis-recapitulatif-telegram.json',
  description:
    'À 18 h les jours ouvrés : un seul message Telegram récapitulant tous les dossiers à arbitrer.',

  construire(socle) {
    const f = fabrique('ERA · WF-5 bis · Récapitulatif de 18 h');

    f.planification('Chaque jour ouvré à 18 h', [-480, 300], {
      interval: [{ field: 'cronExpression', expression: '0 18 * * 1-5' }],
    });
    noeudParametres(f, [-260, 300]);
    f.requete('Dossiers à arbitrer', [-40, 300], A_TRAITER);
    f.code('Composer le récapitulatif', [180, 300], COMPOSER);
    f.telegram('Envoyer le récapitulatif', [400, 300]);
    f.requete('Marquer comme signalés', [620, 300], MARQUER, {
      remplacements: "={{ $('Composer le récapitulatif').first().json.ids }}",
    });

    f.chaine(
      'Chaque jour ouvré à 18 h',
      'Paramètres',
      'Dossiers à arbitrer',
      'Composer le récapitulatif',
      'Envoyer le récapitulatif',
      'Marquer comme signalés',
    );

    return f.construire({ description: module.exports.description });
  },
};
