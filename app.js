/* =====================================================================
   Simulateur de voile — Croiseur 11 m (sloop GV + génois)
   App web autonome (sans dépendance). Modèle pédagogique enrichi :
   - vraie polaire de vitesse (matrice TWS × TWA, interpolation bilinéaire)
   - vent réel / apparent, gîte, réglage des voiles + ris
   - vagues (état de mer) : tangage/roulis + effet sur la vitesse
   - inertie de barre, courant de marée variable selon le lieu
   - vue à bord (horizon qui s'incline), marée, sonde / échouement
   - leçons guidées + sons & annonces vocales
   ===================================================================== */

'use strict';

/* ---------------------------------------------------------------------
   Constantes bateau de référence (~11 m)
   --------------------------------------------------------------------- */
const BOAT = {
  loa: 11.0, lwl: 9.6, draft: 1.95, hullSpeed: 7.5,
  noGo: 32,            // demi-angle du près (° / vent)
  turnRateMax: 22,     // °/s à pleine barre, vitesse normale
  rudderRate: 38,      // °/s de débattement de barre (inertie)
  leewayMax: 6,        // dérive max au près (°)
};

/* Vraie polaire : vitesse bateau (nœuds) selon TWS (lignes) × TWA (colonnes).
   Interpolation bilinéaire ; sous le no-go, rampe vers 0. */
const TWS_PTS = [4, 8, 12, 16, 20, 30];
const TWA_PTS = [40, 50, 60, 75, 90, 110, 120, 135, 150, 165, 180];
const POLAR_M = [
  /* 4 kn */ [2.0, 2.6, 3.0, 3.4, 3.5, 3.4, 3.2, 2.8, 2.3, 1.8, 1.5],
  /* 8 kn */ [3.6, 4.4, 4.9, 5.3, 5.4, 5.3, 5.0, 4.5, 3.9, 3.2, 2.9],
  /*12 kn */ [4.8, 5.6, 6.1, 6.5, 6.7, 6.6, 6.3, 5.8, 5.1, 4.4, 4.0],
  /*16 kn */ [5.5, 6.2, 6.7, 7.0, 7.2, 7.3, 7.1, 6.6, 5.9, 5.2, 4.8],
  /*20 kn */ [5.9, 6.6, 7.0, 7.3, 7.5, 7.6, 7.5, 7.0, 6.4, 5.7, 5.3],
  /*30 kn */ [5.6, 6.4, 7.0, 7.4, 7.7, 7.9, 7.9, 7.5, 7.0, 6.4, 6.0],
];

/* Hauteur significative des vagues (m) selon l'état de mer Douglas 0..9 */
const SEA_HS = [0, 0.1, 0.4, 1.0, 2.0, 3.5, 5.5, 8.5, 12, 16];

/* ---------------------------------------------------------------------
   Helpers
   --------------------------------------------------------------------- */
