const test = require('node:test');
const assert = require('node:assert/strict');

const { ETAPE, demarrer, traiterReponse } = require('../src/sequence');
const T = require('../src/temps');

const LOT = {
  reference: '677',
  commune: 'SAINT CYPRIEN',
  adresse: '9 Impasse Jordi Barre 66750 SAINT CYPRIEN',
  loyer_cc: 700,
  type_lot: 'T3',
  accepte_visale: true,
  zone_visale: 3,
};

const CRENEAUX = [
  { debut: T.instant(2026, 9, 9, 14, 0), fin: T.instant(2026, 9, 9, 14, 30) },
  { debut: T.instant(2026, 9, 9, 16, 0), fin: T.instant(2026, 9, 9, 16, 30) },
];

function contexte(extra = {}) {
  return {
    lot: LOT,
    temps: T,
    proposerCreneaux: () => CRENEAUX,
    creneauxProposes: CRENEAUX,
    ...extra,
  };
}

/** Rejoue une conversation entière et renvoie l'état final plus la trace. */
function conversation(reponses, ctx = contexte()) {
  let candidat = { etape_sms: ETAPE.NOUVEAU, statut: 'nouveau' };
  const trace = [];

  const ouverture = demarrer({ lot: LOT });
  candidat = { ...candidat, ...ouverture.patch };
  trace.push(ouverture);

  for (const texte of reponses) {
    const etape = traiterReponse(candidat, texte, ctx);
    candidat = { ...candidat, ...etape.patch };
    trace.push(etape);
    if (candidat.etape_sms === ETAPE.TERMINE) break;
  }
  return { candidat, trace };
}

function textes(trace) {
  return trace.flatMap((e) => e.envois.map((x) => x.type));
}

const CANDIDAT_RDV = { etape_sms: ETAPE.CRENEAU, statut: 'en_cours', verdict: 'eligible' };

test('parcours nominal CDI sans garantie : verdict favorable puis rendez-vous posé', () => {
  const { candidat, trace } = conversation(['1 3', '2500', '0', 'A']);

  assert.equal(candidat.situation, 'cdi');
  assert.equal(candidat.garantie, 'aucune');
  assert.equal(candidat.revenus_nets, 2500);
  assert.equal(candidat.verdict, 'eligible');
  assert.equal(candidat.statut, 'rdv_pose');
  assert.deepEqual(textes(trace), ['sms1', 'sms3', 'sms3bis', 'sms4a', 'sms5'],
    'la fusion supprime un aller-retour complet du parcours nominal');
});

test('les revenus complémentaires font basculer un dossier limite', () => {
  const refuse = conversation(['1 3', '1750', '0']).candidat;
  assert.equal(refuse.verdict, 'hors_criteres');
  assert.equal(refuse.statut, 'arbitrage');

  const retenu = conversation(['1 3', '1750', '250']).candidat;
  assert.equal(retenu.verdict, 'eligible');
  assert.equal(retenu.capacite_loyer, 710);
});

test('CDD : la question de durée s’intercale, et 12 mois arrête la séquence', () => {
  const { candidat, trace } = conversation(['2', 'NON']);
  assert.equal(candidat.verdict, 'non_assurable');
  assert.equal(candidat.statut, 'arbitrage');
  assert.deepEqual(textes(trace), ['sms1', 'sms1bis', 'sms4b']);
  assert.equal(trace.at(-1).sortie.motif, 'cdd_non_assurable');
});

test('CDD de plus de 12 mois : la séquence continue normalement', () => {
  const { candidat } = conversation(['2 3', 'OUI', '3000', '0', 'B']);
  assert.equal(candidat.duree_contrat_mois, 24);
  assert.equal(candidat.verdict, 'eligible');
  assert.equal(candidat.statut, 'rdv_pose');
});

test('caution : le nombre est demandé avant les montants', () => {
  const { candidat, trace } = conversation(['5 1', '2', '1500 et 1600', '0', '0', 'A']);
  assert.deepEqual(textes(trace).slice(0, 4), ['sms1', 'sms2bis', 'sms2ter', 'sms3']);
  assert.equal(candidat.nb_cautions, 2);
  assert.deepEqual(candidat.revenus_cautions, [1500, 1600]);
  // Deux cautions à 1 500 et 1 600 € pour un loyer de 700 € : seuil 1 400 € par tête.
  assert.equal(candidat.verdict, 'eligible');
});

test('pluralité de cautions : une seule caution faible suffit à écarter le dossier', () => {
  const { candidat } = conversation(['5 1', '2', '1500 et 1100', '0', '0']);
  assert.equal(candidat.verdict, 'hors_criteres');
  assert.equal(candidat.statut, 'arbitrage');
});

