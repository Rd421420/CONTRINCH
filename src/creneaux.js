/**
 * WF-4 · Attribution des créneaux de visite.
 *
 * Principe arrêté (§5) : la première visite ancre le secteur. Les blocs
 * terrain démarrent vides ; le premier candidat qui réserve fixe la zone,
 * les suivants ne se voient proposer ce groupe que si leur lot est à moins
 * de 12 km de l'ancre.
 *
 * Deux filtres distincts sur l'agenda, et c'est le point à ne pas confondre :
 *   — occupation : TOUS les événements comptent, y compris un déjeuner ;
 *   — ancre      : seuls les événements portant un bloc ImmoAgenda comptent.
 * Un rendez-vous personnel occupe la place mais n'ancre aucune zone.
 */

const {
  BLOCS_TERRAIN,
  DUREE_VISITE_MIN,
  RAYON_ANCRE_KM,
  PLAFOND_VISITES_APRES_MIDI,
  PLAFOND_EDL_APRES_MIDI,
  SEMAINES_RECHERCHE_MAX,
} = require('./config');
const T = require('./temps');
const cal = require('./calendrier');
const geo = require('./geo');
const immoagenda = require('./immoagenda');

const PRIORITE = {
  MEME_LOT: 1,      // enchaînement direct sur le lot déjà visité cet après-midi
  PROCHE_ANCRE: 2,  // à moins de 12 km d'une ancre existante
  NOUVELLE_ANCRE: 3, // groupe vide : le candidat ouvre le secteur
};

const TYPES_EDL = ["etat des lieux d'entree", 'etat des lieux de sortie'];

function versDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  return T.depuisIso(v);
}

function chevauche(aDebut, aFin, bDebut, bFin) {
  return aDebut < bFin && bDebut < aFin;
}