const DEG = Math.PI / 180;
const KN_TO_MS = 0.514444;
const norm360 = a => ((a % 360) + 360) % 360;
const norm180 = a => { a = norm360(a); return a > 180 ? a - 360 : a; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

function rowSpeed(row, twa) {
  if (twa <= TWA_PTS[0]) {
    if (twa <= BOAT.noGo) return 0;
    return lerp(0, row[0], (twa - BOAT.noGo) / (TWA_PTS[0] - BOAT.noGo));
  }
  for (let i = 0; i < TWA_PTS.length - 1; i++)
    if (twa >= TWA_PTS[i] && twa <= TWA_PTS[i + 1])
      return lerp(row[i], row[i + 1], (twa - TWA_PTS[i]) / (TWA_PTS[i + 1] - TWA_PTS[i]));
  return row[row.length - 1];
}
function polarSpeed(twa, tws) {
  twa = Math.abs(norm180(twa));
  tws = clamp(tws, TWS_PTS[0], TWS_PTS[TWS_PTS.length - 1]);
  let lo = 0;
  while (lo < TWS_PTS.length - 2 && tws > TWS_PTS[lo + 1]) lo++;
  const f = clamp((tws - TWS_PTS[lo]) / (TWS_PTS[lo + 1] - TWS_PTS[lo]), 0, 1);
  return lerp(rowSpeed(POLAR_M[lo], twa), rowSpeed(POLAR_M[lo + 1], twa), f);
}

/* ---------------------------------------------------------------------
   État de la simulation
   --------------------------------------------------------------------- */
const S = {
  running: true, timeScale: 1, t: 6 * 3600,

  // Environnement (réglages Méditerranée / L'Estartit par défaut)
  windDir: 340, windSpd: 14, windSpdInst: 14, gust: 30,
  sea: 2, weather: 'sun',
  tideRange: 0.5, tidePhase: 0.5, curMax: 0.4,

  // Bateau (départ : sortie du port de L'Estartit, cap au large)
  heading: 90, rudder: 0, rudderCmd: 0,
  stw: 0, heel: 0, leeway: 0,
  mainUp: true, jibUp: true, reef: 0,
  autoTrim: true, mainTrim: 0.6, jibTrim: 0.6, luffing: false,

  // Position (mètres, origine = port de L'Estartit)
  x: 250, y: 0, trail: [], waypoint: { x: 850, y: -120 },

  // Pilote / manœuvres
  autohelm: false, autohelmHeading: 90, maneuver: null,

  // Carte
  chartScale: 0.06, placingWpt: false,

  // Mouvements de coque (vagues)
  pitch: 0, roll: 0,

  aground: false,
};

/* ---------------------------------------------------------------------
   ZONE DE NAVIGATION — L'Estartit / Îles Medes (Méditerranée, Costa Brava)
   Repère mètres : origine = port de L'Estartit, +x = est (large), +y = nord.
   Côte stylisée mais reconnaissable : massif du Montgrí (Cap de la Barra)
   au nord qui avance vers l'est, longue plage sablonneuse au sud (baie de
   Pals), et l'archipel des Medes au large à l'est-sud-est.
   --------------------------------------------------------------------- */
const REGION = { name: "L'Estartit — Îles Medes" };

/* Positions calées depuis les coordonnées réelles (origine = port de L'Estartit,
   42.0577°N 3.2033°E). 1° lat ≈ 111132 m ; 1° lon ≈ 82700 m à 42°N. */

// Limite est de la terre ferme selon la latitude y (terre si x < coastX)
function coastX(y) {
  let cx = -40;
  cx += 760 * Math.exp(-Math.pow((y - 1100) / 650, 2));   // massif rocheux du Montgrí (large bombement)
  cx += 180 * Math.exp(-Math.pow((y - 820) / 240, 2));    // Cap de la Barra (pointe plus marquée)
  if (y < 0) cx += clamp(y * 0.10, -520, 0);              // longue plage qui recule vers le SO (baie de Pals)
  cx += 22 * Math.sin(y / 260) * clamp(y / 600, 0, 1);    // calanques de la côte rocheuse (nord)
  return cx;
}
// Archipel des Medes (îles + cailloux), aligné NO–SE, phare sur Meda Gran
const ISLANDS = [
  { x: 1560, y: -1090, r: 130, name: 'Meda Petita' },
  { x: 1500, y: -1180, r: 45,  name: 'Medellot' },
  { x: 1654, y: -1256, r: 230, name: 'Meda Gran', light: true },
  { x: 1610, y: -1380, r: 35,  name: 'Carall Bernat' },
  { x: 1760, y: -1430, r: 70,  name: 'Tascó Gros' },
  { x: 1855, y: -1525, r: 50,  name: 'Tascó Petit' },
];
// Digues du port (segments de terre) ménageant une passe vers le SE
const BREAKWATERS = [
  { ax: -30, ay: -30, bx: 150, by: -130, w: 20 },   // digue extérieure
  { ax: 70,  ay: 70,  bx: 130, by: 10,   w: 16 },   // contre-jetée
];
const START = { x: 250, y: 0, heading: 90 };

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function nearestLand(x, y) {
  let nd = x - coastX(y);            // >0 = en mer (à l'est de la côte)
  let onLand = nd < 0;
  for (const is of ISLANDS) {
    const dd = Math.hypot(x - is.x, y - is.y) - is.r;
    if (dd < 0) onLand = true;
    if (dd < nd) nd = dd;
  }
  for (const bw of BREAKWATERS) {
    const dd = segDist(x, y, bw.ax, bw.ay, bw.bx, bw.by) - bw.w;
    if (dd < 0) onLand = true;
    if (dd < nd) nd = dd;
  }
  return { dist: nd, onLand };
}
function isLand(x, y) { return nearestLand(x, y).onLand; }

function depthFromDist(dist, x, y) {
  let d = 1.0 + Math.max(0, dist) * 0.045;                // la côte s'enfonce vers le large
  d += 1.5 * Math.sin(x / 600) * Math.cos(y / 700) * clamp(dist / 250, 0, 1); // relief sous-marin (au large)
  return clamp(d, 0.3, 48);
}
function seabedDepth(x, y) {
  const nl = nearestLand(x, y);
  return nl.onLand ? -3 : depthFromDist(nl.dist, x, y);
}
function tideHeight() { return (S.tideRange / 2) * (1 - Math.cos(2 * Math.PI * S.tidePhase)); }
function tideCurrentBase() {
  const spd = S.curMax * Math.sin(2 * Math.PI * S.tidePhase);
  return { spd: Math.abs(spd), dir: spd >= 0 ? 45 : 225 };
}
/* le courant accélère dans les petits fonds / chenaux (effet de constriction) */
function currentAt(x, y) {
  const cur = tideCurrentBase();
  const depth = seabedDepth(x, y) + tideHeight();
  const mult = clamp(11 / Math.max(depth, 3), 0.6, 1.9);
  return { spd: cur.spd * mult, dir: cur.dir };
}

function apparentWind() {
  const rel = norm180(S.windDir - S.heading);
  const Vt = S.windSpdInst;
  const awFwd = -Vt * Math.cos(rel * DEG) - S.stw;
  const awStb = -Vt * Math.sin(rel * DEG);
  return { rel, twa: rel, aws: Math.hypot(awFwd, awStb), awa: Math.atan2(-awStb, -awFwd) / DEG };
}

function sailFactor() {
  let f = 0;
  if (S.mainUp) f += 0.55 * (1 - S.reef * 0.27);
  if (S.jibUp) f += 0.45;
  return clamp(f, 0, 1);
}
function optimalTrim(twa) { return clamp((150 - Math.abs(norm180(twa))) / (150 - 40), 0, 1); }

/* ---------------------------------------------------------------------
   Pas de simulation
   --------------------------------------------------------------------- */
function step(dt) {
  // Rafales
  const gAmp = (S.gust / 100) * (0.35 * S.windSpd + 1);
  const gust = gAmp * (0.6 * Math.sin(S.t * 0.07) + 0.4 * Math.sin(S.t * 0.23 + 1.3));
  S.windSpdInst = Math.max(0, S.windSpd + gust);

  const aw = apparentWind();
  const twa = aw.twa, absTwa = Math.abs(twa);

  // Réglage des voiles
  const opt = optimalTrim(twa);
  if (S.autoTrim) { S.mainTrim = opt; S.jibTrim = opt; }
  const trimErr = Math.abs((S.mainTrim + S.jibTrim) / 2 - opt);
  const trimEff = clamp(1 - 0.7 * trimErr, 0.15, 1);

  S.luffing = absTwa < BOAT.noGo && sailFactor() > 0;

  // Vitesse cible : vraie polaire × toile × réglage
  let target = polarSpeed(twa, S.windSpdInst) * sailFactor() * trimEff;

  // Vagues : pénalité dans le clapot debout, surf au portant
  const Hs = SEA_HS[S.sea];
  const headComp = Math.cos(norm180(S.windDir - S.heading) * DEG); // 1 = vagues dans le nez
  const wavePen = clamp(0.045 * Hs * Math.max(0, headComp), 0, 0.55);
  const surf = clamp(0.03 * Hs * Math.max(0, -headComp) * (S.stw > 4 ? 1 : 0), 0, 0.4);
  target *= (1 - wavePen + surf);

  // Gîte excessive = perte de portance ; faseyement ; échouement
  if (S.heel > 28) target *= clamp(1 - (S.heel - 28) / 45, 0.3, 1);
  if (S.luffing) target *= 0.05;
  if (S.aground) target = 0;

  // Inertie longitudinale
  const accel = target > S.stw ? 0.35 : 0.6;
  S.stw = Math.max(0, S.stw + (target - S.stw) * clamp(accel * dt, 0, 1));

  // Gîte
  const press = (aw.aws * aw.aws) / 400;
  const heelTarget = clamp(press * sailFactor() * Math.abs(Math.sin(absTwa * DEG)) * 30, 0, 55);
  S.heel += (heelTarget - S.heel) * clamp(2 * dt, 0, 1);

  // Mouvements de coque (pour la vue à bord)
  const wavePhase = S.t * 1.1;
  S.pitch = Math.sin(wavePhase) * Math.min(Hs, 4);
  S.roll = Math.sin(wavePhase * 0.7 + 1) * Math.min(Hs, 3);

  // Barre commandée : manœuvre auto > pilote auto > ordre manuel
  if (S.maneuver) {
    const err = norm180(S.maneuver.target - S.heading);
    S.rudderCmd = clamp(err * 1.5, -35, 35);
    if (Math.abs(err) < 2) { S.maneuver = null; S.rudderCmd = 0; }
  } else if (S.autohelm) {
    let tgt = S.autohelmHeading;
    if (S.waypoint) {
      tgt = norm360(Math.atan2(S.waypoint.x - S.x, S.waypoint.y - S.y) / DEG);
      S.autohelmHeading = tgt;
    }
    S.rudderCmd = clamp(norm180(tgt - S.heading) * 1.2, -25, 25);
  }
  // Inertie de barre : le gouvernail rejoint la consigne progressivement
  S.rudder += clamp(S.rudderCmd - S.rudder, -BOAT.rudderRate * dt, BOAT.rudderRate * dt);

  // Rotation (il faut de l'erre)
  const wayFactor = clamp(S.stw / 2.5, 0.15, 1);
  S.heading = norm360(S.heading + (S.rudder / 35) * BOAT.turnRateMax * wayFactor * dt);

  // Dérive
  const side = Math.sign(twa) || 1;
  S.leeway = -side * BOAT.leewayMax * clamp(Math.cos(absTwa * DEG), 0, 1) * clamp(1 - S.stw / 6, 0, 1);

  // Déplacement : surface (cap + dérive) + courant local
  const cog0 = S.heading + S.leeway;
  const vsMs = S.stw * KN_TO_MS;
  let vx = vsMs * Math.sin(cog0 * DEG), vy = vsMs * Math.cos(cog0 * DEG);
  const cur = currentAt(S.x, S.y);
  const curMs = cur.spd * KN_TO_MS;
  vx += curMs * Math.sin(cur.dir * DEG); vy += curMs * Math.cos(cur.dir * DEG);
  S.x += vx * dt; S.y += vy * dt;

  if (S.t % 1 < dt || S.trail.length === 0) {
    S.trail.push({ x: S.x, y: S.y });
    if (S.trail.length > 600) S.trail.shift();
  }

  // Sonde & échouement
  const depth = seabedDepth(S.x, S.y) + tideHeight();
  const wasAground = S.aground;
  S.aground = depth < BOAT.draft;
  if (S.aground) { S.stw = 0; if (!wasAground) announce('aground', 'Échouement ! Fond insuffisant.', 5); }
  else if (depth < BOAT.draft + 1.5) announce('shallow', 'Attention, petits fonds.', 12);

  // Horloge & marée
  S.t += dt;
  S.tidePhase = (S.tidePhase + dt / (12.42 * 3600)) % 1;

  // Valeurs pour l'affichage
  S._aw = aw; S._cog = norm360(cog0);
  S._sog = Math.hypot(vx, vy) / KN_TO_MS;
  S._depth = depth; S._cur = cur;

  // Modules dépendant du temps
  updateTutorial(dt);
  Weather.tick(dt);
  Sound.update(aw.aws, Hs, depth);
}

/* =====================================================================
   RENDU
   ===================================================================== */
const $ = id => document.getElementById(id);

/* ---------- Compas ---------- */
function drawCompass(ctx) {
  const w = ctx.canvas.width, c = w / 2, R = c - 16;
  ctx.clearRect(0, 0, w, w); ctx.save(); ctx.translate(c, c);
  ctx.save(); ctx.rotate(-S.heading * DEG);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let a = 0; a < 360; a += 10) {
    const big = a % 30 === 0, r2 = R - (big ? 14 : 8);
    ctx.beginPath();
    ctx.moveTo(R * Math.sin(a * DEG), -R * Math.cos(a * DEG));
    ctx.lineTo(r2 * Math.sin(a * DEG), -r2 * Math.cos(a * DEG));
    ctx.lineWidth = big ? 2 : 1; ctx.strokeStyle = big ? '#2c5572' : '#173247'; ctx.stroke();
  }
  for (const [t, a, col] of [['N', 0, '#f87171'], ['E', 90, '#8fb0c6'], ['S', 180, '#8fb0c6'], ['O', 270, '#8fb0c6']]) {
    ctx.fillStyle = col; ctx.font = 'bold 16px sans-serif';
    ctx.fillText(t, (R - 30) * Math.sin(a * DEG), -(R - 30) * Math.cos(a * DEG));
  }
  ctx.restore();
  ctx.fillStyle = '#ffd166'; ctx.beginPath();
  ctx.moveTo(0, -R + 8); ctx.lineTo(10, 14); ctx.lineTo(0, 6); ctx.lineTo(-10, 14); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#e9f3fb'; ctx.font = 'bold 30px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(Math.round(S.heading).toString().padStart(3, '0') + '°', 0, 2);
  ctx.fillStyle = '#8fb0c6'; ctx.font = '11px sans-serif'; ctx.fillText('CAP', 0, 22);
  ctx.restore();
}