test('Visale avec visa : le montant du visa est demandé et tranche', () => {
  const { candidat, trace } = conversation(['1 2', 'OUI', '600', '2500', '0']);
  assert.deepEqual(textes(trace).slice(0, 4), ['sms1', 'sms2quater', 'sms2quinquies', 'sms3']);
  assert.equal(candidat.visale_montant_visa, 600);
  assert.equal(candidat.verdict, 'hors_criteres'); // visa de 600 € pour un loyer de 700 €
});

test('Visale sans visa : verdict de pré-vérification, message sous réserve', () => {
  const { candidat, trace } = conversation(['1 2', 'NON', '2000', '0']);
  assert.equal(candidat.verdict, 'a_verifier_visale');
  const sms4a = trace.flatMap((e) => e.envois).find((e) => e.type === 'sms4a');
  assert.match(sms4a.texte, /sous réserve de l'obtention de votre visa/);
});

test('garantie « autre » : sortie immédiate vers Telegram, aucun calcul', () => {
  const { candidat, trace } = conversation(['1 4']);
  assert.equal(candidat.verdict, 'a_qualifier');
  assert.deepEqual(textes(trace), ['sms1', 'sms4b']);
  assert.equal(trace.at(-1).sortie.motif, 'garantie_hors_grille');
});

test('la question du foyer n’est posée qu’aux retraités', () => {
  // Retraité, T3, 1 300 € pour un loyer de 700 € : le taux d'effort ne passe
  // pas (capacité 481 €) mais la dérogation reste à vivre, oui — 600 € > 550 €.
  const retraite = conversation(['4 3', '1300', '0', 'seul']);
  assert.ok(textes(retraite.trace).includes('sms3ter'));
  assert.equal(retraite.candidat.couple, false);
  assert.equal(retraite.candidat.verdict, 'eligible');

  // En couple, le seuil monte à 900 € : le même dossier part en arbitrage.
  const couple = conversation(['4 3', '1300', '0', 'en couple']);
  assert.equal(couple.candidat.verdict, 'hors_criteres');
  const cdi = conversation(['1', '3', '2500', '0', 'A']);
  assert.equal(textes(cdi.trace).includes('sms3ter'), false);
});

test('la dernière réponse est écrite en base, pas seulement utilisée pour le calcul', () => {
  // Régression : les revenus complémentaires servaient au verdict puis
  // disparaissaient du patch — la fiche devenait irrejouable.
  const { candidat } = conversation(['1', '3', '1750', '250']);
  assert.equal(candidat.revenus_complementaires, 250);
  assert.equal(candidat.revenus_nets, 1750);
});

test('CONSEILLER sort de la séquence à n’importe quel moment', () => {
  for (const position of [[], ['1'], ['1 3'], ['1 3', '2500']]) {
    const { candidat, trace } = conversation([...position, 'CONSEILLER']);
    assert.equal(candidat.verdict, 'a_qualifier');
    assert.equal(candidat.statut, 'arbitrage');
    assert.equal(trace.at(-1).sortie.file, 'immediate');
  }
});

test('STOP est une désinscription : aucun message de retour', () => {
  const { candidat, trace } = conversation(['STOP']);
  assert.equal(candidat.statut, 'abandon');
  assert.deepEqual(trace.at(-1).envois, []);
});

test('filet de sécurité : deux réponses incomprises d’affilée basculent sur Telegram', () => {
  const { candidat, trace } = conversation(['1', 'je ne sais pas trop', 'ça dépend']);
  assert.equal(candidat.statut, 'arbitrage');
  assert.equal(trace.at(-1).sortie.motif, 'reponses_incomprises');
  assert.deepEqual(textes(trace), ['sms1', 'sms1bis_garantie', 'incompris', 'sms4b']);
});

test('une réponse comprise remet le compteur d’échecs à zéro', () => {
  const { candidat } = conversation(['1', 'euh', '3']);
  assert.equal(candidat.echecs_parsing, 0);
  assert.equal(candidat.garantie, 'aucune');
});

test('aucun créneau cohérent : arbitrage plutôt qu’un déplacement isolé', () => {
  const { candidat, trace } = conversation(
    ['1', '3', '2500', '0'],
    contexte({ proposerCreneaux: () => [] }),
  );
  assert.equal(candidat.verdict, 'eligible');
  assert.equal(candidat.statut, 'arbitrage');
  assert.equal(trace.at(-1).sortie.motif, 'aucun_creneau_disponible');
});

test('collision à la confirmation : deux nouveaux créneaux, jamais un échec', () => {
  const rechange = [
    { debut: T.instant(2026, 9, 10, 14, 0), fin: T.instant(2026, 9, 10, 14, 30) },
    { debut: T.instant(2026, 9, 10, 16, 0), fin: T.instant(2026, 9, 10, 16, 30) },
  ];
  const { candidat, trace } = conversation(
    ['1', '3', '2500', '0', 'A'],
    contexte({ creneauEncoreLibre: () => false, reproposer: () => rechange }),
  );

  const dernier = trace.at(-1);
  assert.equal(dernier.envois[0].type, 'creneau_pris');
  assert.match(dernier.envois[0].texte, /vient d’être pris/);
  assert.equal(candidat.etape_sms, ETAPE.CRENEAU); // le compteur repart
  assert.notEqual(candidat.statut, 'rdv_pose');

  // Régression : les créneaux de rechange doivent remonter à l'appelant.
  // Sans cela ils n'étaient jamais enregistrés, la base gardait les
  // anciens, et la réponse « A » redésignait le créneau déjà pris.
  assert.deepEqual(dernier.creneaux, rechange);
});

test('AUTRE sur les créneaux : arbitrage humain, pas d’abandon', () => {
  const { candidat, trace } = conversation(['1 3', '2500', '0', 'AUTRE']);
  assert.equal(candidat.statut, 'arbitrage');
  assert.equal(trace.at(-1).sortie.motif, 'creneaux_refuses');
});

test('aucun message envoyé au candidat n’annonce un refus', () => {
  const parcours = [
    ['1 3', '900', '0'],       // hors critères
    ['2', 'NON'],              // non assurable
    ['1 4'],                   // hors grille
    ['1 3', 'bla', 'bla'],     // incompris
  ];
  for (const reponses of parcours) {
    const { trace } = conversation(reponses);
    for (const message of trace.flatMap((e) => e.envois)) {
      assert.doesNotMatch(
        message.texte,
        /refus|refusé|ne correspond pas|insuffisant|vous ne remplissez/i,
        message.texte,
      );
    }
  }
});

test('les créneaux relus en base arrivent en chaînes ISO, pas en objets Date', () => {
  // Régression : la confirmation plantait sur « Invalid time value » au
  // moment exact où le rendez-vous devait être posé.
  const candidat = { ...CANDIDAT_RDV };
  const proposesIso = [
    { debut: '2026-09-09T14:00:00+02:00', fin: '2026-09-09T14:30:00+02:00' },
    { debut: '2026-09-09T16:00:00+02:00', fin: '2026-09-09T16:30:00+02:00' },
  ];

  const etape = traiterReponse(candidat, 'A', contexte({ creneauxProposes: proposesIso }));
  assert.equal(etape.patch.statut, 'rdv_pose');
  assert.ok(etape.creneauRetenu.debut instanceof Date);
  assert.match(etape.envois[0].texte, /mercredi 09\/09 à 14h/);
});

test('la fusion accepte les deux chiffres, et ne repose que ce qui manque', () => {
  const fusionne = conversation(['1 3', '2500', '0', 'A']);
  assert.equal(fusionne.candidat.situation, 'cdi');
  assert.equal(fusionne.candidat.garantie, 'aucune');
  assert.equal(fusionne.candidat.statut, 'rdv_pose');

  // Un seul chiffre n'est pas un échec : on repose la seule question qui
  // manque, plutôt que de faire payer au candidat une erreur de format.
  const partiel = conversation(['1', '3', '2500', '0', 'A']);
  assert.deepEqual(textes(partiel.trace).slice(0, 2), ['sms1', 'sms1bis_garantie']);
  assert.equal(partiel.candidat.situation, 'cdi');
  assert.equal(partiel.candidat.garantie, 'aucune');
  assert.equal(partiel.candidat.statut, 'rdv_pose');
});

test('CDD : la durée passe avant la garantie, même donnée d’emblée', () => {
  // La durée est une exclusion sèche : rien ne sert d'instruire un dossier
  // qu'elle écarte. La garantie déjà reçue n'est pas redemandée pour autant.
  const { candidat, trace } = conversation(['2 1', 'OUI', '2', '1500 et 1600', '3000', '0', 'A']);
  assert.deepEqual(textes(trace).slice(0, 4), ['sms1', 'sms1bis', 'sms2bis', 'sms2ter']);
  assert.equal(candidat.garantie, 'caution');
  assert.equal(candidat.duree_contrat_mois, 24);
});

test('le message d’ouverture reste dans un budget de segments tenable', () => {
  const { segmentsSms, sms1Ouverture } = require('../src/messages');
  const texte = sms1Ouverture({ lot: { reference: '677', commune: 'SAINT CYPRIEN', loyer_cc: 508 } });

  // Les accents font basculer le message en UCS-2 : 67 caractères par
  // segment concaténé, contre 153 en GSM-7. C'est le message le plus cher
  // du dispositif, et le seul qui porte la mention d'information.
  assert.ok(segmentsSms(texte) <= 9, `${segmentsSms(texte)} segments`);
  assert.ok(texte.length < 620, `${texte.length} caractères`);

  // Les messages courants, eux, doivent tenir en peu de segments.
  const M = require('../src/messages');
  assert.ok(segmentsSms(M.sms4bTransmis()) <= 2);
  assert.ok(segmentsSms(M.attenteArbitrage()) <= 3);
});
