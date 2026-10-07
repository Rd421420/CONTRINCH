const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluer, messageCandidat, CONFIG } = require('../src/eligibilite');

test('CDI : 2,70 × le loyer CC suffit, un euro de moins ne suffit pas', () => {
  assert.equal(evaluer({ loyer_cc: 700, situation: 'cdi', revenus_nets: 1892 }).verdict, 'eligible');
  assert.equal(evaluer({ loyer_cc: 700, situation: 'cdi', revenus_nets: 1800 }).verdict, 'hors_criteres');
});

test('les revenus complémentaires sont pondérés à 25 %, pas additionnés', () => {
  // Cas du cahier des charges §4 : 1 750 € en CDI + 250 € d'APL → 710 € de capacité.
  const sans = evaluer({ loyer_cc: 700, situation: 'cdi', revenus_nets: 1750 });
  const avec = evaluer({ loyer_cc: 700, situation: 'cdi', revenus_nets: 1750, aide_logement: 250 });

  assert.equal(sans.verdict, 'hors_criteres');
  assert.equal(avec.verdict, 'eligible');
  assert.equal(avec.capacite_loyer, 710);
});

test('CDD de plus de 12 mois : taux de 25 %, soit 4 × le loyer', () => {
  assert.equal(
    evaluer({ loyer_cc: 500, situation: 'cdd', duree_contrat_mois: 24, revenus_nets: 2000 }).verdict,
    'eligible',
  );
  assert.equal(
    evaluer({ loyer_cc: 500, situation: 'cdd', duree_contrat_mois: 24, revenus_nets: 1900 }).verdict,
    'hors_criteres',
  );
});

test('CDD de 12 mois ou moins : exclusion sèche, quels que soient les revenus', () => {
  const r = evaluer({ loyer_cc: 500, situation: 'interim', duree_contrat_mois: 12, revenus_nets: 6000 });
  assert.equal(r.verdict, 'non_assurable');
});

test('CDD sans durée renseignée : rien n’est décidé', () => {
  assert.equal(
    evaluer({ loyer_cc: 500, situation: 'cdd', revenus_nets: 6000 }).verdict,
    'donnees_incompletes',
  );
});

test('préavis et saisie sur salaire sont des exclusions sèches', () => {
  assert.equal(evaluer({ loyer_cc: 500, situation: 'cdi', revenus_nets: 4000, preavis: true }).verdict, 'non_assurable');
  assert.equal(
    evaluer({ loyer_cc: 500, situation: 'cdi', revenus_nets: 4000, saisie_sur_salaire: true }).verdict,
    'non_assurable',
  );
});

test('caution unique : seuil à 3,03 × le loyer', () => {
  const seuil = Math.round((600 / CONFIG.TAUX_GARANT) * 100) / 100; // ≈ 1 818,18 €
  assert.equal(
    evaluer({ loyer_cc: 600, situation: 'etudiant', cautions: [seuil] }).verdict,
    'eligible',
  );
  assert.equal(
    evaluer({ loyer_cc: 600, situation: 'etudiant', cautions: [1700] }).verdict,
    'hors_criteres',
  );
});

test('pluralité de cautions : 2 × le loyer par tête, sans cumul des revenus', () => {
  // 1 300 + 1 300 = 2 600 : le cumul passerait le seuil unique, mais chaque
  // cautionnaire s'engage pour la totalité et doit tenir 1 200 € seul.
  assert.equal(
    evaluer({ loyer_cc: 600, situation: 'etudiant', cautions: [1300, 1300] }).verdict,
    'eligible',
  );
  assert.equal(
    evaluer({ loyer_cc: 600, situation: 'etudiant', cautions: [2500, 1100] }).verdict,
    'hors_criteres',
  );
});

test('reste à vivre : dérogatoire, retraité en T2', () => {
  const r = evaluer({
    loyer_cc: 700, situation: 'retraite', revenus_nets: 1300,
    logement_type: 'T2', couple: false,
  });
  assert.equal(r.verdict, 'eligible');
  assert.equal(r.base, 'reste_a_vivre');
});

test('reste à vivre : le seuil couple est plus élevé', () => {
  const base = { loyer_cc: 700, situation: 'retraite', revenus_nets: 1300, logement_type: 'T2' };
  assert.equal(evaluer({ ...base, couple: true }).verdict, 'hors_criteres');
});