/* ---------- Cadran de vent ---------- */
function drawWind(ctx) {
  const w = ctx.canvas.width, c = w / 2, R = c - 16;
  ctx.clearRect(0, 0, w, w); ctx.save(); ctx.translate(c, c);
  ctx.fillStyle = 'rgba(248,113,113,.10)'; ctx.beginPath(); ctx.moveTo(0, 0);
  ctx.arc(0, 0, R, (-90 - BOAT.noGo) * DEG, (-90 + BOAT.noGo) * DEG); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#173247';
  for (let a = 0; a < 360; a += 30) {
    ctx.beginPath();
    ctx.moveTo(R * Math.sin(a * DEG), -R * Math.cos(a * DEG));
    ctx.lineTo((R - 10) * Math.sin(a * DEG), -(R - 10) * Math.cos(a * DEG)); ctx.stroke();
  }
  ctx.fillStyle = '#8fb0c6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('BÂBORD', -R + 26, 0); ctx.fillText('TRIBORD', R - 26, 0);
  const aw = S._aw || apparentWind();
  const arrow = (angle, color, len, head) => {
    const a = angle * DEG, x = len * Math.sin(a), y = -len * Math.cos(a);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(x, y); ctx.stroke();
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(0, -head); ctx.lineTo(head * .7, head); ctx.lineTo(-head * .7, head); ctx.closePath(); ctx.fill();
    ctx.restore();
  };
  arrow(aw.twa, '#33c2ff', R - 24, 9);
  arrow(aw.awa, '#fbbf24', R - 48, 7);
  ctx.fillStyle = '#e9f3fb'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(Math.round(Math.abs(aw.twa)) + '°', 0, -4);
  ctx.fillStyle = '#33c2ff'; ctx.font = '10px sans-serif'; ctx.fillText('VENT RÉEL', 0, 14);
  ctx.restore();
}

