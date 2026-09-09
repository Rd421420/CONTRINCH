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

function evenementVisite(refLot, debut, finHeure) {
  return {
    debut,
    fin: finHeure,
    summary: 'VISITE — TEST',
    description: ia.construireDescription({
      type: 'Visite',
      client: { nom: 'TEST' },
      lot: { reference: String(refLot), loyer_cc: 500 },
    }),
  };
}

// Mercredi 9 septembre 2026 : jour terrain. Demande reçue le lundi 7.
const DEMANDE = T.instant(2026, 9, 7, 10, 0);

test('un agenda vide : premier créneau au premier bloc terrain, à J+2 ouvré', () => {
  const { creneaux } = proposerCreneaux({
    lot: { reference: '677', ...LOTS['677'] },
    dateDemande: DEMANDE,
    joursFeries: FERIES,
    lots: LOTS,
  });

  assert.equal(creneaux.length, 2);
  assert.equal(creneaux[0].jour, '2026-09-09'); // mercredi, J+2 ouvré depuis lundi
  assert.equal(T.heureDecimale(creneaux[0].debut), 14);
  assert.equal(creneaux[0].groupe, 'A');
  assert.equal(creneaux[0].priorite, 3); // nouvelle ancre
});

test('les deux groupes d’un même après-midi ont chacun leur ancre', () => {
  const { creneaux } = proposerCreneaux({
    lot: { reference: '677', ...LOTS['677'] },
    dateDemande: DEMANDE,
    joursFeries: FERIES,
    lots: LOTS,
  });
  assert.deepEqual(creneaux.map((c) => c.groupe), ['A', 'B']);
  assert.equal(T.heureDecimale(creneaux[1].debut), 16);
});

test('une ancre à moins de 12 km ouvre le groupe au candidat', () => {
  const ancre = evenementVisite('700', T.instant(2026, 9, 9, 14, 0), T.instant(2026, 9, 9, 14, 30));
  const { creneaux } = proposerCreneaux({
    lot: { reference: '677', ...LOTS['677'] },
    dateDemande: DEMANDE,
    evenements: [ancre],
    joursFeries: FERIES,
    lots: LOTS,
  });

  assert.equal(creneaux[0].jour, '2026-09-09');
  assert.equal(creneaux[0].priorite, 2);
  assert.ok(creneaux[0].distance_ancre_km < 12);
  assert.equal(T.heureDecimale(creneaux[0].debut), 14.5); // juste après l'ancre
});

test('une ancre au-delà de 12 km ferme le groupe : jamais de déplacement isolé', () => {
  // Bompas ancre les deux groupes du mercredi ; Saint-Cyprien est à 13 km.
  const evenements = [
    evenementVisite('800', T.instant(2026, 9, 9, 14, 0), T.instant(2026, 9, 9, 14, 30)),
    evenementVisite('800', T.instant(2026, 9, 9, 16, 0), T.instant(2026, 9, 9, 16, 30)),
  ];
  const { creneaux, journal } = proposerCreneaux({
    lot: { reference: '677', ...LOTS['677'] },
    dateDemande: DEMANDE,
    evenements,
    joursFeries: FERIES,
    lots: LOTS,
  });

  assert.ok(journal.some((j) => j.motif === 'hors_rayon' && j.jour === '2026-09-09'));
  assert.ok(creneaux.every((c) => c.jour !== '2026-09-09'));
  assert.equal(creneaux[0].jour, '2026-09-10'); // reporté au jeudi
});

test('même lot : créneaux consécutifs, un seul déplacement', () => {
  const evenements = [
    evenementVisite('677', T.instant(2026, 9, 9, 14, 0), T.instant(2026, 9, 9, 14, 30)),
    evenementVisite('677', T.instant(2026, 9, 9, 14, 30), T.instant(2026, 9, 9, 15, 0)),
  ];
  const { creneaux } = proposerCreneaux({
    lot: { reference: '677', ...LOTS['677'] },
    dateDemande: DEMANDE,
    evenements,
    joursFeries: FERIES,
    lots: LOTS,
  });

  assert.equal(creneaux[0].priorite, 1);
  assert.equal(T.heureDecimale(creneaux[0].debut), 15); // enchaînement direct
});

test('filtre d’occupation : un déjeuner bloque la place sans ancrer la zone', () => {
  const dejeuner = {
    debut: T.instant(2026, 9, 9, 14, 0),
    fin: T.instant(2026, 9, 9, 15, 0),
    summary: 'Déjeuner Marc',
    description: 'rien à voir',
  };
  const { creneaux } = proposerCreneaux({
    lot: { reference: '800', ...LOTS['800'] },
    dateDemande: DEMANDE,
    evenements: [dejeuner],
    joursFeries: FERIES,
    lots: LOTS,
  });

  // La place est prise jusqu'à 15 h, mais aucune ancre n'est fixée :
  // le candidat de Bompas ouvre quand même le secteur.
  assert.equal(creneaux[0].jour, '2026-09-09');
  assert.equal(T.heureDecimale(creneaux[0].debut), 15);
  assert.equal(creneaux[0].priorite, 3);
});