function sansAccentMinuscule(texte) {
  return String(texte ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Enrichit un événement Google Agenda de sa lecture ImmoAgenda.
 * `bloc` vaut null pour tout ce qui n'est pas un rendez-vous métier.
 */
function lireEvenement(evenement) {
  const bloc = immoagenda.lireDescription(evenement.description);
  const type = bloc && bloc.type ? sansAccentMinuscule(bloc.type) : null;
  return {
    debut: versDate(evenement.debut ?? evenement.start),
    fin: versDate(evenement.fin ?? evenement.end),
    summary: evenement.summary || '',
    bloc,
    estMetier: bloc !== null,
    estEdl: type ? TYPES_EDL.includes(type) : false,
    estVisite: type === 'visite',
    reference: bloc && bloc.lot ? bloc.lot.reference : null,
  };
}

/** Coordonnées du lot d'un événement, via la table `lots`. */
function localiser(evenement, lots) {
  if (!evenement.reference) return null;
  const lot = lots ? lots[evenement.reference] : null;
  if (!lot) return null;
  const latitude = Number(lot.latitude ?? lot.lat);
  const longitude = Number(lot.longitude ?? lot.lon);
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}

/** Blocages provisoires encore actifs : ils masquent le créneau aux autres candidats. */
function blocagesActifs(reservations, maintenant, candidatId) {
  return (reservations || [])
    .filter((r) => r.candidat_id === undefined || r.candidat_id !== candidatId)
    .filter((r) => r.confirme === true || versDate(r.reserve_jusqu_a) > maintenant)
    .map((r) => ({ debut: versDate(r.debut), fin: versDate(r.fin) }));
}

/**
 * Propose jusqu'à `nb` créneaux pour un lot.
 *
 * Ne lit ni la base ni Google Agenda : tout arrive en paramètre, ce qui rend
 * la fonction rejouable sur un cas réel sans rien brancher.
 */
function proposerCreneaux({
  lot,
  dateDemande,
  maintenant = dateDemande,
  evenements = [],
  reservations = [],
  joursFeries = [],
  lots = {},
  candidatId = null,
  nb = 2,
  rayonKm = RAYON_ANCRE_KM,
  plafondVisites = PLAFOND_VISITES_APRES_MIDI,
  semainesMax = SEMAINES_RECHERCHE_MAX,
}) {
  const feries = cal.referentielFeries(joursFeries);
  const debutRecherche = cal.dateMini(versDate(dateDemande), feries);
  const lus = evenements.map(lireEvenement).sort((a, b) => a.debut - b.debut);
  const bloques = blocagesActifs(reservations, versDate(maintenant), candidatId);
  const propositions = [];
  const journaux = [];

  for (let decalage = 0; decalage < semainesMax * 7; decalage += 1) {
    const jour = T.ajouterJours(debutRecherche, decalage);
    const jourSemaine = T.champs(jour).jourSemaine;
    const blocs = BLOCS_TERRAIN.filter((b) => b.jour === jourSemaine);
    if (!blocs.length || !cal.estJourOuvre(jour, feries)) continue;

    const debutAM = T.aHeure(jour, Math.min(...blocs.map((b) => b.debut)), 0);
    const finAM = T.aHeure(jour, Math.max(...blocs.map((b) => b.fin)), 0);
    const apresMidi = lus.filter((e) => chevauche(e.debut, e.fin, debutAM, finAM));

    const visites = apresMidi.filter((e) => e.estVisite).length;
    if (visites >= plafondVisites) {
      journaux.push({ jour: T.isoJour(jour), motif: 'plafond_visites_atteint' });
      continue;
    }

    // Un seul EDL par après-midi ; s'il y en a un, il ancre toute la journée.
    const edl = apresMidi.find((e) => e.estEdl) || null;
    if (apresMidi.filter((e) => e.estEdl).length > PLAFOND_EDL_APRES_MIDI) continue;

    for (const bloc of blocs) {
      const debutBloc = T.aHeure(jour, bloc.debut, 0);
      const finBloc = T.aHeure(jour, bloc.fin, 0);
      const metierBloc = apresMidi.filter(
        (e) => e.estMetier && chevauche(e.debut, e.fin, debutBloc, finBloc),
      );

      // Ancre du groupe : l'EDL de l'après-midi s'il existe, sinon le premier
      // événement ImmoAgenda posé dans la fenêtre.
      const ancre = edl || metierBloc[0] || null;
      const positionAncre = ancre ? localiser(ancre, lots) : null;
      if (ancre && !positionAncre) {
        journaux.push({ jour: T.isoJour(jour), groupe: bloc.groupe, motif: 'ancre_non_localisee' });
        continue;
      }

      const distance = positionAncre ? geo.distanceKm(positionAncre, lot) : null;
      const memeLot = metierBloc.filter((e) => e.reference && e.reference === lot.reference);

      let priorite;
      if (memeLot.length) priorite = PRIORITE.MEME_LOT;
      else if (!ancre) priorite = PRIORITE.NOUVELLE_ANCRE;
      else if (distance !== null && distance <= rayonKm) priorite = PRIORITE.PROCHE_ANCRE;
      else {
        journaux.push({
          jour: T.isoJour(jour), groupe: bloc.groupe, motif: 'hors_rayon', distance,
        });
        continue;
      }

      // Sur le même lot, on enchaîne : le candidat prend le créneau qui suit
      // immédiatement le dernier posé, pour un seul déplacement.
      const planche = memeLot.length
        ? memeLot.reduce((max, e) => (e.fin > max ? e.fin : max), memeLot[0].fin)
        : debutBloc;

      const libre = premierCreneauLibre({
        depuis: planche < debutBloc ? debutBloc : planche,
        finBloc,
        occupes: apresMidi,
        bloques,
        maintenant: versDate(maintenant),
      });
      if (!libre) continue;

      propositions.push({
        debut: libre.debut,
        fin: libre.fin,
        jour: T.isoJour(jour),
        groupe: bloc.groupe,
        priorite,
        distance_ancre_km: distance,
        ancre: ancre ? ancre.reference : null,
        motif: {
          [PRIORITE.MEME_LOT]: 'enchainement sur le même lot',
          [PRIORITE.PROCHE_ANCRE]: `à ${distance} km de l'ancre`,
          [PRIORITE.NOUVELLE_ANCRE]: 'ouverture d\'un nouveau secteur',
        }[priorite],
      });
    }

    if (propositions.length >= nb && propositions.some((p) => p.priorite <= PRIORITE.PROCHE_ANCRE)) {
      break; // inutile d'explorer plus loin : on a déjà mieux que du déplacement isolé
    }
  }

  propositions.sort((a, b) => a.priorite - b.priorite || a.debut - b.debut);
  return { creneaux: propositions.slice(0, nb), journal: journaux };
}

/** Premier créneau de 30 min libre dans la fenêtre, occupation et blocages compris. */
function premierCreneauLibre({ depuis, finBloc, occupes, bloques, maintenant }) {
  let curseur = depuis > maintenant ? depuis : maintenant;
  // aligner sur la grille de 30 min du bloc
  const pas = DUREE_VISITE_MIN * T.MS_MINUTE;
  const reste = (curseur - depuis) % pas;
  if (reste) curseur = new Date(curseur.getTime() + (pas - reste));

  for (; curseur.getTime() + pas <= finBloc.getTime(); curseur = new Date(curseur.getTime() + pas)) {
    const fin = new Date(curseur.getTime() + pas);
    const prisAgenda = occupes.some((e) => chevauche(e.debut, e.fin, curseur, fin));
    const prisBase = bloques.some((b) => chevauche(b.debut, b.fin, curseur, fin));
    if (!prisAgenda && !prisBase) return { debut: curseur, fin };
  }
  return null;
}

/**
 * Vérification à la confirmation (§5).
 *
 * Le blocage en base ne suffit pas : il ne connaît que les réservations du
 * système, et tu gardes la priorité absolue sur ton agenda via ImmoFacile.
 * On relit donc l'agenda AVANT toute écriture.
 */
function creneauEncoreLibre(creneau, evenements, reservations = [], { maintenant = new Date(), candidatId = null } = {}) {
  const debut = versDate(creneau.debut);
  const fin = versDate(creneau.fin);
  const occupe = evenements
    .map(lireEvenement)
    .some((e) => chevauche(e.debut, e.fin, debut, fin));
  if (occupe) return false;
  return !blocagesActifs(reservations, versDate(maintenant), candidatId)
    .some((b) => chevauche(b.debut, b.fin, debut, fin));
}

module.exports = { proposerCreneaux, creneauEncoreLibre, lireEvenement, PRIORITE };