/* ---------- Vue à bord (horizon) ---------- */
const PALETTE = {
  sun:    { sky: '#7fbce8', sea1: '#1f6f96', sea2: '#0c3a52', hz: '#cfeaff', wv: 'rgba(255,255,255,.5)' },
  clouds: { sky: '#9fb0bd', sea1: '#3a5f73', sea2: '#0d2735', hz: '#c8d6df', wv: 'rgba(220,230,235,.4)' },
  rain:   { sky: '#6c7a85', sea1: '#33505f', sea2: '#0b1f2b', hz: '#9fb0bb', wv: 'rgba(200,210,215,.35)' },
  fog:    { sky: '#c2cdd2', sea1: '#8aa0aa', sea2: '#5f7782', hz: '#d8e0e3', wv: 'rgba(255,255,255,.3)' },
  storm:  { sky: '#3a414a', sea1: '#2b3a44', sea2: '#070f15', hz: '#5a6670', wv: 'rgba(180,190,200,.3)' },
};
function drawCockpit(ctx) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const pal = PALETTE[S.weather] || PALETTE.sun;
  const aw = S._aw || apparentWind();
  ctx.clearRect(0, 0, W, H);

  const pitchPx = S.pitch * 7;
  const heelDir = -(Math.sign(aw.twa) || 1);       // gîte sous le vent
  const rollDeg = heelDir * S.heel + S.roll * 1.3;

  // Scène (ciel + mer) inclinée par la gîte
  ctx.save();
  ctx.translate(W / 2, H * 0.52 + pitchPx);
  ctx.rotate(rollDeg * DEG);
  ctx.fillStyle = pal.sky; ctx.fillRect(-W, -H * 1.6, 2 * W, H * 1.6);
  // soleil si beau temps
  if (S.weather === 'sun') { ctx.fillStyle = 'rgba(255,245,200,.9)'; ctx.beginPath(); ctx.arc(-W * 0.28, -H * 0.5, 26, 0, 7); ctx.fill(); }
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, pal.sea1); g.addColorStop(1, pal.sea2);
  ctx.fillStyle = g; ctx.fillRect(-W, 0, 2 * W, H * 1.6);
  ctx.strokeStyle = pal.hz; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-W, 0); ctx.lineTo(W, 0); ctx.stroke();
  // silhouette de la côte (Montgrí, plage, Medes) sur l'horizon
  drawCoastSilhouette(ctx, W, H);
  // crêtes de vagues animées (amplitude selon l'état de mer)
  const amp = Math.min(SEA_HS[S.sea], 8);
  ctx.strokeStyle = pal.wv; ctx.lineWidth = 1.5;
  for (let i = 1; i <= 7; i++) {
    const baseY = i * i * 1.6 + 6;
    const off = (S.t * (18 + i * 6)) % 60;
    ctx.globalAlpha = clamp(0.5 - i * 0.05, 0.1, 0.5);
    ctx.beginPath();
    for (let x = -W; x <= W; x += 24) {
      const y = baseY + Math.sin((x + off) / 30 + i) * (1 + amp * 0.5);
      x === -W ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.restore();

  // Brouillard / pluie (en repère écran)
  if (S.weather === 'fog') { ctx.fillStyle = 'rgba(210,220,225,.5)'; ctx.fillRect(0, 0, W, H); }
  if (S.weather === 'rain' || S.weather === 'storm') {
    ctx.strokeStyle = 'rgba(200,215,225,.35)'; ctx.lineWidth = 1;
    for (let i = 0; i < 70; i++) {
      const x = (i * 97 + S.t * 700) % W, y = (i * 53 + S.t * 900) % H;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 3, y + 12); ctx.stroke();
    }
  }
  if (S.weather === 'storm' && Math.sin(S.t * 7) > 0.985) { ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(0, 0, W, H); }

  // Pont + mât + voiles (repère bateau, droit)
  drawBoatForeground(ctx, W, H, aw);
  // Bandeau de cap + girouette
  drawHeadingTape(ctx, W);
  drawVane(ctx, W, aw);
}
function drawBoatForeground(ctx, W, H, aw) {
  const cx = W / 2, deckY = H - 6;
  // pont (étrave qui s'éloigne)
  ctx.fillStyle = '#101d29';
  ctx.beginPath(); ctx.moveTo(cx, H * 0.62); ctx.lineTo(cx + W * 0.42, deckY); ctx.lineTo(cx - W * 0.42, deckY); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#23435c'; ctx.lineWidth = 2; ctx.stroke();
  // mât
  const mastBaseY = H * 0.78, mastTopY = 12;
  ctx.strokeStyle = '#c9d7e0'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(cx, mastBaseY); ctx.lineTo(cx, mastTopY); ctx.stroke();

  if (sailFactor() <= 0) return;
  const side = -(Math.sign(aw.twa) || 1);           // bôme sous le vent
  const flutter = S.luffing ? Math.sin(S.t * 22) * 14 : 0;
  // grand-voile
  if (S.mainUp) {
    const out = (1 - S.mainTrim) * 0.7 + 0.12;
    const tipX = cx + side * (W * 0.34 * out) + flutter;
    ctx.fillStyle = S.luffing ? 'rgba(235,243,251,.55)' : 'rgba(235,243,251,.92)';
    ctx.beginPath();
    ctx.moveTo(cx, mastTopY + 6);
    ctx.quadraticCurveTo(cx + side * 30, (mastTopY + mastBaseY) / 2, tipX, mastBaseY - 4);
    ctx.lineTo(cx, mastBaseY - 4); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#8fb0c6'; ctx.lineWidth = 1; ctx.stroke();
  }
  // génois (devant le mât)
  if (S.jibUp) {
    const out = (1 - S.jibTrim) * 0.6 + 0.1;
    const tipX = cx + side * (W * 0.26 * out) + flutter * 0.7;
    ctx.fillStyle = S.luffing ? 'rgba(210,225,240,.5)' : 'rgba(210,225,240,.85)';
    ctx.beginPath();
    ctx.moveTo(cx, mastTopY + 40);
    ctx.quadraticCurveTo(cx + side * 24, H * 0.55, tipX, H * 0.7);
    ctx.lineTo(cx, H * 0.7); ctx.closePath(); ctx.fill();
  }
}
function drawHeadingTape(ctx, W) {
  ctx.fillStyle = 'rgba(4,12,20,.6)'; ctx.fillRect(0, 0, W, 22);
  const ppd = W / 110;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let d = -55; d <= 55; d += 5) {
    const a = norm360(Math.round(S.heading / 5) * 5 + d);
    const x = W / 2 + (norm180(a - S.heading)) * ppd;
    if (x < 0 || x > W) continue;
    const big = a % 30 === 0;
    ctx.strokeStyle = '#3a6a86'; ctx.beginPath(); ctx.moveTo(x, 22); ctx.lineTo(x, big ? 10 : 15); ctx.stroke();
    if (big) {
      const lbl = { 0: 'N', 90: 'E', 180: 'S', 270: 'O' }[a] || a;
      ctx.fillStyle = a === 0 ? '#f87171' : '#8fb0c6'; ctx.font = '10px sans-serif';
      ctx.fillText(lbl, x, 6);
    }
  }
  ctx.fillStyle = '#ffd166'; ctx.beginPath(); ctx.moveTo(W / 2, 22); ctx.lineTo(W / 2 - 6, 14); ctx.lineTo(W / 2 + 6, 14); ctx.closePath(); ctx.fill();
}
function drawVane(ctx, W, aw) {
  const cx = W - 34, cy = 52, R = 22;
  ctx.fillStyle = 'rgba(4,12,20,.6)'; ctx.beginPath(); ctx.arc(cx, cy, R + 4, 0, 7); ctx.fill();
  ctx.strokeStyle = '#23435c'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.stroke();
  ctx.fillStyle = '#ffd166'; ctx.beginPath(); ctx.moveTo(cx, cy - R + 2); ctx.lineTo(cx + 3, cy); ctx.lineTo(cx - 3, cy); ctx.closePath(); ctx.fill();
  const a = aw.awa * DEG;
  ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + (R - 4) * Math.sin(a), cy - (R - 4) * Math.cos(a)); ctx.stroke();
  ctx.fillStyle = '#8fb0c6'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('vent app.', cx, cy + R + 12);
}
/* Silhouette de la terre vue depuis le bateau (lancer de rayons par colonne).
   Dessinée dans le repère incliné, l'horizon étant à y = 0. */
function drawCoastSilhouette(ctx, W, H) {
  const ppd = W / 110;                 // champ de vision ~110°, comme le bandeau de cap
  const maxR = 7000, stepR = 80;
  ctx.fillStyle = '#0d2a1d';
  ctx.beginPath(); ctx.moveTo(-W / 2, 2);
  for (let dpx = -W / 2; dpx <= W / 2; dpx += 10) {
    const bearing = S.heading + dpx / ppd;
    const sb = Math.sin(bearing * DEG), cb = Math.cos(bearing * DEG);
    let hit = 0;
    for (let r = 140; r < maxR; r += stepR) {
      if (isLand(S.x + sb * r, S.y + cb * r)) { hit = r; break; }
    }
    const hgt = hit ? clamp(70000 / hit, 3, H * 0.32) : 0;
    ctx.lineTo(dpx, 2 - hgt);
  }
  ctx.lineTo(W / 2, 2); ctx.closePath(); ctx.fill();
}

