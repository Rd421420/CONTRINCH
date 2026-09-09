/**
 * WF-8 · Dossiers en attente d'arbitrage.
 *
 * Le trou que ce workflow bouche : un dossier passait en `arbitrage`,
 * partait dans le récapitulatif de 18 h, `notifie_le` était posé — et plus
 * rien ne le faisait jamais remonter. Si tu ne le traitais pas ce soir-là,
 * le candidat attendait indéfiniment, sans que personne ne s'en aperçoive.
 *
 * Trois différences avec le récapitulatif de 18 h, qui expliquent pourquoi
 * c'est un workflow séparé et non une option du premier :
 *
 *   — le récapitulatif annonce ce qui vient d'arriver, celui-ci rappelle ce
 *     qui traîne ; l'un se lit le soir, l'autre le matin ;
 *   — un dossier n'y apparaît qu'une fois, ici il revient tant qu'il est
 *     ouvert — et c'est voulu : un dossier qu'on oublie doit rester bruyant ;
 *   — celui-ci écrit au candidat quand l'attente devient longue, l'autre
 *     jamais.
 *
 * Seule la commande /traite arrête la relance.
 */

const { fabrique, noeudParametres } = require('../lib');

const EN_ATTENTE = `-- Dossiers ouverts, absence en cours, et le référentiel de fériés qui sert
-- à mesurer l'âge en jours ouvrés. Une ligne unique, agrégats JSON.
SELECT
  (
    SELECT row_to_json(a)
    FROM locatif.absences a
    WHERE current_date BETWEEN a.debut AND a.fin
    ORDER BY a.debut DESC
    LIMIT 1
  ) AS absence,
  (
    -- Portée large : l'âge se mesure depuis l'entrée en file, qui peut
    -- remonter à plusieurs semaines sur un dossier oublié.
    SELECT COALESCE(json_agg(j.jour), '[]'::json)
    FROM locatif.jours_feries j
    WHERE j.jour >= current_date - 60
  ) AS jours_feries,
  (
    SELECT COALESCE(json_agg(row_to_json(d) ORDER BY d.depuis), '[]'::json)
    FROM (
      SELECT c.id, c.nom, c.mobile, c.situation, c.garantie,
             c.verdict, c.motif, c.relances_arbitrage,
             COALESCE(c.arbitrage_depuis, c.notifie_le, c.cree_le) AS depuis,
             l.reference, l.commune, l.loyer_cc
      FROM locatif.candidats c
      LEFT JOIN locatif.lots l ON l.reference = c.ref_lot
      WHERE c.statut = 'arbitrage'
        AND c.arbitre_le IS NULL
    ) d
  ) AS dossiers;`;

