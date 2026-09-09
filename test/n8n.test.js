const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { generer } = require('../n8n/build');
const { construireSocle } = require('../n8n/bundle');
const T = require('../src/temps');
const { ETAPE } = require('../src/sequence');

const DOSSIER = path.join(__dirname, '..', 'n8n', 'workflows');
const workflows = generer().map((g) => ({ ...g, json: JSON.parse(g.contenu) }));

/**
 * Exécute le code d'un node Code comme le ferait n8n : `$input` pour les
 * items entrants, `$('Nom')` pour relire un node amont.
 */
function executerCode(jsCode, { entree = [{ json: {} }], amont = {} } = {}) {
  const $input = { all: () => entree, first: () => entree[0], last: () => entree[entree.length - 1] };
  const $ = (nom) => {
    const items = amont[nom];
    if (!items) throw new Error(`Node amont non simulé : ${nom}`);
    return {
      all: () => items,
      first: () => items[0],
      last: () => items[items.length - 1],
      itemMatching: (i) => items[i],
      get item() {
        return items[0];
      },
    };
  };
  const fn = new Function('$input', '$', '$json', 'DateTime', jsCode);
  return fn($input, $, entree[0] && entree[0].json, null) || [];
}

function node(workflow, nom) {
  const trouve = workflow.json.nodes.find((n) => n.name === nom);
  assert.ok(trouve, `node « ${nom} » absent de ${workflow.fichier}`);
  return trouve;
}

function codeDe(workflow, nom) {
  return node(workflow, nom).parameters.jsCode;
}

function charger(fichier) {
  const trouve = workflows.find((w) => w.fichier === fichier);
  assert.ok(trouve, `workflow ${fichier} absent`);
  return trouve;
}

// ─── Intégrité structurelle ────────────────────────────────────────────

test('les fichiers versionnés sont à jour avec les définitions', () => {
  for (const { fichier, contenu } of workflows) {
    const chemin = path.join(DOSSIER, fichier);
    assert.ok(fs.existsSync(chemin), `${fichier} n'a pas été généré`);
    assert.equal(
      fs.readFileSync(chemin, 'utf8'),
      contenu,
      `${fichier} n'est plus à jour — relancer npm run n8n:build`,
    );
  }
});

test('chaque lien pointe vers un node existant', () => {
  for (const { fichier, json } of workflows) {
    const noms = new Set(json.nodes.map((n) => n.name));
    for (const [source, sorties] of Object.entries(json.connections)) {
      assert.ok(noms.has(source), `${fichier} : lien depuis « ${source} », qui n'existe pas`);
      for (const branche of sorties.main) {
        for (const lien of branche) {
          assert.ok(noms.has(lien.node), `${fichier} : lien vers « ${lien.node} », qui n'existe pas`);
        }
      }
    }
  }
});

test('noms et identifiants de nodes uniques', () => {
  for (const { fichier, json } of workflows) {
    const noms = json.nodes.map((n) => n.name);
    const ids = json.nodes.map((n) => n.id);
    assert.equal(new Set(noms).size, noms.length, `${fichier} : deux nodes portent le même nom`);
    assert.equal(new Set(ids).size, ids.length, `${fichier} : deux nodes portent le même identifiant`);
  }
});

test('chaque workflow a au moins un déclencheur, et aucun node orphelin', () => {
  const DECLENCHEURS = /Trigger$|manualTrigger|webhook$/i;
  for (const { fichier, json } of workflows) {
    const declencheurs = json.nodes.filter((n) => DECLENCHEURS.test(n.type));
    assert.ok(declencheurs.length >= 1, `${fichier} : aucun déclencheur`);

    const atteints = new Set(declencheurs.map((n) => n.name));
    let progresse = true;
    while (progresse) {
      progresse = false;
      for (const [source, sorties] of Object.entries(json.connections)) {
        if (!atteints.has(source)) continue;
        for (const branche of sorties.main) {
          for (const lien of branche) {
            if (!atteints.has(lien.node)) {
              atteints.add(lien.node);
              progresse = true;
            }
          }
        }
      }
    }
    for (const n of json.nodes) {
      assert.ok(atteints.has(n.name), `${fichier} : « ${n.name} » n'est relié à aucun déclencheur`);
    }
  }
});