/* ---------- Carte ---------- */
function drawChart(ctx) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  const sc = S.chartScale, cx = w / 2, cy = h / 2;
  const toScreen = (x, y) => [cx + (x - S.x) * sc, cy - (y - S.y) * sc];
  const grid = 14;
  for (let i = 0; i < w; i += grid) for (let j = 0; j < h; j += grid) {
    const wx = S.x + (i + grid / 2 - cx) / sc, wy = S.y - (j + grid / 2 - cy) / sc;
    const nl = nearestLand(wx, wy);
    let col;
    if (nl.onLand) col = nl.dist < -120 ? 'rgba(70,92,52,.92)' : 'rgba(120,128,74,.92)'; // terre / plage
    else {
      const d = depthFromDist(nl.dist, wx, wy) + tideHeight();
      if (d < BOAT.draft) col = 'rgba(180,80,60,.55)';
      else if (d < 4) col = 'rgba(120,90,40,.40)';
      else if (d < 8) col = 'rgba(40,90,120,.5)';
      else if (d < 16) col = 'rgba(20,70,110,.5)';
      else col = 'rgba(10,45,80,.5)';
    }
    ctx.fillStyle = col; ctx.fillRect(i, j, grid, grid);
  }
  ctx.strokeStyle = 'rgba(120,160,190,.12)'; ctx.lineWidth = 1;
  const nm = 1852 * sc;
  const ox = ((cx - S.x * sc) % nm + nm) % nm, oy = ((cy + S.y * sc) % nm + nm) % nm;
  for (let x = ox; x < w; x += nm) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = oy; y < h; y += nm) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  if (S.trail.length > 1) {
    ctx.strokeStyle = '#3a6a86'; ctx.lineWidth = 2; ctx.beginPath();
    S.trail.forEach((p, k) => { const [sx, sy] = toScreen(p.x, p.y); k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.stroke();
  }
  if (S.waypoint) {
    const [wx, wy] = toScreen(S.waypoint.x, S.waypoint.y);
    ctx.strokeStyle = 'rgba(52,211,153,.5)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(wx, wy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#34d399'; ctx.beginPath(); ctx.arc(wx, wy, 6, 0, 7); ctx.fill();
    ctx.strokeStyle = '#34d399'; ctx.beginPath(); ctx.arc(wx, wy, 11, 0, 7); ctx.stroke();
  }
  drawCornerArrow(ctx, 46, 46, S.windDir + 180, '#33c2ff', 'Vent ' + Math.round(S.windSpdInst) + ' nds');
  const cur = S._cur || currentAt(S.x, S.y);
  if (cur.spd > 0.05) drawCornerArrow(ctx, w - 46, 46, cur.dir, '#7c5cff', 'Courant ' + cur.spd.toFixed(1) + ' nds');
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(S.heading * DEG);
  ctx.fillStyle = S.aground ? '#f87171' : '#ffd166';
  ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(7, 10); ctx.lineTo(0, 6); ctx.lineTo(-7, 10); ctx.closePath(); ctx.fill();
  ctx.restore();
  // digues du port (tracé visible)
  ctx.strokeStyle = '#5a6470'; ctx.lineCap = 'round';
  for (const bw of BREAKWATERS) {
    const [a0, a1] = toScreen(bw.ax, bw.ay), [b0, b1] = toScreen(bw.bx, bw.by);
    ctx.lineWidth = Math.max(2, bw.w * sc * 2); ctx.beginPath(); ctx.moveTo(a0, a1); ctx.lineTo(b0, b1); ctx.stroke();
  }
  ctx.lineCap = 'butt';

  // phare(s) des Medes
  for (const is of ISLANDS) if (is.light) {
    const [lx, ly] = toScreen(is.x, is.y);
    if (lx > 0 && lx < w && ly > 0 && ly < h) {
      const on = Math.sin(S.t * 2) > 0.4;       // éclat périodique
      ctx.fillStyle = on ? '#fff4b0' : '#7a7340';
      ctx.beginPath(); ctx.arc(lx, ly, on ? 5 : 3, 0, 7); ctx.fill();
    }
  }

  // toponymes
  const place = (wx, wy, txt, col) => {
    const [px, py] = toScreen(wx, wy);
    if (px < -30 || px > w + 30 || py < 0 || py > h) return;
    ctx.fillStyle = col; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(txt, px, py);
  };
  const [hx, hy] = toScreen(0, 0);
  if (hx > -20 && hx < w + 20 && hy > -20 && hy < h + 20) {
    ctx.fillStyle = '#ffd166'; ctx.fillRect(hx - 3, hy - 3, 6, 6);
  }
  place(-150, -20, "L'Estartit", '#f0e6c0');
  place(1654, -1256, 'Meda Gran ⌖', '#e6f0c0');
  place(1560, -980, 'Illes Medes', '#e6f0c0');
  place(760, 820, 'Cap de la Barra', '#e6f0c0');
  place(900, 1700, 'Roca Foradada', '#e6f0c0');
  place(-380, 1100, 'Massif du Montgrí', '#cfe0b0');
  place(-280, -2200, 'Platja de Pals', '#f0e6c0');
  place(-460, -3900, 'Gola del Ter', '#cfe0b0');

  ctx.fillStyle = '#8fb0c6'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.fillText('1 carreau = 1 NM · ' + REGION.name, 8, h - 10);
}
function drawCornerArrow(ctx, x, y, dirTo, color, label) {
  ctx.save(); ctx.translate(x, y);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
  const a = dirTo * DEG, L = 22, ex = L * Math.sin(a), ey = -L * Math.cos(a);
  ctx.beginPath(); ctx.moveTo(-ex, -ey); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.save(); ctx.translate(ex, ey); ctx.rotate(a);
  ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5, 6); ctx.lineTo(-5, 6); ctx.closePath(); ctx.fill(); ctx.restore();
  ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(label, 0, 34); ctx.restore();
}

/* ---------- Libellés ---------- */
function pointOfSail(twa) {
  const a = Math.abs(norm180(twa));
  if (a < BOAT.noGo) return 'Vent debout (no-go)';
  if (a < 50) return 'Près serré';
  if (a < 70) return 'Près';
  if (a < 100) return 'Bon plein / travers';
  if (a < 140) return 'Largue';
  if (a < 170) return 'Grand largue';
  return 'Vent arrière';
}
const seaLabel = ['miroir', 'ridée', 'belle', 'peu agitée', 'agitée', 'forte', 'très forte', 'grosse', 'très grosse', 'énorme'];
const gustLabel = g => g < 15 ? 'régulier' : g < 40 ? 'moyenne' : g < 70 ? 'forte' : 'très rafaleux';
function tidePhaseLabel(p) {
  if (p < 0.05 || p > 0.95) return 'basse mer (étale)';
  if (p < 0.45) return 'montante';
  if (p < 0.55) return 'pleine mer (étale)';
  return 'descendante';
}
const fmtHM = sec => { const t = Math.floor(sec) % 86400; return String(Math.floor(t / 3600)).padStart(2, '0') + ':' + String(Math.floor(t / 60) % 60).padStart(2, '0'); };

/* ---------- Afficheurs ---------- */
function updateReadouts() {
  const aw = S._aw || apparentWind();
  const wpDist = S.waypoint ? Math.hypot(S.waypoint.x - S.x, S.waypoint.y - S.y) : 0;
  const bearing = S.waypoint ? norm360(Math.atan2(S.waypoint.x - S.x, S.waypoint.y - S.y) / DEG) : 0;
  const vmg = S.waypoint ? (S._sog || 0) * Math.cos(norm180(bearing - (S._cog || S.heading)) * DEG) : 0;

  $('roStw').textContent = S.stw.toFixed(1) + ' nds';
  $('roSog').textContent = (S._sog || 0).toFixed(1) + ' nds';
  $('roCog').textContent = Math.round(S._cog || S.heading).toString().padStart(3, '0') + '°';
  $('roTw').textContent = Math.round(S.windSpdInst) + ' nds / ' + Math.round(S.windDir).toString().padStart(3, '0') + '°';
  $('roAw').textContent = Math.round(aw.aws) + ' nds / ' + Math.round(Math.abs(aw.awa)) + '° ' + (aw.awa >= 0 ? 'Tbd' : 'Bbd');
  $('roPoint').textContent = (S.luffing ? '⚠ ' : '') + pointOfSail(aw.twa) + ' · ' + (aw.twa >= 0 ? 'tribord' : 'bâbord') + ' amures';
  $('roHeel').textContent = Math.round(S.heel) + '°';
  $('roVmg').textContent = vmg.toFixed(1) + ' nds';
  $('roDepth').textContent = (S._depth || 0).toFixed(1) + ' m';
  $('roTide').textContent = tideHeight().toFixed(2) + ' m · ' + tidePhaseLabel(S.tidePhase);
  const cur = S._cur || currentAt(S.x, S.y);
  $('roCurrent').textContent = cur.spd.toFixed(1) + ' nds / ' + Math.round(cur.dir).toString().padStart(3, '0') + '°';
  $('roWpt').textContent = (wpDist / 1852).toFixed(2) + ' NM @ ' + Math.round(bearing).toString().padStart(3, '0') + '°';
  $('clock').textContent = fmtHM(S.t);

  $('cockpitHud').innerHTML =
    'Vitesse <b>' + S.stw.toFixed(1) + '</b> nds · Gîte <b>' + Math.round(S.heel) +
    '°</b> · ' + pointOfSail(aw.twa) + ' · Sonde <b>' + (S._depth || 0).toFixed(1) + '</b> m';

  const banner = $('alarmBanner');
  let msg = '';
  if (S.aground) msg = '⚠ ÉCHOUEMENT — fond insuffisant !';
  else if ((S._depth || 99) < BOAT.draft + 1.5) msg = '⚠ Petits fonds — sonde ' + (S._depth).toFixed(1) + ' m';
  else if (S.heel > 35) msg = '⚠ Gîte excessive — prends un ris !';
  if (msg) { banner.textContent = msg; banner.classList.remove('hidden'); } else banner.classList.add('hidden');
}

/* =====================================================================
   SON & VOIX
   ===================================================================== */