test('un état des lieux ancre tout l’après-midi, les deux groupes compris', () => {
  const edl = {
    debut: T.instant(2026, 9, 9, 16, 0),
    fin: T.instant(2026, 9, 9, 17, 0),
    summary: 'EDL sortie',
    description: ia.construireDescription({
      type: "Etat des lieux de sortie",
      lot: { reference: '800', loyer_cc: 600 },
    }),
  };
  const { creneaux } = proposerCreneaux({
    lot: { reference: '677', ...LOTS['677'] }, // Saint-Cyprien, 13 km de Bompas
    dateDemande: DEMANDE,
    evenements: [edl],
    joursFeries: FERIES,
    lots: LOTS,
  });

  assert.ok(creneaux.every((c) => c.jour !== '2026-09-09'));
});

test('plafond de visites : l’après-midi saturé est écarté', () => {
  const evenements = [];
  for (let i = 0; i < 5; i += 1) {
    const debut = T.instant(2026, 9, 9, 14 + Math.floor(i / 2), (i % 2) * 30);
    evenements.push(evenementVisite('677', debut, new Date(debut.getTime() + 30 * 60000)));
  }
  const { creneaux, journal } = proposerCreneaux({
    lot: { reference: '677', ...LOTS['677'] },
    dateDemande: DEMANDE,
    evenements,
    joursFeries: FERIES,
    lots: LOTS,
  });

  assert.ok(journal.some((j) => j.motif === 'plafond_visites_atteint'));
  assert.ok(creneaux.every((c) => c.jour !== '2026-09-09'));
});

test('un blocage provisoire encore actif masque le créneau aux autres candidats', () => {
  const maintenant = T.instant(2026, 9, 7, 11, 0);
  const reservations = [{
    candidat_id: 42,
    debut: T.instant(2026, 9, 9, 14, 0),
    fin: T.instant(2026, 9, 9, 14, 30),
    reserve_jusqu_a: T.instant(2026, 9, 7, 13, 0),
    confirme: false,
  }];

  const { creneaux } = proposerCreneaux({
    lot: { reference: '677', ...LOTS['677'] },
    dateDemande: DEMANDE,
    maintenant,
    reservations,
    joursFeries: FERIES,
    lots: LOTS,
    candidatId: 99,
  });
  assert.equal(T.heureDecimale(creneaux[0].debut), 14.5);
});

test('un blocage expiré libère le créneau', () => {
  const maintenant = T.instant(2026, 9, 7, 16, 0);
  const reservations = [{
    candidat_id: 42,
    debut: T.instant(2026, 9, 9, 14, 0),
    fin: T.instant(2026, 9, 9, 14, 30),
    reserve_jusqu_a: T.instant(2026, 9, 7, 13, 0),
    confirme: false,
  }];

  const { creneaux } = proposerCreneaux({
    lot: { reference: '677', ...LOTS['677'] },
    dateDemande: DEMANDE,
    maintenant,
    reservations,
    joursFeries: FERIES,
    lots: LOTS,
    candidatId: 99,
  });
  assert.equal(T.heureDecimale(creneaux[0].debut), 14);
});

test('vérification à la confirmation : une visite ImmoFacile posée entre-temps l’emporte', () => {
  const creneau = { debut: T.instant(2026, 9, 9, 14, 0), fin: T.instant(2026, 9, 9, 14, 30) };
  const posee = evenementVisite('900', T.instant(2026, 9, 9, 14, 0), T.instant(2026, 9, 9, 14, 30));

  assert.equal(creneauEncoreLibre(creneau, []), true);
  assert.equal(creneauEncoreLibre(creneau, [posee]), false);
});

test('une ancre dont le lot n’est pas en base ne laisse rien passer au hasard', () => {
  const ancre = evenementVisite('inconnu', T.instant(2026, 9, 9, 14, 0), T.instant(2026, 9, 9, 14, 30));
  const { creneaux, journal } = proposerCreneaux({
    lot: { reference: '677', ...LOTS['677'] },
    dateDemande: DEMANDE,
    evenements: [ancre],
    joursFeries: FERIES,
    lots: LOTS,
  });
  assert.ok(journal.some((j) => j.motif === 'ancre_non_localisee' && j.groupe === 'A'));
  // Le groupe A est fermé : sans coordonnées, la règle des 12 km est
  // invérifiable. Le groupe B, lui, reste vide et donc ouvert — c'est
  // précisément ce que veut dire « deux groupes indépendants ».
  assert.equal(creneaux.filter((c) => c.jour === '2026-09-09' && c.groupe === 'A').length, 0);
  assert.equal(creneaux[0].groupe, 'B');
});

test('les jours fériés ne portent aucun bloc terrain', () => {
  // Mercredi 11 novembre 2026 est férié : la demande du lundi 9 doit sauter au jeudi 12.
  const { creneaux } = proposerCreneaux({
    lot: { reference: '677', ...LOTS['677'] },
    dateDemande: T.instant(2026, 11, 9, 10, 0),
    joursFeries: FERIES,
    lots: LOTS,
  });
  assert.equal(creneaux[0].jour, '2026-11-12');
});