test('le code de chaque node Code est syntaxiquement valide', () => {
  for (const { fichier, json } of workflows) {
    for (const n of json.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      assert.doesNotThrow(
        () => new Function('$input', '$', '$json', n.parameters.jsCode),
        `${fichier} / ${n.name}`,
      );
    }
  }
});

test('chaque $1 d’une requête a bien son remplacement', () => {
  for (const { fichier, json } of workflows) {
    for (const n of json.nodes.filter((x) => x.type === 'n8n-nodes-base.postgres')) {
      if (n.parameters.operation !== 'executeQuery') continue;
      // Les $ des corps plpgsql ne sont pas des paramètres ; aucun ici.
      const places = new Set((n.parameters.query.match(/\$\d+/g) || []).map((x) => Number(x.slice(1))));
      const remplacement = (n.parameters.options || {}).queryReplacement || '';
      const fournis = remplacement ? remplacement.split(/,(?![^{]*\}\})/).length : 0;
      assert.equal(
        fournis,
        places.size,
        `${fichier} / ${n.name} : ${places.size} paramètre(s) attendu(s), ${fournis} fourni(s)`,
      );
    }
  }
});

test('le socle embarqué est bien celui de src/', () => {
  const socle = construireSocle();
  const porteurs = [];
  for (const { json } of workflows) {
    for (const n of json.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      if (!n.parameters.jsCode.includes('const ERA = (function ()')) continue;
      porteurs.push(n.name);
      assert.ok(n.parameters.jsCode.startsWith(socle), `${n.name} embarque un socle divergent`);
    }
  }
  assert.ok(porteurs.length >= 5, 'aucun node ne porte le socle');
});

test('aucun paramètre local ne traîne hors du node Paramètres', () => {
  for (const { fichier, json } of workflows) {
    for (const n of json.nodes) {
      if (n.name === 'Paramètres') continue;
      // Les commentaires SQL citent des numéros en exemple : on les retire
      // avant de chercher une valeur réellement câblée.
      const texte = JSON.stringify(n.parameters).replace(/--[^\\]*?\\n/g, '');
      assert.doesNotMatch(texte, /\+33[0-9]{9}/, `${fichier} / ${n.name} : numéro en dur`);
      assert.doesNotMatch(texte, /:cloud/, `${fichier} / ${n.name} : modèle « cloud » — les données sortiraient du VPS`);
    }
  }
});

// ─── Exécution réelle des nodes Code ───────────────────────────────────

const PARAMETRES = [{
  json: {
    expediteur: '+33600000000',
    chat_id: '000000000',
    agenda: 'primary',
    mail_pieces: 'pieces@era-dupontromain.fr',
    ollama: 'http://127.0.0.1:11434/api/generate',
    modele: 'qwen2.5:3b-instruct-q4_K_M',
  },
}];

const LOT = {
  reference: '677',
  commune: 'SAINT CYPRIEN',
  adresse: '9 Impasse Jordi Barre 66750 SAINT CYPRIEN',
  loyer_cc: 700,
  type_lot: 'T3',
  proprietaire: 'EMPREINTE IMMOBILIER',
  accepte_visale: true,
  zone_visale: 3,
  latitude: 42.6206,
  longitude: 3.0189,
};

function contexteReponses(candidat, extra = {}) {
  return [{
    json: {
      candidat,
      lot: LOT,
      jours_feries: ['2026-11-01', '2026-11-11'],
      lots: [{ reference: '677', commune: 'SAINT CYPRIEN', latitude: 42.6206, longitude: 3.0189 }],
      reservations: [],
      creneaux_proposes: [],
      ...extra,
    },
  }];
}

