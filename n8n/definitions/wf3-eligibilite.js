/**
 * WF-3 · Calcul d'éligibilité — rejouable seul.
 *
 * La checklist §8 demande de construire celui-ci en premier et de le
 * rejouer sur vingt dossiers passés dont l'issue est connue. Le workflow a
 * donc deux entrées : un déclencheur manuel avec des dossiers d'exemple,
 * et une entrée de sous-workflow pour l'appeler depuis ailleurs.
 *
 * Entièrement déterministe. Aucune IA, aucun appel externe.
 */

const { fabrique } = require('../lib');

const EXEMPLES = `// Remplace ces dossiers par les tiens : vingt cas dont tu connais déjà
// l'issue, et compare la colonne « verdict » à ce que tu avais décidé.
return [
  { json: { ref: 'CDI limite', loyer_cc: 700, situation: 'cdi', revenus_nets: 1750 } },
  { json: { ref: 'CDI + APL', loyer_cc: 700, situation: 'cdi', revenus_nets: 1750, aide_logement: 250 } },
  { json: { ref: 'CDD 6 mois', loyer_cc: 500, situation: 'cdd', duree_contrat_mois: 6, revenus_nets: 2400 } },
  { json: { ref: 'CDD 24 mois', loyer_cc: 500, situation: 'cdd', duree_contrat_mois: 24, revenus_nets: 2100 } },
  { json: { ref: 'Etudiant, 2 cautions', loyer_cc: 600, situation: 'etudiant', garantie: 'caution', cautions: [1300, 1300] } },
  { json: { ref: 'Etudiant, 2 cautions dont une faible', loyer_cc: 600, situation: 'etudiant', garantie: 'caution', cautions: [2500, 1100] } },
  { json: { ref: 'Retraite T2 seul', loyer_cc: 700, situation: 'retraite', revenus_nets: 1300, logement_type: 'T2', couple: false } },
  { json: { ref: 'Visale visa 600', loyer_cc: 700, situation: 'cdi', revenus_nets: 4000, garantie: 'visale', visale_visa_obtenu: true, visale_montant_visa: 600, zone_visale: 3 } },
  { json: { ref: 'Visale sans visa', loyer_cc: 700, situation: 'cdi', revenus_nets: 2000, garantie: 'visale', visale_visa_obtenu: false, zone_visale: 3 } },
  { json: { ref: 'Garantie hors grille', loyer_cc: 700, situation: 'cdi', revenus_nets: 3000, garantie: 'autre' } },
];`;

const EVALUER = `// Le calcul et le message sont séparés à dessein : le motif porte les
// seuils et les montants, il reste interne (Telegram, refus_log). Le
// message candidat n'en contient jamais.
return $input.all().map((item) => {
  const resultat = ERA.evaluer(item.json);
  return {
    json: {
      ...item.json,
      ...resultat,
      message_candidat: ERA.messageCandidat(resultat),
      // Rappel : aucun verdict ne vaut décision. Tout ce qui n'est pas
      // favorable part en revue humaine.
      favorable: ['eligible', 'a_verifier_visale'].includes(resultat.verdict),
    },
  };
});`;

module.exports = {
  fichier: 'wf3-eligibilite.json',
  description:
    'Calcul déterministe du taux d’effort. Deux entrées : déclencheur manuel pour rejouer d’anciens dossiers, et appel en sous-workflow.',

  construire(socle) {
    const f = fabrique('ERA · WF-3 · Calcul d’éligibilité');

    f.manuel('Rejouer des dossiers', [-260, 200]);
    f.code('Dossiers d’exemple', [-40, 200], EXEMPLES);
    f.sousWorkflow('Appel depuis un autre workflow', [-40, 420], [
      'loyer_cc', 'situation', 'revenus_nets', 'revenus_complementaires',
      'aide_logement', 'garantie', 'cautions', 'duree_contrat_mois',
      'logement_type', 'couple', 'zone_visale', 'visale_visa_obtenu',
      'visale_montant_visa', 'lot_accepte_visale',
    ]);
    f.code('Évaluer', [220, 300], EVALUER, { socle });

    f.relier('Rejouer des dossiers', 'Dossiers d’exemple');
    f.relier('Dossiers d’exemple', 'Évaluer');
    f.relier('Appel depuis un autre workflow', 'Évaluer');

    return f.construire({ description: module.exports.description });
  },
};
