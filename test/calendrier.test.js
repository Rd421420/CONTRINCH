const test = require('node:test');
const assert = require('node:assert/strict');

const cal = require('../src/calendrier');
const T = require('../src/temps');

// Fériés 2026 utiles aux cas limites de la checklist §8.
const FERIES = [
  '2026-01-01', '2026-04-06', '2026-05-01', '2026-05-08', '2026-05-14',
  '2026-05-25', '2026-07-14', '2026-08-15', '2026-11-01', '2026-11-11', '2026-12-25',
];

function jour(iso) {
  return T.depuisIso(iso);
}

test('le samedi et le dimanche ne sont pas ouvrés — agence fermée le samedi', () => {
  assert.equal(cal.estJourOuvre(jour('2026-09-12'), FERIES), false); // samedi
  assert.equal(cal.estJourOuvre(jour('2026-09-13'), FERIES), false); // dimanche
  assert.equal(cal.estJourOuvre(jour('2026-09-14'), FERIES), true);  // lundi
});

test('un jour férié en semaine n’est pas ouvré', () => {
  assert.equal(cal.estJourOuvre(jour('2026-11-11'), FERIES), false); // mercredi 11 novembre
});

test('J+2 ouvré : lundi → mercredi, mardi → jeudi, jeudi → lundi', () => {
  assert.equal(T.isoJour(cal.dateMini(jour('2026-09-07'), FERIES)), '2026-09-09'); // lundi → mercredi
  assert.equal(T.isoJour(cal.dateMini(jour('2026-09-08'), FERIES)), '2026-09-10'); // mardi → jeudi
  assert.equal(T.isoJour(cal.dateMini(jour('2026-09-10'), FERIES)), '2026-09-14'); // jeudi → lundi
});

test('J+2 ouvré : le week-end ne compte pas', () => {
  // vendredi → mardi (lundi = 1 jour ouvré, mardi = 2)
  assert.equal(T.isoJour(cal.dateMini(jour('2026-09-11'), FERIES)), '2026-09-15');
});

test('J+2 ouvré : la veille du 1er novembre et le pont de mai', () => {
  // vendredi 30 octobre : lundi 2 novembre est ouvré (1er novembre = dimanche)
  assert.equal(T.isoJour(cal.dateMini(jour('2026-10-30'), FERIES)), '2026-11-03');
  // mercredi 13 mai : jeudi 14 = Ascension, donc vendredi 15 puis lundi 18
  assert.equal(T.isoJour(cal.dateMini(jour('2026-05-13'), FERIES)), '2026-05-18');
});

test('plage d’envoi : rien avant 9 h, rien à partir de 19 h, rien le week-end', () => {
  assert.equal(cal.dansPlageEnvoi(T.instant(2026, 9, 9, 8, 59), FERIES), false);
  assert.equal(cal.dansPlageEnvoi(T.instant(2026, 9, 9, 9, 0), FERIES), true);
  assert.equal(cal.dansPlageEnvoi(T.instant(2026, 9, 9, 18, 59), FERIES), true);
  assert.equal(cal.dansPlageEnvoi(T.instant(2026, 9, 9, 19, 0), FERIES), false);
  assert.equal(cal.dansPlageEnvoi(T.instant(2026, 9, 12, 10, 0), FERIES), false); // samedi
});

test('un message préparé à 22 h part le lendemain 9 h', () => {
  const envoi = cal.prochaineOuverture(T.instant(2026, 9, 9, 22, 0), FERIES);
  assert.equal(T.isoJour(envoi), '2026-09-10');
  assert.equal(T.heureDecimale(envoi), 9);
});

test('un message préparé le samedi part le lundi 9 h', () => {
  const envoi = cal.prochaineOuverture(T.instant(2026, 9, 12, 11, 0), FERIES);
  assert.equal(T.isoJour(envoi), '2026-09-14');
  assert.equal(T.heureDecimale(envoi), 9);
});

test('compteur de 2 heures ouvrées — les quatre lignes du cahier des charges', () => {
  const cas = [
    [T.instant(2026, 9, 8, 10, 0), '2026-09-08', 12],  // mardi 10 h → mardi 12 h
    [T.instant(2026, 9, 8, 18, 0), '2026-09-09', 10],  // mardi 18 h → mercredi 10 h
    [T.instant(2026, 9, 11, 18, 0), '2026-09-14', 10], // vendredi 18 h → lundi 10 h
    [T.instant(2026, 11, 10, 18, 0), '2026-11-12', 10], // veille du 11 nov. → surlendemain ouvré
  ];
  for (const [envoi, jourAttendu, heureAttendue] of cas) {
    const expiration = cal.expirationBlocage(envoi, FERIES);
    assert.equal(T.isoJour(expiration), jourAttendu);
    assert.equal(T.heureDecimale(expiration), heureAttendue);
  }
});

test('le compteur démarre à l’ouverture pour un envoi hors plage', () => {
  // Préparé samedi, envoyé lundi 9 h, expire lundi 11 h.
  const expiration = cal.expirationBlocage(T.instant(2026, 9, 12, 15, 0), FERIES);
  assert.equal(T.isoJour(expiration), '2026-09-14');
  assert.equal(T.heureDecimale(expiration), 11);
});

test('le changement d’heure ne décale pas l’heure murale', () => {
  // Dernier dimanche d'octobre 2026 : passage à l'heure d'hiver.
  const avant = cal.expirationBlocage(T.instant(2026, 10, 23, 18, 0), FERIES); // vendredi
  assert.equal(T.isoJour(avant), '2026-10-26');
  assert.equal(T.heureDecimale(avant), 10);
});

test('une date ISO absolue est lue comme un instant, pas comme une heure murale', () => {
  // Google Agenda renvoie toujours le décalage. Le confondre avec une heure
  // murale décalerait chaque événement d'une à deux heures.
  const absolu = T.depuisIso('2026-09-09T14:00:00+02:00');
  assert.equal(absolu.toISOString(), '2026-09-09T12:00:00.000Z');
  assert.equal(T.heureDecimale(absolu), 14);

  const zoulou = T.depuisIso('2026-09-09T12:00:00Z');
  assert.equal(zoulou.getTime(), absolu.getTime());

  // Sans décalage, c'est une heure murale parisienne.
  const mural = T.depuisIso('2026-09-09T14:00');
  assert.equal(mural.toISOString(), '2026-09-09T12:00:00.000Z');

  // En hiver, la même heure murale est un autre instant.
  assert.equal(T.depuisIso('2026-01-15T14:00').toISOString(), '2026-01-15T13:00:00.000Z');
});
