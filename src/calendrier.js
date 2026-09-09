/**
 * Jours ouvrés, délai J+2, plage d'envoi et compteur de 2 heures ouvrées.
 *
 * Un seul référentiel de jours fériés sert aux deux usages (§5) : le calcul
 * du J+2 et la mise en pause du compteur de blocage.
 */

const { JOURS_OUVRES, PLAGE_ENVOI, DELAI_MINI_JOURS_OUVRES, BLOCAGE_HEURES_OUVREES } = require('./config');
const T = require('./temps');

/**
 * Normalise le référentiel de fériés en Set de clés « YYYY-MM-DD ».
 * Accepte un Set, un tableau de chaînes, ou l'objet renvoyé tel quel par
 * l'API Etalab ({ "2026-01-01": "1er janvier", ... }).
 */
function referentielFeries(feries) {
  if (!feries) return new Set();
  if (feries instanceof Set) return feries;
  if (Array.isArray(feries)) return new Set(feries.map(String));
  return new Set(Object.keys(feries));
}

function estFerie(date, feries) {
  return referentielFeries(feries).has(T.isoJour(date));
}

/** Ouvré = lundi à vendredi, hors jours fériés. Le samedi est fermé. */
function estJourOuvre(date, feries) {
  return JOURS_OUVRES.includes(T.champs(date).jourSemaine) && !estFerie(date, feries);
}

/** Prochain jour ouvré strictement après `date` (heure murale conservée). */
function jourOuvreSuivant(date, feries) {
  let d = T.ajouterJours(date, 1);
  for (let i = 0; i < 400 && !estJourOuvre(d, feries); i += 1) d = T.ajouterJours(d, 1);
  return d;
}

/** Avance de `n` jours ouvrés. n = 0 renvoie la date inchangée. */
function ajouterJoursOuvres(date, n, feries) {
  let d = date;
  for (let i = 0; i < n; i += 1) d = jourOuvreSuivant(d, feries);
  return d;
}

/**
 * Premier jour à partir duquel un créneau peut être proposé : J+2 ouvré.
 * Renvoie le minuit parisien de ce jour — c'est une borne de date, pas
 * d'horaire : le filtre des blocs terrain s'applique ensuite (§5).
 *
 * Note : la table d'illustration du cahier des charges annonce « lundi
 * suivant » pour une demande reçue le vendredi. La règle écrite au-dessus
 * d'elle (date + 2 jours ouvrés) donne mardi, donc mercredi après filtrage
 * des blocs terrain. C'est la règle qui fait foi ici — voir README.
 */
function dateMini(dateDemande, feries) {
  return T.debutDeJour(ajouterJoursOuvres(dateDemande, DELAI_MINI_JOURS_OUVRES, feries));
}

/** Un SMS peut-il partir à cet instant ? Lundi–vendredi, 9 h–19 h, hors fériés. */
function dansPlageEnvoi(date, feries) {
  if (!estJourOuvre(date, feries)) return false;
  const h = T.heureDecimale(date);
  return h >= PLAGE_ENVOI.debut && h < PLAGE_ENVOI.fin;
}

/**
 * Instant d'envoi effectif d'un message : maintenant si la plage est
 * ouverte, sinon la prochaine ouverture. C'est la file d'attente du WF-2.
 *
 * Les réponses entrantes, elles, sont traitées à toute heure : seule
 * l'émission attend (§5).
 */
function prochaineOuverture(date, feries) {
  if (dansPlageEnvoi(date, feries)) return date;
  if (estJourOuvre(date, feries) && T.heureDecimale(date) < PLAGE_ENVOI.debut) {
    return T.aHeure(date, PLAGE_ENVOI.debut, 0);
  }
  return T.aHeure(jourOuvreSuivant(date, feries), PLAGE_ENVOI.debut, 0);
}

/**
 * Ajoute des heures **ouvrées** : le compteur se met en pause à 19 h et
 * reprend à 9 h le lendemain ouvré.
 *
 * Sans cette pause, une proposition partie vendredi 18 h expirerait à 20 h,
 * libérerait les créneaux tout le week-end et déclencherait une relance
 * le lundi sur un candidat qui n'a jamais eu l'occasion de répondre.
 */
function ajouterHeuresOuvrees(date, heures, feries) {
  let curseur = prochaineOuverture(date, feries);
  let restant = heures;

  for (let garde = 0; garde < 1000 && restant > 1e-9; garde += 1) {
    const disponible = PLAGE_ENVOI.fin - T.heureDecimale(curseur);
    if (restant < disponible) {
      return T.ajouterMinutes(curseur, Math.round(restant * 60));
    }
    restant -= disponible;
    curseur = T.aHeure(jourOuvreSuivant(curseur, feries), PLAGE_ENVOI.debut, 0);
  }
  return curseur;
}

/** Échéance des deux créneaux bloqués : 2 heures ouvrées après l'envoi. */
function expirationBlocage(dateEnvoi, feries) {
  return ajouterHeuresOuvrees(dateEnvoi, BLOCAGE_HEURES_OUVREES, feries);
}

module.exports = {
  referentielFeries,
  estFerie,
  estJourOuvre,
  jourOuvreSuivant,
  ajouterJoursOuvres,
  dateMini,
  dansPlageEnvoi,
  prochaineOuverture,
  ajouterHeuresOuvrees,
  expirationBlocage,
};