/** Rejoue la chaîne de nodes Code de WF-2 bis pour une réponse entrante. */
function traiterParLeWorkflow(candidat, texteRecu, { creneauxProposes = [], evenements = [] } = {}) {
  const wf = charger('wf2bis-sequence-reponses.json');
  const contexte = contexteReponses(candidat, { creneaux_proposes: creneauxProposes });

  const fenetre = executerCode(codeDe(wf, 'Fenêtre de lecture'), {
    entree: contexte,
    amont: {
      'Paramètres': PARAMETRES,
      'Webhook Twilio': [{ json: { body: { From: candidat.mobile, Body: texteRecu } } }],
    },
  });

  const actions = executerCode(codeDe(wf, 'Traiter la réponse'), {
    entree: evenements.length ? evenements : [{ json: {} }],
    amont: {
      'Paramètres': PARAMETRES,
      'Fenêtre de lecture': fenetre,
      'Charger le contexte': contexte,
    },
  });

  return { fenetre, actions: actions.map((a) => a.json) };
}

const CANDIDAT = {
  id: 7,
  nom: 'CHARLINE LOGIE',
  mobile: '+33674707110',
  email: 'charline.logie@gmail.com',
  ref_lot: '677',
  cree_le: T.instant(2026, 9, 7, 10, 0).toISOString(),
  etape_sms: ETAPE.SITUATION,
  statut: 'en_cours',
  echecs_parsing: 0,
  nb_relances: 0,
};

test('WF-2 bis : une réponse fait avancer la séquence et met le message suivant en file', () => {
  const { actions } = traiterParLeWorkflow(CANDIDAT, '1');

  const fiche = actions.find((a) => a.__action === 'candidat');
  assert.equal(fiche.id, 7);
  assert.equal(fiche.situation, 'cdi');
  assert.equal(fiche.etape_sms, ETAPE.GARANTIE);

  const sms = actions.find((a) => a.__action === 'sms');
  assert.equal(sms.type_message, 'sms2');
  assert.equal(sms.mobile, '+33674707110');
  assert.match(sms.texte, /Quelle garantie/);
});

test('WF-2 bis : un verdict favorable produit deux créneaux bloqués et le SMS 4a', () => {
  const candidat = {
    ...CANDIDAT,
    etape_sms: ETAPE.COMPLEMENTAIRES,
    situation: 'cdi',
    garantie: 'aucune',
    revenus_nets: 2500,
  };
  const { actions } = traiterParLeWorkflow(candidat, '0');

  const creneaux = actions.filter((a) => a.__action === 'creneau');
  assert.equal(creneaux.length, 2, 'les DEUX créneaux proposés doivent être bloqués');
  assert.deepEqual(creneaux.map((c) => c.rang), [1, 2]);
  assert.equal(creneaux[0].reserve_jusqu_a, creneaux[1].reserve_jusqu_a);
  assert.equal(creneaux[0].candidat_id, 7);

  const sms = actions.find((a) => a.__action === 'sms');
  assert.equal(sms.type_message, 'sms4a');
  assert.match(sms.texte, /Répondez A ou B/);
  assert.doesNotMatch(sms.texte, /refus|seuil|€ de revenus/i);
});

test('WF-2 bis : un verdict non favorable journalise sans donnée nominative', () => {
  const candidat = {
    ...CANDIDAT,
    etape_sms: ETAPE.COMPLEMENTAIRES,
    situation: 'cdi',
    garantie: 'aucune',
    revenus_nets: 900,
  };
  const { actions } = traiterParLeWorkflow(candidat, '0');

  const refus = actions.find((a) => a.__action === 'refus');
  assert.equal(refus.verdict, 'hors_criteres');
  assert.equal(refus.ref_lot, '677');
  assert.ok(Number.isFinite(refus.ecart_seuil));
  for (const champ of Object.values(refus)) {
    assert.doesNotMatch(String(champ), /CHARLINE|LOGIE|33674707110|gmail/i);
  }

  const sms = actions.find((a) => a.__action === 'sms');
  assert.equal(sms.type_message, 'sms4b');
  assert.match(sms.texte, /transmise à un conseiller/);
});