const Sound = {
  on: false, ctx: null, windGain: null, windFilt: null, waveGain: null, ready: false,
  enable() {
    if (this.ready) { this.on = !this.on; this._apply(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      const noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      // Vent : bruit -> passe-bande -> gain
      const ws = this.ctx.createBufferSource(); ws.buffer = noise; ws.loop = true;
      this.windFilt = this.ctx.createBiquadFilter(); this.windFilt.type = 'bandpass'; this.windFilt.frequency.value = 500; this.windFilt.Q.value = 0.7;
      this.windGain = this.ctx.createGain(); this.windGain.gain.value = 0;
      ws.connect(this.windFilt).connect(this.windGain).connect(this.ctx.destination); ws.start();
      // Vagues : bruit -> passe-bas -> gain
      const vs = this.ctx.createBufferSource(); vs.buffer = noise; vs.loop = true;
      const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
      this.waveGain = this.ctx.createGain(); this.waveGain.gain.value = 0;
      vs.connect(lp).connect(this.waveGain).connect(this.ctx.destination); vs.start();
      this.ready = true; this.on = true; this._apply();
      speak('Son activé. Bonne navigation !');
    } catch (e) { this.on = false; }
  },
  _apply() {
    $('soundBtn').textContent = this.on ? '🔊 Son' : '🔇 Son';
    $('soundBtn').classList.toggle('active', this.on);
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    if (!this.on && this.windGain) { this.windGain.gain.value = 0; this.waveGain.gain.value = 0; }
  },
  update(aws, Hs, depth) {
    if (!this.on || !this.ready) return;
    const wob = 1 + 0.25 * Math.sin(S.t * 0.9);
    this.windGain.gain.value = clamp(aws / 55, 0, 0.5) * wob;
    this.windFilt.frequency.value = 300 + aws * 22;
    this.waveGain.gain.value = clamp(Hs / 12, 0, 0.4) * (1 + 0.4 * Math.sin(S.t * 1.1));
  },
};
let _voices = null;
function speak(text) {
  if (!Sound.on || typeof speechSynthesis === 'undefined') return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR'; u.rate = 1.02;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch (e) { /* ignore */ }
}
const _ann = {};
function announce(key, text, cd = 8) {
  if (_ann[key] && S.t - _ann[key] < cd) return;
  _ann[key] = S.t; speak(text);
}

/* =====================================================================
   LEÇONS GUIDÉES
   ===================================================================== */
const LESSONS = [
  {
    title: 'Le près', hold: 4,
    instr: "Lofe (remonte vers le vent) jusqu'à naviguer au près : angle au vent réel entre 40° et 55°. Tiens-le 4 s.",
    check: c => c.atwa >= 40 && c.atwa <= 55 && c.stw > 1,
    success: 'Parfait, tu es au près !',
  },
  {
    title: 'Le travers', hold: 4,
    instr: "Abats (éloigne-toi du vent) jusqu'au travers : angle au vent réel entre 80° et 100°. C'est l'allure la plus rapide.",
    check: c => c.atwa >= 80 && c.atwa <= 100 && c.stw > 1,
    success: 'Au travers, pleine vitesse !',
  },
  {
    title: 'Le largue', hold: 4,
    instr: 'Continue d\'abattre jusqu\'au largue : angle au vent réel entre 120° et 150°.',
    check: c => c.atwa >= 120 && c.atwa <= 150,
    success: 'Bien, tu es au largue.',
  },
  {
    title: 'Virer de bord', hold: 0.2,
    instr: "Reviens au près puis VIRE DE BORD (bouton « Virer de bord » ou passe l'étrave dans le vent) pour changer d'amure.",
    start: c => { LESSONS[3]._side = c.side; },
    check: c => c.side !== LESSONS[3]._side && c.atwa <= 70 && c.stw > 0.5,
    success: 'Virement réussi, tu as changé d\'amure !',
  },
  {
    title: 'Prendre un ris', hold: 0.2,
    instr: 'Le vent forcit : réduis la toile en prenant au moins 1 ris (curseur « Ris ») pour limiter la gîte.',
    check: c => c.reef >= 1,
    success: 'Bien arisé, le bateau est plus sain.',
  },
  {
    title: 'Empanner', hold: 0.2,
    instr: "Mets-toi aux allures portantes (largue) puis EMPANNE (bouton « Empanner ») pour passer le vent arrière d'un bord à l'autre.",
    start: c => { LESSONS[5]._side = c.side; },
    check: c => c.side !== LESSONS[5]._side && c.atwa >= 110,
    success: 'Empannage contrôlé, bravo !',
  },
  {
    title: 'Rejoindre le waypoint', hold: 0.2,
    instr: 'Dernière étape : barre jusqu\'au waypoint vert (pense au pilote auto). Approche à moins de 50 m.',
    check: c => c.wpDist < 50,
    success: 'Waypoint atteint ! Tu maîtrises les bases. 🎉',
  },
];
const Tut = { active: false, i: 0, hold: 0 };
function tutStart() {
  Tut.active = true; Tut.i = 0; Tut.hold = 0;
  $('lessonStart').classList.add('hidden'); $('lessonNav').classList.remove('hidden');
  enterLesson();
}
function tutQuit() {
  Tut.active = false;
  $('lessonStart').classList.remove('hidden'); $('lessonNav').classList.add('hidden');
  $('lessonFill').style.width = '0%'; $('lessonStatus').textContent = '';
  $('lessonCount').textContent = 'Leçon —/—'; $('lessonTitle').textContent = 'Parcours terminé ou interrompu';
  $('lessonInstr').textContent = 'Relance quand tu veux pour réviser une allure ou une manœuvre.';
}
function lessonCtx() {
  const aw = S._aw || apparentWind();
  return {
    atwa: Math.abs(aw.twa), side: Math.sign(aw.twa) || 1, stw: S.stw, reef: S.reef,
    wpDist: S.waypoint ? Math.hypot(S.waypoint.x - S.x, S.waypoint.y - S.y) : 1e9,
  };
}
function enterLesson() {
  Tut.hold = 0;
  const L = LESSONS[Tut.i]; if (!L) { tutDone(); return; }
  if (L.start) L.start(lessonCtx());
  $('lessonCount').textContent = 'Leçon ' + (Tut.i + 1) + '/' + LESSONS.length;
  $('lessonTitle').textContent = L.title;
  $('lessonInstr').textContent = L.instr;
  $('lessonFill').style.width = '0%';
  $('lessonStatus').textContent = '';
  speak(L.instr);
}
function updateTutorial(dt) {
  if (!Tut.active) return;
  const L = LESSONS[Tut.i]; if (!L) return;
  const ok = L.check(lessonCtx());
  Tut.hold = ok ? Tut.hold + dt : 0;
  $('lessonFill').style.width = clamp(Tut.hold / L.hold * 100, 0, 100) + '%';
  if (Tut.hold >= L.hold) {
    $('lessonStatus').textContent = '✅ ' + L.success;
    speak(L.success);
    Tut.i++; Tut.active = Tut.i < LESSONS.length;
    if (Tut.active) setTimeout(enterLesson, 1400); else setTimeout(tutDone, 1400);
  }
}
function tutDone() {
  $('lessonStart').classList.remove('hidden'); $('lessonNav').classList.add('hidden');
  $('lessonCount').textContent = 'Terminé';
  $('lessonTitle').textContent = 'Parcours complet 🎉';
  $('lessonInstr').textContent = 'Tu as vu les allures, le virement, l\'empannage, la prise de ris et la navigation au waypoint. Relance pour réviser.';
  $('lessonFill').style.width = '100%';
  Tut.active = false;
}

/* =====================================================================
   BOUCLE PRINCIPALE
   ===================================================================== */
let last = performance.now();
const compassCtx = $('cCompass').getContext('2d');
const windCtx = $('cWind').getContext('2d');
const chartCtx = $('cChart').getContext('2d');
const cockpitCtx = $('cCockpit').getContext('2d');

function loop(now) {
  const real = Math.min(0.05, (now - last) / 1000); last = now;
  if (S.running) {
    let remaining = real * S.timeScale; const maxStep = 0.1;
    while (remaining > 0) { const d = Math.min(maxStep, remaining); step(d); remaining -= d; }
  }
  drawCockpit(cockpitCtx);
  drawCompass(compassCtx);
  drawWind(windCtx);
  drawChart(chartCtx);
  updateReadouts();
  requestAnimationFrame(loop);
}

/* =====================================================================
   UI
   ===================================================================== */
function bindRange(id, out, fn) {
  const el = $(id);
  const render = () => { if (out) $(out).textContent = fn ? fn(parseFloat(el.value)) : el.value; };
  el.addEventListener('input', () => { applyControl(id, parseFloat(el.value)); render(); });
  render();
}
function applyControl(id, v) {
  switch (id) {
    case 'windDir': S.windDir = v; break;
    case 'windSpd': S.windSpd = v; break;
    case 'gust': S.gust = v; break;
    case 'sea': S.sea = v; break;
    case 'tideRange': S.tideRange = v; break;
    case 'tidePhase': S.tidePhase = v / 100; break;
    case 'curMax': S.curMax = v; break;
    case 'rudder': S.rudderCmd = v; S.autohelm = false; $('autohelm').checked = false; break;
    case 'reef': S.reef = v; break;
    case 'mainTrim': S.mainTrim = v / 100; break;
    case 'jibTrim': S.jibTrim = v / 100; break;
  }
}
bindRange('windDir', 'oWindDir', v => Math.round(v) + '°');
bindRange('windSpd', 'oWindSpd', v => Math.round(v) + ' nds');
bindRange('gust', 'oGust', gustLabel);
bindRange('sea', 'oSea', v => v + ' — ' + seaLabel[v]);
bindRange('tideRange', 'oTideRange', v => v.toFixed(1) + ' m');
bindRange('tidePhase', 'oTidePhase', v => tidePhaseLabel(v / 100));
bindRange('curMax', 'oCurMax', v => v.toFixed(1) + ' nds');
bindRange('rudder', 'oRudder', v => (v > 0 ? '+' : '') + v + '°');
bindRange('reef', 'oReef', v => v + ' ris');
bindRange('mainTrim', 'oMain', v => S.autoTrim ? 'auto' : Math.round(v) + '%');
bindRange('jibTrim', 'oJib', v => S.autoTrim ? 'auto' : Math.round(v) + '%');

$('rudderCenter').onclick = () => { S.rudderCmd = 0; $('rudder').value = 0; $('oRudder').textContent = '0°'; };
$('autohelm').onchange = e => { S.autohelm = e.target.checked; if (S.autohelm) S.autohelmHeading = S.heading; };
$('mainUp').onchange = e => S.mainUp = e.target.checked;
$('jibUp').onchange = e => S.jibUp = e.target.checked;
$('autoTrim').onchange = e => {
  S.autoTrim = e.target.checked;
  $('mainTrim').disabled = S.autoTrim; $('jibTrim').disabled = S.autoTrim;
  $('oMain').textContent = S.autoTrim ? 'auto' : Math.round(S.mainTrim * 100) + '%';
  $('oJib').textContent = S.autoTrim ? 'auto' : Math.round(S.jibTrim * 100) + '%';
  $('trimHint').textContent = S.autoTrim
    ? 'Réglage automatique actif — décoche « Réglage auto » pour border/choquer toi-même.'
    : 'Réglage manuel : borde au près, choque aux allures portantes. Si ça faseye, borde ; si ça gîte trop, prends un ris.';
};
$('tackBtn').onclick = () => { S.maneuver = { target: norm360(2 * S.windDir - S.heading), type: 'tack' }; };
$('gybeBtn').onclick = () => { S.maneuver = { target: norm360(2 * S.windDir - S.heading), type: 'gybe' }; };

$('timeSeg').addEventListener('click', e => {
  if (e.target.tagName !== 'BUTTON') return;
  [...$('timeSeg').children].forEach(b => b.classList.remove('active'));
  e.target.classList.add('active'); S.timeScale = parseFloat(e.target.dataset.t);
});
$('pauseBtn').onclick = () => { S.running = !S.running; $('pauseBtn').textContent = S.running ? '⏸ Pause' : '▶ Reprendre'; };
$('soundBtn').onclick = () => Sound.enable();

// Plein écran
$('fsBtn').onclick = () => {
  const el = document.documentElement;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fsEl) (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
  else (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
};
function onFsChange() {
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
  $('fsBtn').textContent = on ? '⛶ Quitter' : '⛶ Plein écran';
  $('fsBtn').classList.toggle('active', on);
}
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);

$('weatherSeg').addEventListener('click', e => {
  if (e.target.tagName !== 'BUTTON') return;
  [...$('weatherSeg').children].forEach(b => b.classList.remove('active'));
  e.target.classList.add('active'); applyWeather(e.target.dataset.w);
});
function applyWeather(w) {
  S.weather = w;
  const map = { sun: { gust: 15 }, clouds: { gust: 25 }, rain: { gust: 40 }, fog: { gust: 8, windCap: 8 }, storm: { gust: 85 } }[w];
  if (map.gust != null) { S.gust = map.gust; $('gust').value = map.gust; $('oGust').textContent = gustLabel(map.gust); }
  if (map.windCap != null && S.windSpd > map.windCap) {
    S.windSpd = map.windCap; $('windSpd').value = map.windCap; $('oWindSpd').textContent = map.windCap + ' nds';
  }
}
const PRESETS = {
  calm:    { windSpd: 4,  gust: 10, sea: 1, weather: 'sun',    tideRange: 2, curMax: 0.5 },
  thermal: { windSpd: 11, gust: 20, sea: 2, weather: 'sun',    tideRange: 3, curMax: 1.0 },
  breeze:  { windSpd: 16, gust: 25, sea: 3, weather: 'clouds', tideRange: 4, curMax: 1.5 },
  gale:    { windSpd: 32, gust: 70, sea: 6, weather: 'rain',   tideRange: 6, curMax: 3.0 },
  fog:     { windSpd: 6,  gust: 8,  sea: 1, weather: 'fog',    tideRange: 3, curMax: 1.2 },
  storm:   { windSpd: 28, gust: 90, sea: 5, weather: 'storm',  tideRange: 5, curMax: 2.5 },
};
document.querySelectorAll('.preset').forEach(btn => {
  btn.onclick = () => {
    const p = PRESETS[btn.dataset.preset];
    S.windSpd = p.windSpd; $('windSpd').value = p.windSpd; $('oWindSpd').textContent = p.windSpd + ' nds';
    S.gust = p.gust; $('gust').value = p.gust; $('oGust').textContent = gustLabel(p.gust);
    S.sea = p.sea; $('sea').value = p.sea; $('oSea').textContent = p.sea + ' — ' + seaLabel[p.sea];
    S.tideRange = p.tideRange; $('tideRange').value = p.tideRange; $('oTideRange').textContent = p.tideRange.toFixed(1) + ' m';
    S.curMax = p.curMax; $('curMax').value = p.curMax; $('oCurMax').textContent = p.curMax.toFixed(1) + ' nds';
    [...$('weatherSeg').children].forEach(b => b.classList.toggle('active', b.dataset.w === p.weather));
    applyWeather(p.weather);
    const sugg = p.windSpd > 25 ? 2 : p.windSpd > 18 ? 1 : 0;
    S.reef = sugg; $('reef').value = sugg; $('oReef').textContent = sugg + ' ris';
  };
});
/* ---------- Météo marine aléatoire & évolutive ---------- */
function setCtl(id, v) { const el = $(id); el.value = v; el.dispatchEvent(new Event('input')); }
function selectWeather(w) {
  S.weather = w;
  [...$('weatherSeg').children].forEach(b => b.classList.toggle('active', b.dataset.w === w));
}
function applyEnv(env) {
  if (env.windDir != null) setCtl('windDir', Math.round(env.windDir));
  if (env.windSpd != null) setCtl('windSpd', Math.round(env.windSpd));
  if (env.gust != null) setCtl('gust', Math.round(env.gust));
  if (env.sea != null) setCtl('sea', env.sea);
  if (env.tideRange != null) setCtl('tideRange', env.tideRange);
  if (env.curMax != null) setCtl('curMax', env.curMax);
  if (env.weather) selectWeather(env.weather);
  if (env.reef != null) setCtl('reef', env.reef);
}
const randInt = (a, b) => Math.round(a + Math.random() * (b - a));
// Régimes de vent typiques de la Costa Brava / golfe du Lion
const WX_ARCH = [
  { key: 'tramuntana', w: 'sun',    name: 'Tramuntana (NNO)',       wt: 5, dir: [300, 345], spd: [18, 36], gust: [55, 90], sea: [3, 6] },
  { key: 'garbi',      w: 'sun',    name: 'Garbí / marinada (SO)',  wt: 5, dir: [190, 230], spd: [8, 16],  gust: [15, 30], sea: [2, 3] },
  { key: 'llevant',    w: 'rain',   name: 'Llevant (E) — houle',    wt: 3, dir: [60, 100],  spd: [12, 26], gust: [25, 45], sea: [4, 6] },
  { key: 'migjorn',    w: 'clouds', name: 'Migjorn (S)',            wt: 2, dir: [160, 200], spd: [10, 20], gust: [20, 40], sea: [3, 4] },
  { key: 'xaloc',      w: 'clouds', name: 'Xaloc (SE)',             wt: 2, dir: [120, 150], spd: [10, 22], gust: [20, 40], sea: [3, 5] },
  { key: 'calma',      w: 'sun',    name: 'Calme anticyclonique',   wt: 3, dir: [0, 359],   spd: [2, 7],   gust: [5, 15],  sea: [0, 1] },
  { key: 'grain',      w: 'storm',  name: 'Grain orageux',          wt: 2, dir: [0, 359],   spd: [18, 32], gust: [70, 100], sea: [3, 5] },
  { key: 'boira',      w: 'fog',    name: 'Boira / brouillard',     wt: 1, dir: [0, 359],   spd: [3, 8],   gust: [5, 12],  sea: [0, 2] },
];
function pickArch() {
  const pool = []; WX_ARCH.forEach(a => { for (let i = 0; i < a.wt; i++) pool.push(a); });
  return pool[Math.floor(Math.random() * pool.length)];
}
function randomScenario() {
  const a = pickArch();
  const dir = (a.dir[0] === 0 && a.dir[1] === 359) ? randInt(0, 359) : randInt(a.dir[0], a.dir[1]);
  const spd = randInt(a.spd[0], a.spd[1]);
  return {
    windDir: dir, windSpd: spd, gust: randInt(a.gust[0], a.gust[1]), sea: randInt(a.sea[0], a.sea[1]),
    weather: a.w, name: a.name, key: a.key,
    reef: spd > 25 ? 2 : spd > 18 ? 1 : 0,
    tideRange: [0, 0.5, 1][randInt(0, 2)],
    curMax: +(0.2 + Math.random() * 0.6).toFixed(1),
  };
}
const Weather = {
  evolving: false, target: null, nextChange: 0, syncT: 0,
  start() { this.evolving = true; this.pickTarget(); },
  pickTarget() {
    const env = randomScenario();
    this.target = { windDir: env.windDir, windSpd: env.windSpd, gust: env.gust, sea: env.sea, weather: env.weather };
    this.nextChange = S.t + randInt(120, 300);
    $('randomInfo').textContent = '⛅ Tendance : ' + env.name + ' (~' + env.windSpd + ' nds, mer ' + env.sea + ')';
    announce('wxshift', 'La météo évolue vers ' + env.name + '.', 25);
  },
  tick(dt) {
    if (!this.evolving) return;
    if (S.t >= this.nextChange) this.pickTarget();
    const t = this.target; if (!t) return;
    const k = clamp(dt * 0.05, 0, 1);
    S.windDir = norm360(S.windDir + norm180(t.windDir - S.windDir) * k);
    S.windSpd += (t.windSpd - S.windSpd) * k;
    S.gust += (t.gust - S.gust) * k;
    const seaT = clamp(Math.round(S.windSpd / 6), 0, 9);
    if (Math.random() < dt * 0.05 && S.sea !== seaT) S.sea = clamp(S.sea + Math.sign(seaT - S.sea), 0, 9);
    if (t.weather !== S.weather && Math.abs(norm180(t.windDir - S.windDir)) < 12) selectWeather(t.weather);
    this.syncT += dt;
    if (this.syncT > 0.6) {
      this.syncT = 0;
      setCtl('windDir', Math.round(S.windDir)); setCtl('windSpd', Math.round(S.windSpd));
      setCtl('gust', Math.round(S.gust)); setCtl('sea', S.sea);
    }
  },
};
$('randomBtn').onclick = () => {
  const env = randomScenario();
  applyEnv(env);
  $('randomInfo').textContent = '🎲 ' + env.name + ' — vent ' + env.windDir + '°, ' + env.windSpd +
    ' nds, mer ' + env.sea + '.' + (env.reef ? ' Conseil : ' + env.reef + ' ris.' : '');
  announce('wxset', 'Nouveau scénario : ' + env.name + '.', 2);
};
$('evolveChk').onchange = e => {
  Weather.evolving = e.target.checked;
  if (Weather.evolving) { Weather.start(); }
  else $('randomInfo').textContent = 'Météo évolutive désactivée.';
};

$('resetBtn').onclick = () => {
  S.x = START.x; S.y = START.y; S.heading = START.heading; S.autohelmHeading = START.heading;
  S.stw = 0; S.heel = 0; S.trail = []; S.aground = false; S.rudder = 0; S.rudderCmd = 0;
  $('rudder').value = 0; $('oRudder').textContent = '0°';
};

$('zoomIn').onclick = () => S.chartScale = clamp(S.chartScale * 1.4, 0.01, 0.4);
$('zoomOut').onclick = () => S.chartScale = clamp(S.chartScale / 1.4, 0.01, 0.4);
$('setWptBtn').onclick = () => { S.placingWpt = true; $('setWptBtn').classList.add('active'); };
$('cChart').addEventListener('click', e => {
  if (!S.placingWpt) return;
  const r = e.target.getBoundingClientRect();
  const px = (e.clientX - r.left) * (e.target.width / r.width);
  const py = (e.clientY - r.top) * (e.target.height / r.height);
  S.waypoint = { x: S.x + (px - e.target.width / 2) / S.chartScale, y: S.y - (py - e.target.height / 2) / S.chartScale };
  S.placingWpt = false; $('setWptBtn').classList.remove('active');
});

// Leçons
$('lessonStart').onclick = tutStart;
$('lessonQuit').onclick = tutQuit;
$('lessonSkip').onclick = () => { Tut.i++; if (Tut.i >= LESSONS.length) tutDone(); else enterLesson(); };
$('lessonPrev').onclick = () => { Tut.i = Math.max(0, Tut.i - 1); enterLesson(); };

// Clavier
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') { S.rudderCmd = clamp(S.rudderCmd - 5, -35, 35); S.autohelm = false; $('autohelm').checked = false; }
  if (e.key === 'ArrowRight') { S.rudderCmd = clamp(S.rudderCmd + 5, -35, 35); S.autohelm = false; $('autohelm').checked = false; }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') S.rudderCmd = 0;
  if (e.code === 'Space') { e.preventDefault(); $('pauseBtn').click(); }
  $('rudder').value = S.rudderCmd; $('oRudder').textContent = (S.rudderCmd > 0 ? '+' : '') + S.rudderCmd + '°';
});

// Onglets mobile
const mq = matchMedia('(max-width:820px)');
let currentTab = 'cockpit';
function showTab(id) {
  currentTab = id;
  [...$('tabbar').children].forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('tab-active', p.dataset.tab === id));
}
function applyTabs() {
  if (mq.matches) { document.body.classList.add('mobile'); showTab(currentTab); }
  else document.body.classList.remove('mobile');
}
$('tabbar').addEventListener('click', e => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });
mq.addEventListener ? mq.addEventListener('change', applyTabs) : mq.addListener(applyTabs);
applyTabs();

requestAnimationFrame(loop);
