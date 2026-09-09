/**
 * Manipulation d'instants en heure de Paris.
 *
 * Tout le dispositif raisonne en heure locale française : les blocs terrain
 * sont à 14 h, la plage d'envoi va de 9 h à 19 h, le J+2 se compte en jours
 * civils. Le serveur, lui, peut tourner en UTC. On ne se repose donc jamais
 * sur getHours() : chaque lecture et chaque construction passent par ce
 * module, qui applique explicitement le décalage d'Europe/Paris — décalage
 * qui change deux fois par an.
 */

const { FUSEAU } = require('./config');

const FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSEAU,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

const MS_MINUTE = 60 * 1000;
const MS_HEURE = 60 * MS_MINUTE;
const MS_JOUR = 24 * MS_HEURE;

/** Champs calendaires d'un instant, tels qu'ils s'affichent à Paris. */
function champs(instant) {
  const p = Object.fromEntries(
    FORMAT.formatToParts(instant).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]),
  );
  const annee = Number(p.year);
  const mois = Number(p.month);
  const jour = Number(p.day);
  // hour12:false peut rendre « 24 » pour minuit selon les moteurs.
  const heures = Number(p.hour) % 24;
  const minutes = Number(p.minute);
  const secondes = Number(p.second);
  return {
    annee, mois, jour, heures, minutes, secondes,
    // getUTCDay sur la date murale donne le bon jour de semaine (0 = dimanche)
    jourSemaine: new Date(Date.UTC(annee, mois - 1, jour)).getUTCDay(),
  };
}

/** Décalage d'Europe/Paris à cet instant, en millisecondes (+1 h ou +2 h). */
function decalage(instant) {
  const c = champs(instant);
  const mural = Date.UTC(c.annee, c.mois - 1, c.jour, c.heures, c.minutes, c.secondes);
  return mural - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Construit l'instant correspondant à une heure murale parisienne.
 *
 * Deux passes : on part du décalage estimé sur l'instant naïf, puis on le
 * recalcule sur le résultat. C'est ce second passage qui rattrape les deux
 * dimanches de changement d'heure.
 */
function instant(annee, mois, jour, heures = 0, minutes = 0, secondes = 0) {
  const mural = Date.UTC(annee, mois - 1, jour, heures, minutes, secondes);
  let d = new Date(mural - decalage(new Date(mural)));
  d = new Date(mural - decalage(d));
  return d;
}

/** Reconstruit un instant en remplaçant l'heure murale, à date constante. */
function aHeure(reference, heures, minutes = 0) {
  const c = champs(reference);
  return instant(c.annee, c.mois, c.jour, heures, minutes, 0);
}

/** Minuit parisien du jour de `reference`. */
function debutDeJour(reference) {
  return aHeure(reference, 0, 0);
}

/** « 2026-09-09 » — clé de comparaison avec la table `jours_feries`. */
function isoJour(instantOuDate) {
  const c = champs(instantOuDate);
  return `${c.annee}-${String(c.mois).padStart(2, '0')}-${String(c.jour).padStart(2, '0')}`;
}

/** Avance de n jours civils en conservant l'heure murale (robuste au DST). */
function ajouterJours(reference, n) {
  const c = champs(reference);
  return instant(c.annee, c.mois, c.jour + n, c.heures, c.minutes, c.secondes);
}

function ajouterMinutes(reference, n) {
  return new Date(reference.getTime() + n * MS_MINUTE);
}

/** Heure murale exprimée en fraction d'heure : 14 h 30 → 14.5. */
function heureDecimale(reference) {
  const c = champs(reference);
  return c.heures + c.minutes / 60 + c.secondes / 3600;
}

/** Analyse « 2026-09-09 » ou « 2026-09-09T14:00 » en heure de Paris. */
function depuisIso(texte) {
  const m = String(texte).match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (!m) throw new TypeError(`Date illisible : ${texte}`);
  return instant(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

module.exports = {
  MS_MINUTE, MS_HEURE, MS_JOUR,
  champs, decalage, instant, aHeure, debutDeJour,
  isoJour, ajouterJours, ajouterMinutes, heureDecimale, depuisIso,
};