test('WF-2 bis : « A » écrit l’événement au format ImmoAgenda', () => {
  const candidat = { ...CANDIDAT, etape_sms: ETAPE.CRENEAU, verdict: 'eligible' };
  const proposes = [
    { id: 1, rang: 1, debut: T.instant(2026, 9, 9, 14, 0).toISOString(), fin: T.instant(2026, 9, 9, 14, 30).toISOString() },
    { id: 2, rang: 2, debut: T.instant(2026, 9, 9, 16, 0).toISOString(), fin: T.instant(2026, 9, 9, 16, 30).toISOString() },
  ];
  const { actions } = traiterParLeWorkflow(candidat, 'A', { creneauxProposes: proposes });

  const agenda = actions.find((a) => a.__action === 'agenda');
  assert.ok(agenda, 'aucun événement à créer');
  assert.equal(agenda.summary, 'VISITE — CHARLINE LOGIE — SAINT CYPRIEN');
  assert.equal(agenda.location, LOT.adresse);
  assert.match(agenda.description, /── ImmoAgenda \(ne pas modifier cette section\) ──/);
  assert.match(agenda.description, /Référence 677 \(700 € par mois\)/);
  assert.equal(agenda.description.includes('--'), false, 'séparateur ASCII : les workflows de relance casseraient');
  assert.equal(agenda.debut, proposes[0].debut);

  const fiche = actions.find((a) => a.__action === 'candidat');
  assert.equal(fiche.statut, 'rdv_pose');
});

test('WF-2 bis : un créneau pris entre-temps est reproposé, jamais refusé', () => {
  const debut = T.instant(2026, 9, 9, 14, 0);
  const candidat = { ...CANDIDAT, etape_sms: ETAPE.CRENEAU, verdict: 'eligible' };
  const proposes = [
    { id: 1, rang: 1, debut: debut.toISOString(), fin: T.instant(2026, 9, 9, 14, 30).toISOString() },
    { id: 2, rang: 2, debut: T.instant(2026, 9, 9, 16, 0).toISOString(), fin: T.instant(2026, 9, 9, 16, 30).toISOString() },
  ];

  // Romain a posé une visite ImmoFacile sur ce créneau entre-temps.
  const collision = [{
    json: {
      summary: 'VISITE — AUTRE',
      description: require('../src/immoagenda').construireDescription({
        type: 'Visite',
        lot: { reference: '677', loyer_cc: 700 },
      }),
      start: { dateTime: debut.toISOString() },
      end: { dateTime: T.instant(2026, 9, 9, 14, 30).toISOString() },
    },
  }];

  const { actions } = traiterParLeWorkflow(candidat, 'A', {
    creneauxProposes: proposes,
    evenements: collision,
  });

  assert.equal(actions.some((a) => a.__action === 'agenda'), false);
  const sms = actions.find((a) => a.__action === 'sms');
  assert.equal(sms.type_message, 'creneau_pris');
  assert.match(sms.texte, /vient d’être pris/);
});

test('WF-2 bis : un SMS d’un numéro inconnu remonte sur Telegram sans écriture', () => {
  const wf = charger('wf2bis-sequence-reponses.json');
  const contexte = [{ json: { candidat: null, lot: null, jours_feries: [], lots: [], reservations: [] } }];

  const fenetre = executerCode(codeDe(wf, 'Fenêtre de lecture'), {
    entree: contexte,
    amont: {
      'Paramètres': PARAMETRES,
      'Webhook Twilio': [{ json: { body: { From: '+33600112233', Body: 'bonjour ?' } } }],
    },
  });

  const actions = executerCode(codeDe(wf, 'Traiter la réponse'), {
    entree: [{ json: {} }],
    amont: { 'Paramètres': PARAMETRES, 'Fenêtre de lecture': fenetre, 'Charger le contexte': contexte },
  }).map((a) => a.json);

  assert.equal(actions.length, 1);
  assert.equal(actions[0].__action, 'telegram');
  assert.match(actions[0].texte, /hors séquence/);
});

