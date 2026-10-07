const test = require('node:test');
const assert = require('node:assert/strict');

const { importer, corpsWorkflow, noeudSousWorkflow, ORDRE, CHAMPS_ACCEPTES } = require('../scripts/importer-workflows');

/**
 * Faux n8n : enregistre les appels et attribue des identifiants, comme le
 * ferait l'API publique.
 */
function fauxN8n({ existants = [] } = {}) {
  const stockes = new Map(existants.map((w, i) => [w, `id-existant-${i}`]));
  const appels = [];
  let compteur = 0;

  async function fetchImpl(url, options = {}) {
    const chemin = url.replace(/^https:\/\/n8n\.test\/api\/v1/, '');
    const corps = options.body ? JSON.parse(options.body) : null;
    appels.push({ chemin, methode: options.method || 'GET', corps, entetes: options.headers });

    if (chemin.startsWith('/workflows?')) {
      return reponse({
        data: [...stockes].map(([name, id]) => ({ id, name })),
        nextCursor: null,
      });
    }

    compteur += 1;
    const id = options.method === 'POST' ? `id-${compteur}` : chemin.split('/').pop();
    if (corps) stockes.set(corps.name, id);
    return reponse({ id, name: corps && corps.name });
  }

  function reponse(objet) {
    return { ok: true, status: 200, text: async () => JSON.stringify(objet) };
  }

  return { fetchImpl, appels, stockes };
}

function lancer(options = {}) {
  const faux = fauxN8n(options);
  return importer({
    url: 'https://n8n.test',
    cle: 'cle-de-test',
    journal: () => {},
    fetchImpl: faux.fetchImpl,
  }).then((resultats) => ({ ...faux, resultats }));
}

test('les douze workflows partent, WF-5 avant WF-7', () => {
  assert.equal(ORDRE.length, 12);
  assert.ok(
    ORDRE.indexOf('wf5-demande-pieces.json') < ORDRE.indexOf('wf7-telegram-commandes.json'),
    'WF-7 appelle WF-5 : il doit exister avant',
  );
});

test('le corps envoyé ne porte que les champs acceptés par l’API', () => {
  const complet = {
    name: 'X', nodes: [], connections: {},
    settings: { executionOrder: 'v1' },
    // Ces trois-là servent à l'import par l'interface et font échouer l'API.
    tags: [{ name: 'ERA' }], pinData: {}, meta: { description: 'x' },
  };
  const corps = corpsWorkflow(complet);
  assert.deepEqual(Object.keys(corps).sort(), [...CHAMPS_ACCEPTES].sort());
  for (const interdit of ['tags', 'pinData', 'meta', 'id', 'active']) {
    assert.equal(interdit in corps, false, `${interdit} ne doit pas être envoyé`);
  }
});

test('sur un n8n vierge : douze créations, et la clé va bien en en-tête', async () => {
  const { appels, resultats } = await lancer();

  const ecritures = appels.filter((a) => a.methode !== 'GET');
  assert.equal(ecritures.length, 12);
  assert.ok(ecritures.every((a) => a.methode === 'POST'));
  assert.ok(ecritures.every((a) => a.entetes['X-N8N-API-KEY'] === 'cle-de-test'));
  assert.ok(resultats.every((r) => r.action === 'créé'));
});

test('relancé, il met à jour au lieu de créer des doublons', async () => {
  const noms = [
    'ERA · WF-3 · Calcul d’éligibilité',
    'ERA · WF-5 · Demande de pièces',
    'ERA · WF-7 · Commandes Telegram',
  ];
  const { appels, resultats } = await lancer({ existants: noms });

  const majs = appels.filter((a) => a.methode === 'PUT');
  assert.equal(majs.length, 3);
  assert.equal(resultats.filter((r) => r.action === 'mis à jour').length, 3);
  assert.equal(resultats.filter((r) => r.action === 'créé').length, 9);

  // Une mise à jour vise l'identifiant existant, pas la collection.
  assert.ok(majs.every((a) => /^\/workflows\/id-existant-\d+$/.test(a.chemin)));
});

test('le lien de WF-7 vers WF-5 est rétabli avec l’identifiant réel', async () => {
  const { appels } = await lancer();

  const wf5 = appels.find((a) => a.corps && a.corps.name === 'ERA · WF-5 · Demande de pièces');
  const wf7 = appels.find((a) => a.corps && a.corps.name === 'ERA · WF-7 · Commandes Telegram');
  assert.ok(wf5 && wf7);

  const noeud = noeudSousWorkflow(wf7.corps);
  assert.ok(noeud, 'WF-7 doit porter un node Execute Workflow');

  // Le fichier versionné porte le NOM ; ce qui part porte l'identifiant.
  assert.notEqual(noeud.parameters.workflowId.value, 'ERA · WF-5 · Demande de pièces');
  assert.match(noeud.parameters.workflowId.value, /^id-/);
  assert.equal(noeud.parameters.workflowId.cachedResultName, 'ERA · WF-5 · Demande de pièces');
});

test('aucun workflow n’est activé par le script', async () => {
  const { appels } = await lancer();
  for (const appel of appels.filter((a) => a.corps)) {
    assert.equal('active' in appel.corps, false, 'l’activation est une décision, pas un effet de bord');
  }
  assert.equal(appels.some((a) => /\/activate/.test(a.chemin)), false);
});

test('une erreur de l’API remonte avec son motif, sans être avalée', async () => {
  const echec = {
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => '{"message":"unauthorized"}',
    }),
  };
  await assert.rejects(
    importer({ url: 'https://n8n.test', cle: 'mauvaise', journal: () => {}, fetchImpl: echec.fetchImpl }),
    /HTTP 401.*unauthorized/s,
  );
});
