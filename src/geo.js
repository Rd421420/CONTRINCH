/**
 * Géocodage et distance.
 *
 * Le géocodage se fait à la commune, pas à l'adresse exacte : le seuil de
 * regroupement est à 12 km, et aucune décision ne se joue à l'échelle de la
 * rue. C'est ce qui rend l'absence d'API SPI indolore ici (§5).
 *
 * API Adresse data.gouv : gratuite, sans clé, hébergée en France — donc
 * aucun sous-traitant supplémentaire à déclarer. On ne lui envoie qu'un nom
 * de commune, jamais de donnée candidat.
 */

const { API_ADRESSE, RAYON_ANCRE_KM } = require('./config');

const RAYON_TERRE_KM = 6371;

function radians(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Distance orthodromique en kilomètres (haversine).
 * Pas d'appel à un service de routage en v1 : à 12 km de seuil, l'écart
 * entre distance à vol d'oiseau et distance routière ne fait pas basculer
 * de décision.
 */
function distanceKm(a, b) {
  if (!a || !b) return null;
  const lat1 = Number(a.latitude ?? a.lat);
  const lon1 = Number(a.longitude ?? a.lon);
  const lat2 = Number(b.latitude ?? b.lat);
  const lon2 = Number(b.longitude ?? b.lon);
  if ([lat1, lon1, lat2, lon2].some((v) => !Number.isFinite(v))) return null;

  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * RAYON_TERRE_KM * Math.asin(Math.sqrt(h)) * 100) / 100;
}

/** Deux lots sont-ils regroupables sur le même déplacement ? */
function dansLeRayon(a, b, rayonKm = RAYON_ANCRE_KM) {
  const d = distanceKm(a, b);
  return d !== null && d <= rayonKm;
}

/**
 * Géocode une commune (avec code postal si connu) via l'API Adresse.
 * Renvoie null plutôt que de lever : un lot non géocodé ne doit pas
 * interrompre la séquence, il part en arbitrage.
 */
async function geocoderCommune(commune, codePostal, { fetchImpl = fetch } = {}) {
  if (!commune) return null;
  const url = new URL(API_ADRESSE);
  url.searchParams.set('q', commune);
  url.searchParams.set('type', 'municipality');
  url.searchParams.set('limit', '1');
  if (codePostal) url.searchParams.set('postcode', codePostal);

  const reponse = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!reponse.ok) return null;

  const corps = await reponse.json();
  const trouve = corps && corps.features && corps.features[0];
  if (!trouve) return null;

  const [longitude, latitude] = trouve.geometry.coordinates;
  return {
    commune: trouve.properties.city || trouve.properties.name || commune,
    code_postal: trouve.properties.postcode || codePostal || null,
    latitude,
    longitude,
  };
}

module.exports = { distanceKm, dansLeRayon, geocoderCommune, RAYON_TERRE_KM };