test('WF-2 ter : la file ne s’écoule que dans la plage 9 h – 19 h', () => {
  const wf = charger('wf2ter-emission-sms.json');
  const jsCode = codeDe(wf, 'Messages à envoyer');
  const messages = [{ id: 1, candidat_id: 7, mobile: '+33674707110', texte: 'bonjour', type_message: 'sms1' }];
  const entree = [{ json: { jours_feries: ['2026-11-11'], messages } }];

  const original = Date;
  function figer(instant) {
    global.Date = class extends original {
      constructor(...args) {
        return args.length ? new original(...args) : new original(instant);
      }
      static now() { return instant.getTime(); }
    };
  }

  try {
    figer(T.instant(2026, 9, 9, 10, 0)); // mercredi 10 h
    assert.equal(executerCode(jsCode, { entree, amont: { 'Paramètres': PARAMETRES } }).length, 1);

    figer(T.instant(2026, 9, 9, 22, 0)); // mercredi 22 h
    assert.equal(executerCode(jsCode, { entree, amont: { 'Paramètres': PARAMETRES } }).length, 0);

    figer(T.instant(2026, 9, 12, 10, 0)); // samedi
    assert.equal(executerCode(jsCode, { entree, amont: { 'Paramètres': PARAMETRES } }).length, 0);

    figer(T.instant(2026, 11, 11, 10, 0)); // jour férié
    assert.equal(executerCode(jsCode, { entree, amont: { 'Paramètres': PARAMETRES } }).length, 0);
  } finally {
    global.Date = original;
  }
});

test('WF-7 : les commandes Telegram sont lues, communes en plusieurs mots comprises', () => {
  const wf = charger('wf7-telegram-commandes.json');
  const jsCode = codeDe(wf, 'Lire la commande');

  function commande(texte) {
    return executerCode(jsCode, {
      entree: [{ json: { message: { text: texte, chat: { id: 42 } } } }],
      amont: { 'Paramètres': PARAMETRES },
    })[0].json;
  }

  const lot = commande('/lot 12345 Le Soler T3 780 visale-ok zone3');
  assert.equal(lot.__action, 'lot');
  assert.equal(lot.reference, '12345');
  assert.equal(lot.commune, 'Le Soler');
  assert.equal(lot.type_lot, 'T3');
  assert.equal(lot.loyer_cc, 780);
  assert.equal(lot.accepte_visale, true);
  assert.equal(lot.zone_visale, 3);

  const gli = commande('/lot 900 Bompas T2 640');
  assert.equal(gli.accepte_visale, false, 'sans visale-ok, le lot est réputé sous GLI');

  assert.equal(commande('/loue 12345').__action, 'loue');
  assert.equal(commande('/pieces 42').candidat_id, 42);
  assert.equal(commande('/lot 12345 Bompas').__action, 'reponse', 'commande incomplète : on répond, on n’insère pas');
  assert.equal(commande('bonjour').__action, 'reponse');
});

test('WF-1 : le modèle ne reçoit que le corps du message', () => {
  const wf = charger('wf1-tri-boite-generale.json');
  const mail = {
    from: { value: [{ address: 'alerte@seloger.com' }] },
    subject: 'Nouveau contact pour votre annonce',
    text: 'Bonjour, je souhaite visiter le bien référence 677. Cordialement, Charline',
  };
  const sortie = executerCode(codeDe(wf, 'Filtre expéditeurs et mots-clés'), {
    entree: [{ json: { ...mail, ...PARAMETRES[0].json } }],
  });

  assert.equal(sortie.length, 1);
  const invite = sortie[0].json.invite;
  assert.match(invite, /je souhaite visiter le bien référence 677/);
  // Ni base de lots, ni historique, ni coordonnées propriétaire.
  assert.doesNotMatch(invite, /EMPREINTE|propriétaire|loyer_cc|SAINT CYPRIEN/i);

  const ignore = executerCode(codeDe(wf, 'Filtre expéditeurs et mots-clés'), {
    entree: [{ json: { from: { value: [{ address: 'compta@edf.fr' }] }, subject: 'Votre facture', text: 'Montant dû' } }],
  });
  assert.equal(ignore.length, 0);
});

