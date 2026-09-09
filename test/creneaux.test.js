const test = require('node:test');
const assert = require('node:assert/strict');

const { proposerCreneaux, creneauEncoreLibre } = require('../src/creneaux');
const ia = require('../src/immoagenda');
const T = require('../src/temps');

const FERIES = ['2026-11-01', '2026-11-11'];

// Portefeuille de test — coordonnées réelles des communes du secteur.
const LOTS = {
  677: { latitude: 42.6206, longitude: 3.0189 },  // Saint-Cyprien
  700: { latitude: 42.6300, longitude: 3.0100 },  // Saint-Cyprien, autre lot
  800: { latitude: 42.7261, longitude: 2.9364 },  // Bompas — 13 km de Saint-Cyprien
  900: { latitude: 42.6986, longitude: 2.8954 },  // Perpignan
};

function evenement(type, refLot, debut, fin, extra = {}) {
  return {
    debut,
    fin,
    summary: 'VISITE — TEST',
    description: ia.construireDescription({
      type,
      client: { nom: 'TEST' },
      lot: { reference: String(refLot), loyer_cc: 500 },
    }),
    ...extra,
  };
}

function visite(refLot, debut, fin) {
  return evenement('Visite', refLot, debut, fin);
}

// Mercredi 9 septembre 2026 : jour terrain. Demande reçue le lundi 7.
const DEMANDE = T.instant(2026, 9, 7, 10, 0);
const LOT_677 = { reference: '677', ...LOTS['677'] };

function proposer(options = {}) {
  return proposerCreneaux({
    lot: LOT_677,
    dateDemande: DEMANDE,
    joursFeries: FERIES,
    lots: LOTS,
    ...options,
  });
}

/** Les créneaux proposés sur une demi-journée donnée. */
function sur(creneaux, jour, groupe) {
  return creneaux.filter((c) => c.jour === jour && c.groupe === groupe);
}

test('agenda vide : le premier créneau ouvre la matinée du premier jour terrain', () => {
  const { creneaux } = proposer();

  assert.equal(creneaux.length, 2);
  assert.equal(creneaux[0].jour, '2026-09-09'); // mercredi, J+2 ouvré depuis lundi
  assert.equal(creneaux[0].groupe, 'matin');
  assert.equal(T.heureDecimale(creneaux[0].debut), 9);
  assert.equal(creneaux[0].priorite, 3); // nouvelle ancre
});

test('matin et après-midi sont deux demi-journées indépendantes', () => {
  const { creneaux } = proposer();
  assert.deepEqual(creneaux.map((c) => c.groupe), ['matin', 'apres-midi']);
  assert.equal(T.heureDecimale(creneaux[1].debut), 14);
});

test('l’agenda est relu par référence : même lot, créneaux consécutifs', () => {
  // Deux visites du 677 déjà posées l'après-midi : le candidat enchaîne,
  // plutôt que d'ouvrir la matinée restée libre.
  const evenements = [
    visite('677', T.instant(2026, 9, 9, 14, 0), T.instant(2026, 9, 9, 14, 30)),
    visite('677', T.instant(2026, 9, 9, 14, 30), T.instant(2026, 9, 9, 15, 0)),
  ];
  const { creneaux } = proposer({ evenements });

  assert.equal(creneaux[0].priorite, 1);
  assert.equal(creneaux[0].groupe, 'apres-midi');
  assert.equal(T.heureDecimale(creneaux[0].debut), 15); // enchaînement direct
  assert.match(creneaux[0].motif, /enchaînement sur le lot 677/);
});

test('le regroupement par référence l’emporte sur une demi-journée vide plus tôt', () => {
  // Le 677 est posé le JEUDI ; la matinée du mercredi est libre. C'est
  // quand même le jeudi qui doit sortir en premier : un seul déplacement.
  const evenements = [
    visite('677', T.instant(2026, 9, 10, 14, 0), T.instant(2026, 9, 10, 14, 30)),
  ];
  const { creneaux } = proposer({ evenements });

  assert.equal(creneaux[0].jour, '2026-09-10');
  assert.equal(creneaux[0].priorite, 1);
  assert.equal(T.heureDecimale(creneaux[0].debut), 14.5);
});

test('une ancre à moins de 12 km ouvre la demi-journée au candidat', () => {
  const ancre = visite('700', T.instant(2026, 9, 9, 14, 0), T.instant(2026, 9, 9, 14, 30));
  const { creneaux } = proposer({ evenements: [ancre] });

  assert.equal(creneaux[0].groupe, 'apres-midi');
  assert.equal(creneaux[0].priorite, 2);
  assert.ok(creneaux[0].distance_ancre_km < 12);
  assert.equal(T.heureDecimale(creneaux[0].debut), 14.5); // juste après l'ancre
});