test('reste à vivre : ne s’applique pas au-delà du T3', () => {
  assert.equal(
    evaluer({ loyer_cc: 700, situation: 'retraite', revenus_nets: 1300, logement_type: 'T4' }).verdict,
    'hors_criteres',
  );
});

test('Visale : le montant du visa tranche, pas le taux d’effort', () => {
  const commun = { loyer_cc: 700, situation: 'cdi', revenus_nets: 4000, garantie: 'visale', zone_visale: 3 };

  const couvert = evaluer({ ...commun, visale_visa_obtenu: true, visale_montant_visa: 750 });
  assert.equal(couvert.verdict, 'eligible');

  const insuffisant = evaluer({ ...commun, visale_visa_obtenu: true, visale_montant_visa: 600 });
  assert.equal(insuffisant.verdict, 'hors_criteres');
  assert.match(insuffisant.motif, /écart de 100 €/);
});

test('Visale sans visa : pré-vérification seulement, jamais un verdict d’éligibilité', () => {
  const r = evaluer({
    loyer_cc: 700, situation: 'cdi', revenus_nets: 1600,
    garantie: 'visale', visale_visa_obtenu: false, zone_visale: 3,
  });
  assert.equal(r.verdict, 'a_verifier_visale');
});

test('Visale : loyer au-dessus du plafond de zone', () => {
  const r = evaluer({
    loyer_cc: 1400, situation: 'cdi', revenus_nets: 6000,
    garantie: 'visale', visale_visa_obtenu: false, zone_visale: 3,
  });
  assert.equal(r.verdict, 'hors_criteres');
  assert.match(r.motif, /plafond Visale/);
});

test('Visale : non cumulable avec une caution physique ni avec la GLI du mandat', () => {
  assert.equal(
    evaluer({ loyer_cc: 700, situation: 'cdi', revenus_nets: 4000, garantie: 'visale', cautions: [3000] }).verdict,
    'a_qualifier',
  );
  assert.equal(
    evaluer({ loyer_cc: 700, situation: 'cdi', revenus_nets: 4000, garantie: 'visale', lot_accepte_visale: false }).verdict,
    'a_qualifier',
  );
});

test('garantie hors grille et demande de conseiller sortent sans calcul', () => {
  assert.equal(evaluer({ loyer_cc: 700, situation: 'cdi', revenus_nets: 900, garantie: 'autre' }).verdict, 'a_qualifier');
  assert.equal(evaluer({ loyer_cc: 700, situation: 'cdi', revenus_nets: 900, garantie: 'conseiller' }).verdict, 'a_qualifier');
});

test('plafond assurable : garde-fou à 5 000 € CC', () => {
  assert.equal(evaluer({ loyer_cc: 5200, situation: 'cdi', revenus_nets: 30000 }).verdict, 'non_assurable');
});

test('situation hors grille : arbitrage humain, pas de refus', () => {
  assert.equal(evaluer({ loyer_cc: 700, situation: 'autre', revenus_nets: 3000 }).verdict, 'a_qualifier');
});

test('un CDI en échec sur ses revenus peut être rattrapé par son garant', () => {
  const r = evaluer({ loyer_cc: 600, situation: 'cdi', revenus_nets: 1200, garant: true, revenus_garant: 2000 });
  assert.equal(r.verdict, 'eligible');
  assert.equal(r.base, 'caution');
});

test('AUCUN message candidat n’annonce ni ne sous-entend un refus', () => {
  const verdicts = ['hors_criteres', 'non_assurable', 'a_qualifier', 'donnees_incompletes', 'inconnu'];
  for (const verdict of verdicts) {
    const texte = messageCandidat({ verdict });
    assert.equal(texte, 'Merci pour ces éléments. Votre demande est transmise à un conseiller, qui revient vers vous rapidement.');
    assert.doesNotMatch(texte, /refus|ne correspond pas|insuffisant|critères|seuil|€/i);
  }
});

test('le message favorable dit « semble compatible », jamais « correspond »', () => {
  const texte = messageCandidat({ verdict: 'eligible' });
  assert.match(texte, /semble compatible/);
  assert.match(texte, /étudié sur pièces après la visite/);
  assert.doesNotMatch(texte, /assurance|loyers impayés|GLI|Mila/i);
});

test('le motif interne porte les montants, le message candidat jamais', () => {
  const r = evaluer({ loyer_cc: 700, situation: 'cdi', revenus_nets: 1200 });
  assert.match(r.motif, /1200|1200 €|seuil/);
  assert.doesNotMatch(messageCandidat(r), /1200|seuil/);
});