test('aucune valeur passée en paramètre SQL ne peut contenir de virgule', () => {
  // n8n découpe la liste des paramètres sur les virgules : une valeur qui
  // en contient décale silencieusement tous les paramètres suivants.
  const wf = charger('wf2ter-emission-sms.json');
  const messages = [{ id: 12, mobile: '+33674707110' }];

  const sortie = executerCode(codeDe(wf, 'Résultat d’envoi'), {
    entree: [{ json: { error: 'Invalid parameter, unreachable carrier, code 21211' } }],
    amont: { 'Messages à envoyer': messages.map((json) => ({ json })) },
  });

  assert.equal(sortie[0].json.id, 12);
  assert.equal(sortie[0].json.sid, '');
  assert.doesNotMatch(sortie[0].json.erreur, /,/);
  assert.match(sortie[0].json.erreur, /code 21211/, 'le message doit rester lisible');
});

test('WF-5 bis : les identifiants marqués passent par un séparateur sans virgule', () => {
  const wf = charger('wf5bis-recapitulatif-telegram.json');
  const dossiers = [
    { id: 3, nom: 'A', mobile: '+33600000001', cree_le: '2026-09-07T08:00:00Z' },
    { id: 9, nom: 'B', mobile: '+33600000002', cree_le: '2026-09-07T09:00:00Z' },
  ];
  const sortie = executerCode(codeDe(wf, 'Composer le récapitulatif'), {
    entree: [{ json: { dossiers } }],
    amont: { 'Paramètres': PARAMETRES },
  });

  assert.equal(sortie[0].json.ids, '3|9');
  assert.match(sortie[0].json.texte, /2 dossier\(s\)/);
  assert.match(sortie[0].json.texte, /\/pieces 3/);

  // Rien à arbitrer : aucun message. Un récapitulatif vide tous les soirs
  // apprend surtout à ne plus les lire.
  assert.equal(executerCode(codeDe(wf, 'Composer le récapitulatif'), {
    entree: [{ json: { dossiers: [] } }],
    amont: { 'Paramètres': PARAMETRES },
  }).length, 0);
});

test('WF-6 : silencieux quand tout va bien, bavard quand la purge s’arrête', () => {
  const wf = charger('wf6-controle.json');
  const jsCode = codeDe(wf, 'Alertes');
  const sain = {
    derniere_purge: new Date(Date.now() - 6 * 3600000).toISOString(),
    a_purger: 0, sms_en_echec: 0, sms_en_retard: 0,
    dernier_ferie: `${new Date().getFullYear()}-12-25`,
    pieces_en_attente: [],
  };

  assert.equal(executerCode(jsCode, { entree: [{ json: sain }], amont: { 'Paramètres': PARAMETRES } }).length, 0);

  const malade = { ...sain, derniere_purge: new Date(Date.now() - 72 * 3600000).toISOString(), a_purger: 41 };
  const alerte = executerCode(jsCode, { entree: [{ json: malade }], amont: { 'Paramètres': PARAMETRES } });
  assert.equal(alerte.length, 1);
  assert.match(alerte[0].json.texte, /crontab/);
  assert.match(alerte[0].json.texte, /41 fiche/);
});

// ─── WF-8 · dossiers en attente d'arbitrage ────────────────────────────

const FERIES_LONGS = ['2026-11-01', '2026-11-11'];

