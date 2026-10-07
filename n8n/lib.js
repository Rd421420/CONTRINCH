/**
 * Fabrique de définitions n8n.
 *
 * Deux partis pris qui expliquent la forme des workflows générés :
 *
 * 1. **Aucun node IF ni Switch.** Leur schéma de paramètres a changé
 *    plusieurs fois entre les versions 1.x de n8n, et un import qui casse
 *    silencieusement sur ce point est très pénible à diagnostiquer. Un node
 *    Code qui renvoie zéro item arrête sa branche tout aussi bien, et se
 *    lit mieux.
 *
 * 2. **Le contexte se charge en une seule requête, agrégée en JSON.** Un
 *    node Postgres renvoie un item par ligne : trois requêtes de contexte
 *    en série produisent un produit cartésien d'items et cassent
 *    l'appariement. Une requête qui renvoie une ligne unique portant des
 *    colonnes `json_agg` évite entièrement le problème.
 */

const crypto = require('node:crypto');

/** Identifiant stable : deux générations successives ne produisent aucun diff. */
function identifiant(workflow, nom) {
  const h = crypto.createHash('sha1').update(`${workflow}/${nom}`).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`, `a${h.slice(17, 20)}`, h.slice(20, 32)].join('-');
}

function fabrique(nomWorkflow) {
  const noeuds = [];
  const liens = {};

  function ajouter(nom, type, typeVersion, parameters, position, extra = {}) {
    noeuds.push({
      parameters,
      id: identifiant(nomWorkflow, nom),
      name: nom,
      type,
      typeVersion,
      position,
      ...extra,
    });
    return nom;
  }

  const api = {
    /** Node Code. `socle` colle le paquet ERA en tête du script. */
    code(nom, position, jsCode, { socle = null, tousLesItems = true, extra = {} } = {}) {
      const parameters = { jsCode: socle ? `${socle}\n\n${jsCode}` : jsCode };
      if (!tousLesItems) parameters.mode = 'runOnceForEachItem';
      return ajouter(nom, 'n8n-nodes-base.code', 2, parameters, position, extra);
    },

    /** SELECT libre. `$1`, `$2`… sont remplis par `remplacements`. */
    requete(nom, position, query, { remplacements = null, extra = {} } = {}) {
      const options = {};
      if (remplacements) options.queryReplacement = remplacements;
      return ajouter(
        nom,
        'n8n-nodes-base.postgres',
        2.4,
        { operation: 'executeQuery', query, options },
        position,
        extra,
      );
    },

    /** INSERT par correspondance automatique des colonnes. */
    inserer(nom, position, table, extra = {}) {
      return ajouter(
        nom,
        'n8n-nodes-base.postgres',
        2.4,
        {
          schema: { __rl: true, value: 'locatif', mode: 'name' },
          table: { __rl: true, value: table, mode: 'name' },
          columns: { mappingMode: 'autoMapInputData', matchingColumns: [], schema: [] },
          options: {},
        },
        position,
        extra,
      );
    },

    /** Déclencheur Gmail. Pour de l'IMAP pur, remplacer par emailReadImap. */
    gmail(nom, position, minutes = 10) {
      return ajouter(
        nom,
        'n8n-nodes-base.gmailTrigger',
        1.2,
        {
          pollTimes: { item: [{ mode: 'everyX', value: minutes, unit: 'minutes' }] },
          simple: false,
          filters: { readStatus: 'unread' },
          options: { downloadAttachments: false },
        },
        position,
      );
    },

    /** UPDATE par correspondance automatique, sur la colonne `cle`. */
    mettreAJour(nom, position, table, cle = 'id', extra = {}) {
      return ajouter(
        nom,
        'n8n-nodes-base.postgres',
        2.4,
        {
          operation: 'update',
          schema: { __rl: true, value: 'locatif', mode: 'name' },
          table: { __rl: true, value: table, mode: 'name' },
          columns: { mappingMode: 'autoMapInputData', matchingColumns: [cle], schema: [] },
          options: {},
        },
        position,
        extra,
      );
    },

    /**
     * Écrit un créneau proposé en remplaçant celui de même rang.
     *
     * Un INSERT simple laisserait les anciennes propositions en base : après
     * une relance ou une collision, le candidat aurait deux jeux de créneaux
     * et sa réponse « B » ne désignerait plus rien de sûr. Le DELETE et
     * l'INSERT sont dans la même instruction, donc l'ordre d'exécution des
     * branches n8n n'a aucune influence.
     */
    remplacerCreneau(nom, position, extra = {}) {
      const query = [
        '-- Le créneau de même rang est libéré dans la même instruction que',
        "-- l'écriture du nouveau : aucun jeu de propositions ne survit à sa",
        '-- remplaçante, quel que soit l\'ordre des branches.',
        'WITH libere AS (',
        '    DELETE FROM locatif.creneaux_reserves',
        '    WHERE candidat_id = $1::bigint',
        '      AND NOT confirme',
        '      AND rang = $6::smallint',
        ')',
        'INSERT INTO locatif.creneaux_reserves',
        '    (candidat_id, ref_lot, debut, fin, reserve_jusqu_a, rang, confirme)',
        'VALUES',
        '    ($1::bigint, $2::text, $3::timestamptz, $4::timestamptz, $5::timestamptz, $6::smallint, FALSE);',
      ].join('\n');

      return api.requete(nom, position, query, {
        remplacements:
          '={{ $json.candidat_id }}, {{ $json.ref_lot }}, {{ $json.debut }}, {{ $json.fin }}, {{ $json.reserve_jusqu_a }}, {{ $json.rang }}',
        extra,
      });
    },

    planification(nom, position, regle) {
      return ajouter(nom, 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: regle }, position);
    },

    manuel(nom, position) {
      return ajouter(nom, 'n8n-nodes-base.manualTrigger', 1, {}, position);
    },

    sousWorkflow(nom, position, entrees) {
      return ajouter(
        nom,
        'n8n-nodes-base.executeWorkflowTrigger',
        1.1,
        { inputSource: 'workflowInputs', workflowInputs: { values: entrees.map((n) => ({ name: n })) } },
        position,
      );
    },

    webhook(nom, position, chemin) {
      return ajouter(
        nom,
        'n8n-nodes-base.webhook',
        2,
        { httpMethod: 'POST', path: chemin, responseMode: 'responseNode', options: {} },
        position,
        { webhookId: identifiant(nomWorkflow, `${nom}-webhook`) },
      );
    },

    repondre(nom, position, corps, typeContenu) {
      return ajouter(
        nom,
        'n8n-nodes-base.respondToWebhook',
        1.1,
        {
          respondWith: 'text',
          responseBody: corps,
          options: { responseHeaders: { entries: [{ name: 'Content-Type', value: typeContenu }] } },
        },
        position,
      );
    },

    http(nom, position, parameters, extra = {}) {
      return ajouter(nom, 'n8n-nodes-base.httpRequest', 4.2, parameters, position, extra);
    },

    twilio(nom, position, extra = {}) {
      return ajouter(
        nom,
        'n8n-nodes-base.twilio',
        1,
        {
          resource: 'sms',
          operation: 'send',
          from: '={{ $json.expediteur }}',
          to: '={{ $json.mobile }}',
          toWhatsapp: false,
          message: '={{ $json.texte }}',
          options: {},
        },
        position,
        extra,
      );
    },

    telegram(nom, position, texte = '={{ $json.texte }}', extra = {}) {
      return ajouter(
        nom,
        'n8n-nodes-base.telegram',
        1.2,
        {
          resource: 'message',
          operation: 'sendMessage',
          chatId: '={{ $json.chat_id }}',
          text: texte,
          additionalFields: { appendAttribution: false, parse_mode: 'HTML' },
        },
        position,
        extra,
      );
    },

    telegramTrigger(nom, position) {
      return ajouter(nom, 'n8n-nodes-base.telegramTrigger', 1.2, { updates: ['message'], additionalFields: {} }, position);
    },

    /**
     * Lecture d'agenda. `source` nomme le node qui porte l'agenda et la
     * fenêtre, quand ce n'est pas le node d'entrée immédiat — un node
     * Postgres d'agrégats ne les transporte pas.
     */
    agendaLire(nom, position, { source = null, extra = {} } = {}) {
      const champ = (nom2) => (source ? `$('${source}').first().json.${nom2}` : `$json.${nom2}`);
      return ajouter(
        nom,
        'n8n-nodes-base.googleCalendar',
        1.3,
        {
          resource: 'event',
          operation: 'getAll',
          calendar: { __rl: true, value: `={{ ${champ('agenda')} }}`, mode: 'id' },
          returnAll: true,
          timeMin: `={{ ${champ('fenetre_debut')} }}`,
          timeMax: `={{ ${champ('fenetre_fin')} }}`,
          options: { singleEvents: true, orderBy: 'startTime' },
        },
        position,
        // Un agenda vide ne doit pas arrêter la branche : c'est le cas
        // normal d'un bloc terrain encore vierge.
        { alwaysOutputData: true, ...extra },
      );
    },

    agendaCreer(nom, position, extra = {}) {
      return ajouter(
        nom,
        'n8n-nodes-base.googleCalendar',
        1.3,
        {
          resource: 'event',
          operation: 'create',
          calendar: { __rl: true, value: '={{ $json.agenda }}', mode: 'id' },
          start: '={{ $json.debut }}',
          end: '={{ $json.fin }}',
          additionalFields: {
            summary: '={{ $json.summary }}',
            description: '={{ $json.description }}',
            location: '={{ $json.location }}',
          },
        },
        position,
        extra,
      );
    },

    mail(nom, position, extra = {}) {
      return ajouter(
        nom,
        'n8n-nodes-base.emailSend',
        2.1,
        {
          fromEmail: '={{ $json.expediteur }}',
          toEmail: '={{ $json.destinataire }}',
          subject: '={{ $json.sujet }}',
          emailFormat: 'text',
          text: '={{ $json.corps }}',
          options: {},
        },
        position,
        extra,
      );
    },

    executer(nom, position, nomWorkflowCible, extra = {}) {
      return ajouter(
        nom,
        'n8n-nodes-base.executeWorkflow',
        1.2,
        {
          workflowId: { __rl: true, value: nomWorkflowCible, mode: 'list', cachedResultName: nomWorkflowCible },
          workflowInputs: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
          options: {},
        },
        position,
        extra,
      );
    },

    /** Relie deux nodes. `sortie` sert aux nodes à plusieurs sorties. */
    relier(de, vers, sortie = 0) {
      liens[de] = liens[de] || { main: [] };
      while (liens[de].main.length <= sortie) liens[de].main.push([]);
      liens[de].main[sortie].push({ node: vers, type: 'main', index: 0 });
    },

    chaine(...noms) {
      for (let i = 0; i < noms.length - 1; i += 1) api.relier(noms[i], noms[i + 1]);
    },

    construire({ description }) {
      return {
        name: nomWorkflow,
        nodes: noeuds,
        connections: liens,
        settings: {
          executionOrder: 'v1',
          saveManualExecutions: true,
          callerPolicy: 'workflowsFromSameOwner',
          // Les déclencheurs planifiés lisent ce fuseau : « 18 h » veut
          // dire 18 h à Perpignan, pas en UTC, et suit l'heure d'été.
          timezone: 'Europe/Paris',
        },
        pinData: {},
        meta: { description },
        tags: [{ name: 'ERA · pré-étude' }],
      };
    },
  };

  return api;
}

/**
 * Node Code de tête, présent dans chaque workflow : c'est le seul endroit
 * à modifier après import. Rien d'autre ne contient de valeur locale.
 */
function noeudParametres(f, position = [-40, 300]) {
  return f.code(
    'Paramètres',
    position,
    `// ─── À RENSEIGNER APRÈS L'IMPORT ────────────────────────────────────
// Seul node à modifier : tout le reste du workflow lit ces valeurs.
//
// Le node est traversant — il recopie ses items d'entrée en y ajoutant
// les paramètres — pour ne pas écraser les items du déclencheur.
const PARAMETRES = {
  // Numéro long code français acheté chez Twilio, au format E.164.
  expediteur: '+33600000000',

  // Identifiant de la conversation Telegram — destinataire UNIQUE.
  // Les conseillers ne reçoivent rien (cahier des charges §6, WF-5 bis).
  chat_id: '000000000',

  // Agenda principal de Romain — celui qui porte aussi le sport et le BNI.
  agenda: 'primary',

  // Boîte dédiée au dépôt des pièces, distincte de la boîte générale.
  mail_pieces: 'pieces@era-dupontromain.fr',

  // Ollama sur le VPS. Ne JAMAIS pointer un modèle « :cloud » ici :
  // le texte contient nom, revenus et situation d'un candidat.
  ollama: 'http://127.0.0.1:11434/api/generate',
  modele: 'qwen2.5:3b-instruct-q4_K_M',
};

const entree = $input.all();
return (entree.length ? entree : [{ json: {} }])
  .map((item) => ({ json: { ...item.json, ...PARAMETRES } }));`,
  );
}

module.exports = { fabrique, noeudParametres, identifiant };
