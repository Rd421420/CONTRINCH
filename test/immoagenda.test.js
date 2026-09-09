const test = require('node:test');
const assert = require('node:assert/strict');

const ia = require('../src/immoagenda');

// Bloc relevé sur un événement réel de l'agenda perpimmo (§5).
const REEL = [
  '── ImmoAgenda (ne pas modifier cette section) ──',
  "Type d'événement: Visite",
  '',
  'Client(s):',
  '  CHARLINE LOGIE (CHARLINE.LOGIE@GMAIL.COM) 0674707110',
  '',
  'Bien(s):',
  '',
  'Référence 677 (508 € par mois)',
  '9 Impasse Jordi Barre 66750 SAINT CYPRIEN',
  'Vendeur:  EMPREINTE IMMOBILIER',
  '── Fin ImmoAgenda ───────────',
].join('\n');

test('le séparateur est bien U+2500, jamais un tiret ASCII', () => {
  assert.ok(ia.OUVERTURE.includes('─'));
  assert.ok(ia.FERMETURE.includes('─'));
  assert.equal(ia.OUVERTURE.includes('--'), false);
});

test('un bloc réel se relit intégralement', () => {
  const lu = ia.lireDescription(REEL);
  assert.equal(lu.type, 'Visite');
  assert.equal(lu.client.nom, 'CHARLINE LOGIE');
  assert.equal(lu.client.email, 'CHARLINE.LOGIE@GMAIL.COM');
  assert.equal(lu.client.telephone, '0674707110');
  assert.equal(lu.lot.reference, '677');
  assert.equal(lu.lot.loyer_cc, 508);
  assert.equal(lu.lot.commune, 'SAINT CYPRIEN');
});

test('aller-retour : ce que le générateur écrit, le lecteur le relit', () => {
  const description = ia.construireDescription({
    type: 'Visite',
    client: { nom: 'CHARLINE LOGIE', email: 'CHARLINE.LOGIE@GMAIL.COM', telephone: '0674707110' },
    lot: {
      reference: '677',
      loyer_cc: 508,
      adresse: '9 Impasse Jordi Barre 66750 SAINT CYPRIEN',
      proprietaire: 'EMPREINTE IMMOBILIER',
    },
  });

  const lu = ia.lireDescription(description);
  assert.equal(lu.type, 'Visite');
  assert.equal(lu.client.nom, 'CHARLINE LOGIE');
  assert.equal(lu.lot.reference, '677');
  assert.equal(lu.lot.loyer_cc, 508);
  assert.equal(lu.lot.commune, 'SAINT CYPRIEN');
});

test('un événement personnel ne porte aucun bloc : il n’ancre rien', () => {
  assert.equal(ia.lireDescription('Déjeuner avec Marc'), null);
  assert.equal(ia.lireDescription(''), null);
  assert.equal(ia.lireDescription(undefined), null);
});

test('les marqueurs des workflows existants sont relus, jamais écrits', () => {
  const avecMarqueurs = `${REEL}\n[RELANCE ENVOYÉE 2026-09-08]\n[AVIS DEMANDÉ 2026-09-10]`;
  const lu = ia.lireDescription(avecMarqueurs);
  assert.equal(lu.relance_envoyee, true);
  assert.equal(lu.avis_demande, true);

  const genere = ia.construireDescription({ type: 'Visite', lot: { reference: '677', loyer_cc: 508 } });
  assert.doesNotMatch(genere, /RELANCE ENVOY|AVIS DEMAND/);
});

test('le titre porte le préfixe VISITE — et la commune', () => {
  const titre = ia.construireTitre({
    client: { nom: 'CHARLINE LOGIE' },
    lot: { adresse: '9 Impasse Jordi Barre 66750 SAINT CYPRIEN' },
  });
  assert.equal(titre, 'VISITE — CHARLINE LOGIE — SAINT CYPRIEN');
});

test('extraction de la commune et du code postal', () => {
  assert.equal(ia.extraireCommune('12 rue des Lilas 66000 PERPIGNAN'), 'PERPIGNAN');
  assert.equal(ia.extraireCodePostal('12 rue des Lilas 66000 PERPIGNAN'), '66000');
  assert.equal(ia.extraireCommune(null), null);
});

test('un état des lieux se distingue d’une visite par son type', () => {
  const edl = ia.construireDescription({
    type: "Etat des lieux d'entrée",
    lot: { reference: '901', loyer_cc: 640 },
  });
  assert.equal(ia.lireDescription(edl).type, "Etat des lieux d'entrée");
});