/** Rejoue le tri de WF-8 à un instant donné. */
function arbitragesEnAttente(dossiers, { absence = null, maintenant } = {}) {
  const wf = charger('wf8-arbitrages-en-attente.json');
  const original = Date;
  global.Date = class extends original {
    constructor(...args) { return args.length ? new original(...args) : new original(maintenant); }
    static now() { return maintenant.getTime(); }
  };
  try {
    return executerCode(codeDe(wf, 'Trier par ancienneté'), {
      entree: [{ json: { absence, jours_feries: FERIES_LONGS, dossiers } }],
      amont: { 'Paramètres': PARAMETRES },
    }).map((a) => a.json);
  } finally {
    global.Date = original;
  }
}

function dossier(extra = {}) {
  return {
    id: 42,
    nom: 'CHARLINE LOGIE',
    mobile: '+33674707110',
    situation: 'cdi',
    garantie: 'aucune',
    verdict: 'hors_criteres',
    motif: 'Revenus de 900 € pour un seuil de 1892 €',
    relances_arbitrage: 0,
    reference: '677',
    commune: 'SAINT CYPRIEN',
    loyer_cc: 700,
    ...extra,
  };
}

test('WF-8 : un dossier du jour ne déclenche rien', () => {
  const actions = arbitragesEnAttente(
    [dossier({ depuis: T.instant(2026, 9, 9, 11, 0).toISOString() })],
    { maintenant: T.instant(2026, 9, 9, 17, 0) },
  );
  assert.deepEqual(actions, [], 'un dossier tombé ce matin ne doit pas être rappelé le soir même');
});

test('WF-8 : au bout d’un jour ouvré, le dossier revient sur Telegram', () => {
  const actions = arbitragesEnAttente(
    [dossier({ depuis: T.instant(2026, 9, 8, 16, 0).toISOString() })],
    { maintenant: T.instant(2026, 9, 9, 9, 0) },
  );

  assert.equal(actions.length, 1);
  assert.equal(actions[0].__action, 'telegram');
  assert.match(actions[0].texte, /Arbitrages en attente — 1/);
  assert.match(actions[0].texte, /\/traite 42/);
  assert.match(actions[0].texte, /1 jour ouvré/);
});

test('WF-8 : le week-end ne fait pas vieillir un dossier', () => {
  // Tombé vendredi 18 h, regardé lundi 9 h : un seul jour ouvré écoulé,
  // donc pas encore le mot d'attente.
  const actions = arbitragesEnAttente(
    [dossier({ depuis: T.instant(2026, 9, 11, 18, 0).toISOString() })],
    { maintenant: T.instant(2026, 9, 14, 9, 0) },
  );
  assert.equal(actions.filter((a) => a.__action === 'sms').length, 0);
  assert.match(actions.find((a) => a.__action === 'telegram').texte, /1 jour ouvré/);
});

test('WF-8 : au-delà de trois jours ouvrés, le candidat reçoit un mot d’attente', () => {
  const actions = arbitragesEnAttente(
    [dossier({ depuis: T.instant(2026, 9, 3, 10, 0).toISOString() })],
    { maintenant: T.instant(2026, 9, 9, 9, 0) },
  );

  const sms = actions.find((a) => a.__action === 'sms');
  assert.equal(sms.type_message, 'attente_arbitrage');
  assert.equal(sms.candidat_id, 42);
  // Le mot d'attente n'annonce rien et ne sous-entend rien.
  assert.doesNotMatch(sms.texte, /refus|ne correspond pas|dossier retenu|félicitations/i);
  assert.match(sms.texte, /toujours entre les mains d.un conseiller/);

  const compteur = actions.find((a) => a.__action === 'candidat');
  assert.equal(compteur.relances_arbitrage, 1);
  assert.match(actions.find((a) => a.__action === 'telegram').texte, /🔴/);
});

test('WF-8 : le mot d’attente n’est envoyé qu’une fois', () => {
  const actions = arbitragesEnAttente(
    [dossier({ depuis: T.instant(2026, 9, 3, 10, 0).toISOString(), relances_arbitrage: 1 })],
    { maintenant: T.instant(2026, 9, 9, 9, 0) },
  );
  assert.equal(actions.filter((a) => a.__action === 'sms').length, 0);
  // Le rappel Telegram, lui, continue tant que le dossier n'est pas clos.
  assert.equal(actions.filter((a) => a.__action === 'telegram').length, 1);
});

