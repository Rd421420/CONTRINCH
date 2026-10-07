const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/parsing');

test('montants : les formes couvertes par la regex', () => {
  const cas = [
    ['1850', 1850], ['1 850 €', 1850], ['1850,50', 1850.5], ['2000e', 2000],
    ['1.850 euros', 1850], ['   1900  ', 1900], ['2 100 EUR', 2100],
    ['je gagne 1750 net', 1750], ['1750€/mois', 1750], ['0', 0],
  ];
  for (const [texte, attendu] of cas) {
    assert.equal(P.parseMontant(texte), attendu, texte);
  }
});

test('montants : les formes qui doivent partir au repli, pas être devinées', () => {
  for (const texte of ['environ deux mille', '1200 chacun on est deux', 'je ne sais pas', '']) {
    assert.equal(P.parseMontant(texte), null, texte);
  }
});

test('le point est un séparateur de milliers, la virgule une décimale', () => {
  assert.equal(P.parseMontant('1.850'), 1850);
  assert.equal(P.parseMontant('1,85'), 1.85);
});

test('« 0 » et « aucun » valent zéro aux revenus complémentaires', () => {
  for (const texte of ['0', 'aucun', 'non', 'rien', 'zéro']) {
    assert.equal(P.parseMontantOuZero(texte), 0, texte);
  }
});

test('choix numérotés', () => {
  assert.equal(P.parseChoix('1', 6), 1);
  assert.equal(P.parseChoix('2 - CDD', 6), 2);
  assert.equal(P.parseChoix('réponse 4', 6), 4);
  assert.equal(P.parseChoix('7', 6), null);
  assert.equal(P.parseChoix('je suis en CDI', 6), null);
});

test('oui / non', () => {
  assert.equal(P.parseOuiNon('OUI'), true);
  assert.equal(P.parseOuiNon('oui bien sûr'), true);
  assert.equal(P.parseOuiNon('Non'), false);
  assert.equal(P.parseOuiNon('pas encore'), false);
  assert.equal(P.parseOuiNon('peut-être'), null);
});

test('créneaux A / B / AUTRE', () => {
  assert.equal(P.parseCreneau('A'), 'A');
  assert.equal(P.parseCreneau('b svp'), 'B');
  assert.equal(P.parseCreneau('le B'), 'B');
  assert.equal(P.parseCreneau('AUTRE'), 'AUTRE');
  assert.equal(P.parseCreneau('aucun ne me convient'), 'AUTRE');
  assert.equal(P.parseCreneau('demain matin ?'), null);
});

test('CONSEILLER est reconnu, avec ou sans accent, à tout moment', () => {
  for (const texte of ['CONSEILLER', 'conseiller svp', 'un humain please', 'rappelez-moi']) {
    assert.equal(P.demandeConseiller(texte), true, texte);
  }
  assert.equal(P.demandeConseiller('1'), false);
});

test('STOP est une désinscription, pas une demande de rappel', () => {
  assert.equal(P.demandeDesinscription('STOP'), true);
  assert.equal(P.demandeConseiller('STOP'), false);
  assert.equal(P.demandeDesinscription('stop les sms'), true);
  assert.equal(P.demandeDesinscription("je m'arrête là"), false);
});

test('liste de montants pour la pluralité de cautions', () => {
  assert.deepEqual(P.parseMontants('2100 et 1800', 2), [2100, 1800]);
  assert.deepEqual(P.parseMontants('2100, 1800', 2), [2100, 1800]);
  assert.deepEqual(P.parseMontants('2100 / 1800', 2), [2100, 1800]);
  assert.equal(P.parseMontants('2100', 2), null, 'un montant manquant doit échouer');
});

test('entiers courts, en chiffres comme en lettres', () => {
  assert.equal(P.parseEntier('2', { min: 1, max: 4 }), 2);
  assert.equal(P.parseEntier('deux personnes', { min: 1, max: 4 }), 2);
  assert.equal(P.parseEntier('9', { min: 1, max: 4 }), null);
});