test('une ancre au-delà de 12 km ferme sa demi-journée, pas la journée entière', () => {
  // Bompas ancre l'après-midi ; Saint-Cyprien est à 13 km. La matinée du
  // même jour est un autre déplacement : elle reste ouverte.
  const evenements = [
    visite('800', T.instant(2026, 9, 9, 14, 0), T.instant(2026, 9, 9, 14, 30)),
  ];
  const { creneaux, journal } = proposer({ evenements });

  assert.ok(journal.some((j) => j.motif === 'hors_rayon' && j.groupe === 'apres-midi'));
  assert.equal(sur(creneaux, '2026-09-09', 'apres-midi').length, 0);
  assert.equal(creneaux[0].groupe, 'matin');
  assert.equal(creneaux[0].jour, '2026-09-09');
});

test('filtre d’occupation : un bloc Chantier tient la place sans ancrer la zone', () => {
  // Aucune règle ne connaît les blocs Chantier : ils sont dans l'agenda,
  // et cela suffit à ce qu'on ne propose rien par-dessus.
  const chantier = {
    debut: T.instant(2026, 9, 9, 9, 0),
    fin: T.instant(2026, 9, 9, 10, 0),
    summary: 'Chantier',
    description: 'rien à voir',
  };
  const { creneaux } = proposer({ lot: { reference: '800', ...LOTS['800'] }, evenements: [chantier] });

  const matin = sur(creneaux, '2026-09-09', 'matin');
  assert.equal(T.heureDecimale(matin[0].debut), 10);
  assert.equal(matin[0].priorite, 3, 'un événement sans bloc ImmoAgenda n’ancre rien');
});

test('un état des lieux ancre sa demi-journée', () => {
  const edl = evenement(
    "Etat des lieux de sortie", '800',
    T.instant(2026, 9, 9, 16, 0), T.instant(2026, 9, 9, 17, 0),
    { summary: 'EDL sortie' },
  );
  const { creneaux } = proposer({ evenements: [edl] });

  // Saint-Cyprien est à 13 km de Bompas : l'après-midi se ferme.
  assert.equal(sur(creneaux, '2026-09-09', 'apres-midi').length, 0);
  assert.equal(creneaux[0].groupe, 'matin');
});

test('plafond de visites : la demi-journée saturée est écartée, l’autre non', () => {
  const evenements = [];
  for (let i = 0; i < 5; i += 1) {
    const debut = T.instant(2026, 9, 9, 14 + Math.floor(i / 2), (i % 2) * 30);
    evenements.push(visite('677', debut, new Date(debut.getTime() + 30 * 60000)));
  }
  const { creneaux, journal } = proposer({ evenements });

  assert.ok(journal.some((j) => j.motif === 'plafond_visites_atteint' && j.groupe === 'apres-midi'));
  assert.equal(sur(creneaux, '2026-09-09', 'apres-midi').length, 0);
  assert.equal(creneaux[0].groupe, 'matin');
});

test('un blocage provisoire encore actif masque le créneau aux autres candidats', () => {
  const maintenant = T.instant(2026, 9, 7, 11, 0);
  const reservations = [{
    candidat_id: 42,
    debut: T.instant(2026, 9, 9, 9, 0),
    fin: T.instant(2026, 9, 9, 9, 30),
    reserve_jusqu_a: T.instant(2026, 9, 7, 13, 0),
    confirme: false,
  }];

  const { creneaux } = proposer({ maintenant, reservations, candidatId: 99 });
  assert.equal(T.heureDecimale(creneaux[0].debut), 9.5);
});

test('un blocage expiré libère le créneau', () => {
  const maintenant = T.instant(2026, 9, 7, 16, 0);
  const reservations = [{
    candidat_id: 42,
    debut: T.instant(2026, 9, 9, 9, 0),
    fin: T.instant(2026, 9, 9, 9, 30),
    reserve_jusqu_a: T.instant(2026, 9, 7, 13, 0),
    confirme: false,
  }];

  const { creneaux } = proposer({ maintenant, reservations, candidatId: 99 });
  assert.equal(T.heureDecimale(creneaux[0].debut), 9);
});

test('vérification à la confirmation : une visite ImmoFacile posée entre-temps l’emporte', () => {
  const creneau = { debut: T.instant(2026, 9, 9, 14, 0), fin: T.instant(2026, 9, 9, 14, 30) };
  const posee = visite('900', creneau.debut, creneau.fin);

  assert.equal(creneauEncoreLibre(creneau, []), true);
  assert.equal(creneauEncoreLibre(creneau, [posee]), false);
});

test('une ancre dont le lot n’est pas en base ne laisse rien passer au hasard', () => {
  const ancre = visite('inconnu', T.instant(2026, 9, 9, 14, 0), T.instant(2026, 9, 9, 14, 30));
  const { creneaux, journal } = proposer({ evenements: [ancre] });

  assert.ok(journal.some((j) => j.motif === 'ancre_non_localisee' && j.groupe === 'apres-midi'));
  assert.equal(sur(creneaux, '2026-09-09', 'apres-midi').length, 0);
});

test('les jours fériés ne portent aucun bloc terrain', () => {
  // Mercredi 11 novembre 2026 est férié : la demande du lundi 9 saute au jeudi 12.
  const { creneaux } = proposerCreneaux({
    lot: LOT_677,
    dateDemande: T.instant(2026, 11, 9, 10, 0),
    joursFeries: FERIES,
    lots: LOTS,
  });
  assert.equal(creneaux[0].jour, '2026-11-12');
});