const TRIER = `// L'âge se compte en jours OUVRÉS : un dossier tombé le vendredi soir n'a
// pas vieilli le lundi matin, il a vieilli d'un jour.
const parametres = $('Paramètres').first().json;
const { absence, jours_feries: feries, dossiers } = $input.first().json;
const maintenant = new Date();

const enAbsence = Boolean(absence);
const destinataire = (enAbsence && absence.chat_id_suppleant) || parametres.chat_id;

// Pendant une absence, le délai avant le mot d'attente se resserre : c'est
// justement quand personne n'arbitre qu'il ne faut pas laisser un candidat
// sans nouvelles pendant une semaine.
const seuilAttente = enAbsence
  ? ERA.config.ARBITRAGE_ATTENTE_ABSENCE_JOURS
  : ERA.config.ARBITRAGE_ATTENTE_JOURS;

const actions = [];
const aRappeler = [];

for (const dossier of dossiers || []) {
  const age = ERA.calendrier.joursOuvresEntre(new Date(dossier.depuis), maintenant, feries || []);
  if (age < ERA.config.ARBITRAGE_RAPPEL_JOURS) continue;

  const urgent = age >= seuilAttente;
  aRappeler.push({ ...dossier, age, urgent });

  // Un seul mot d'attente par dossier, et seulement s'il y a un mobile.
  if (urgent && Number(dossier.relances_arbitrage) === 0 && dossier.mobile) {
    actions.push({
      json: {
        __action: 'sms',
        candidat_id: dossier.id,
        mobile: dossier.mobile,
        texte: ERA.messages.attenteArbitrage(),
        type_message: 'attente_arbitrage',
        envoyer_apres: maintenant.toISOString(),
      },
    });
    actions.push({
      json: { __action: 'candidat', id: dossier.id, relances_arbitrage: 1 },
    });
  }
}

// Rien qui traîne : aucun message. Une alerte quotidienne qui dit « rien à
// signaler » apprend surtout à ne plus lire les alertes.
if (!aRappeler.length) return actions;

const lignes = aRappeler.map((d) => [
  \`\${d.urgent ? '🔴' : '•'} <b>\${d.nom || 'Candidat'}</b> — \${d.mobile || '—'}\`,
  \`    \${d.reference || '—'} \${d.commune || ''} · \${d.loyer_cc || '?'} € CC\`,
  \`    \${d.motif || d.verdict || 'sans motif'}\`,
  \`    en attente depuis \${d.age} jour\${d.age > 1 ? 's' : ''} ouvré\${d.age > 1 ? 's' : ''}\`,
  \`    /traite \${d.id}\`,
].join('\\n'));

const entete = enAbsence
  ? [
    \`<b>Arbitrages en attente — \${aRappeler.length}</b>\`,
    \`Absence déclarée jusqu'au \${absence.fin}.\`,
    absence.chat_id_suppleant
      ? 'Tu reçois ces dossiers en suppléance.'
      : 'Aucun suppléant déclaré : les candidats reçoivent un mot d’attente plus tôt.',
  ]
  : [\`<b>Arbitrages en attente — \${aRappeler.length}</b>\`];

actions.push({
  json: {
    __action: 'telegram',
    chat_id: destinataire,
    texte: [...entete, '', ...lignes, '', 'Un dossier revient chaque matin tant qu’il n’est pas clos par /traite.'].join('\\n\\n'),
  },
});

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
  fichier: 'wf8-arbitrages-en-attente.json',
  description:
    'Chaque matin : rappelle les dossiers d’arbitrage non clos, et écrit au candidat quand l’attente s’allonge.',

  construire(socle) {
    const f = fabrique('ERA · WF-8 · Arbitrages en attente');

    f.planification('Chaque jour ouvré à 9 h', [-480, 300], {
      interval: [{ field: 'cronExpression', expression: '0 9 * * 1-5' }],
    });
    noeudParametres(f, [-260, 300]);
    f.requete('Dossiers non clos', [-40, 300], EN_ATTENTE);
    f.code('Trier par ancienneté', [180, 300], TRIER, { socle });

    f.code('Branche — rappel', [420, 180], filtre('telegram'));
    f.telegram('Rappeler sur Telegram', [640, 180]);
    f.code('Branche — mot d’attente', [420, 340], filtre('sms'));
    f.inserer('Mettre en file', [640, 340], 'file_sms');
    f.code('Branche — fiche candidat', [420, 500], filtre('candidat'));
    f.mettreAJour('Compter le mot d’attente', [640, 500], 'candidats');

    f.chaine('Chaque jour ouvré à 9 h', 'Paramètres', 'Dossiers non clos', 'Trier par ancienneté');
    for (const [branche, ecriture] of [
      ['Branche — rappel', 'Rappeler sur Telegram'],
      ['Branche — mot d’attente', 'Mettre en file'],
      ['Branche — fiche candidat', 'Compter le mot d’attente'],
    ]) {
      f.relier('Trier par ancienneté', branche);
      f.relier(branche, ecriture);
    }

    return f.construire({ description: module.exports.description });
  },
};