test('WF-8 : pendant une absence, les rappels vont au suppléant', () => {
  const actions = arbitragesEnAttente(
    [dossier({ depuis: T.instant(2026, 9, 8, 10, 0).toISOString() })],
    {
      absence: { debut: '2026-09-07', fin: '2026-09-18', chat_id_suppleant: '999888777' },
      maintenant: T.instant(2026, 9, 9, 9, 0),
    },
  );

  const rappel = actions.find((a) => a.__action === 'telegram');
  assert.equal(rappel.chat_id, '999888777');
  assert.match(rappel.texte, /suppléance/);
});

test('WF-8 : sans suppléant, l’absence resserre le délai du mot d’attente', () => {
  const unJour = [dossier({ depuis: T.instant(2026, 9, 8, 10, 0).toISOString() })];

  const normal = arbitragesEnAttente(unJour, { maintenant: T.instant(2026, 9, 9, 9, 0) });
  assert.equal(normal.filter((a) => a.__action === 'sms').length, 0);

  const absent = arbitragesEnAttente(unJour, {
    absence: { debut: '2026-09-07', fin: '2026-09-18', chat_id_suppleant: null },
    maintenant: T.instant(2026, 9, 9, 9, 0),
  });
  assert.equal(absent.filter((a) => a.__action === 'sms').length, 1);
  assert.equal(absent.find((a) => a.__action === 'telegram').chat_id, PARAMETRES[0].json.chat_id);
});

test('WF-8 : un dossier sans mobile est rappelé, mais rien ne lui est envoyé', () => {
  const actions = arbitragesEnAttente(
    [dossier({ depuis: T.instant(2026, 9, 3, 10, 0).toISOString(), mobile: null })],
    { maintenant: T.instant(2026, 9, 9, 9, 0) },
  );
  assert.equal(actions.filter((a) => a.__action === 'sms').length, 0);
  assert.equal(actions.filter((a) => a.__action === 'telegram').length, 1);
});

test('WF-7 : /traite, /absence et /retour sont lus', () => {
  const wf = charger('wf7-telegram-commandes.json');
  const jsCode = codeDe(wf, 'Lire la commande');

  function commande(texte) {
    return executerCode(jsCode, {
      entree: [{ json: { message: { text: texte, chat: { id: 42 } } } }],
      amont: { 'Paramètres': PARAMETRES },
    })[0].json;
  }

  assert.deepEqual(
    { ...commande('/traite 42') },
    { __action: 'traite', chat_id: '42', candidat_id: 42 },
  );

  const absence = commande('/absence 2026-10-20 2026-10-27 999888777');
  assert.equal(absence.__action, 'absence');
  assert.equal(absence.debut, '2026-10-20');
  assert.equal(absence.chat_id_suppleant, '999888777');

  assert.equal(commande('/absence 2026-10-20 2026-10-27').chat_id_suppleant, null);
  assert.equal(commande('/retour').__action, 'retour');

  // Une période inversée est refusée plutôt qu'écrite en base.
  assert.equal(commande('/absence 2026-10-27 2026-10-20').__action, 'reponse');
  assert.equal(commande('/absence demain').__action, 'reponse');

  assert.match(commande('/aide').texte, /\/traite ID/);
});

test('WF-7 : le chat de la conversation ne part pas en colonne de la table absences', () => {
  const wf = charger('wf7-telegram-commandes.json');
  const sortie = executerCode(codeDe(wf, 'Ligne d’absence'), {
    entree: [{ json: { chat_id: '42', debut: '2026-10-20', fin: '2026-10-27', chat_id_suppleant: null } }],
  });
  assert.deepEqual(Object.keys(sortie[0].json).sort(), ['chat_id_suppleant', 'debut', 'fin']);
});
