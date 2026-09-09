/**
 * Lecture des réponses SMS.
 *
 * Règle du cahier des charges §6 : réponses fermées par switch sur le texte
 * normalisé, aucun LLM. Montants par regex d'abord, LLM seulement en repli
 * — et un repli local (Ollama), jamais un modèle « cloud », puisque le
 * message contient nom, revenus et situation du candidat.
 */

/** Minuscules, accents retirés, espaces normalisés. */
function normaliser(texte) {
  return String(texte ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * CONSEILLER — mise en relation humaine, disponible à tout moment.
 * Surtout pas STOP : Twilio l'intercepte avant le webhook et place le
 * numéro en liste de blocage définitive (§4).
 */
function demandeConseiller(texte) {
  return /\bconseill?er\b|\bhumain\b|\brappel(?:ez|er)?[- ]moi\b/.test(normaliser(texte));
}

/** STOP reste la véritable désinscription, obligatoire en France. */
function demandeDesinscription(texte) {
  return /^(stop|stopall|arret|unsubscribe|desabonnement)\b/.test(normaliser(texte));
}

/** Choix numéroté 1..max. « 1 », « 1 - CDI », « réponse 2 » → 1, 2. */
function parseChoix(texte, max) {
  const n = normaliser(texte);
  const m = n.match(/(?:^|\D)([1-9])(?:\D|$)/);
  if (!m) return null;
  const valeur = Number(m[1]);
  return valeur >= 1 && valeur <= max ? valeur : null;
}

function parseOuiNon(texte) {
  const n = normaliser(texte);
  if (/^(oui|o|yes|y|si|ok|exact|c'?est ca|tout a fait)\b/.test(n)) return true;
  if (/^(non|n|no|nan|pas encore|aucun)\b/.test(n)) return false;
  return null;
}

/** Réponse à la proposition de créneaux : A, B ou AUTRE. */
function parseCreneau(texte) {
  const n = normaliser(texte);
  if (/\bautre\b|aucun|ne (me )?convient|pas possible|impossible/.test(n)) return 'AUTRE';
  if (/(?:^|\W)a(?:\W|$)/.test(n)) return 'A';
  if (/(?:^|\W)b(?:\W|$)/.test(n)) return 'B';
  return null;
}

/**
 * Montant en euros.
 *
 * Couvre « 1850 », « 1 850 € », « 1850,50 », « 2000e », « 1.850 euros ».
 * Échoue volontairement sur « environ deux mille » ou « 1200 chacun on est
 * deux » : ces cas partent au LLM local, avec sortie JSON stricte.
 *
 * Le point est traité comme séparateur de milliers, jamais comme décimale :
 * en France « 1.850 » se lit mille huit cent cinquante. Seule la virgule
 * ouvre des centimes.
 */
function parseMontant(texte) {
  const brut = String(texte ?? '');
  if (/\b(chacun|chacune|par (?:personne|mois de)|environ|a peu pres)\b/i.test(normaliser(brut))) {
    return null; // ambigu : ne pas deviner, passer au repli
  }

  const m = brut.match(/(\d[\d\s.]*(?:,\d{1,2})?)\s*(?:€|eur(?:os?)?|e\b)?/i);
  if (!m) return null;

  const nombre = Number(m[1].replace(/[\s.]/g, '').replace(',', '.'));
  if (!Number.isFinite(nombre)) return null;
  return Math.round(nombre * 100) / 100;
}

/** « 0 » est une réponse valide aux revenus complémentaires, pas une absence. */
function parseMontantOuZero(texte) {
  const n = normaliser(texte);
  if (/^(non|aucun|rien|nada|0|zero)\b/.test(n)) return 0;
  return parseMontant(texte);
}

/** Liste de montants : « 2100 et 1800 », « 2100 / 1800 », « 2100, 1800 ». */
function parseMontants(texte, attendus) {
  const trouves = String(texte ?? '')
    .split(/\s*(?:et|,|;|\/|\+|\n)\s*/i)
    .map((part) => parseMontant(part))
    .filter((v) => v !== null && v > 0);

  if (!trouves.length) return null;
  if (attendus && trouves.length !== attendus) return null;
  return trouves;
}

/** Entier court : nombre de cautions, durée de contrat en mois. */
function parseEntier(texte, { min = 0, max = 999 } = {}) {
  const n = normaliser(texte);
  const mots = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4 };
  for (const [mot, valeur] of Object.entries(mots)) {
    if (new RegExp(`\\b${mot}\\b`).test(n)) return valeur;
  }
  const m = n.match(/\d+/);
  if (!m) return null;
  const valeur = Number(m[0]);
  return valeur >= min && valeur <= max ? valeur : null;
}

module.exports = {
  normaliser,
  demandeConseiller,
  demandeDesinscription,
  parseChoix,
  parseOuiNon,
  parseCreneau,
  parseMontant,
  parseMontantOuZero,
  parseMontants,
  parseEntier,
};
