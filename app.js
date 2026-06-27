/* =====================================================================
   Simulateur de voile — Croiseur 11 m (sloop GV + génois)
   Modèle pédagogique simplifié : allures, vent réel/apparent, gîte,
   réglage des voiles + ris, virement/empannage, marée + courant,
   météo, sonde / échouement. App web autonome, sans dépendance.
   ===================================================================== */

'use strict';

/* ---------------------------------------------------------------------
   Constantes bateau de référence (~11 m)
   --------------------------------------------------------------------- */
const BOAT = {
  loa: 11.0,          // longueur hors-tout (m)
  lwl: 9.6,           // longueur à la flottaison (m)
  draft: 1.95,        // tirant d'eau (m)
  hullSpeed: 7.5,     // vitesse de coque (nds) ≈ 1.34*sqrt(lwl_ft)
  noGo: 32,           // demi-angle du près serré (° par rapport au vent)
  turnRateMax: 22,    // °/s de rotation à pleine barre et vitesse normale
  leewayMax: 6,       // dérive max au près (°)
};

/* Polaire simplifiée : rendement (0..1) selon l'angle au vent réel (TWA).
   Interpolation linéaire sur la table ci-dessous. */
const POLAR = [
  [0, 0.00], [25, 0.00], [32, 0.10], [40, 0.45], [50, 0.72],
  [60, 0.85], [75, 0.95], [90, 1.00], [110, 1.00], [130, 0.92],
  [150, 0.80], [165, 0.66], [180, 0.58],
];

/* ---------------------------------------------------------------------
   Helpers angulaires & conversions
   --------------------------------------------------------------------- */
const DEG = Math.PI / 180;
const KN_TO_MS = 0.514444;           // nœuds -> m/s
const norm360 = a => ((a % 360) + 360) % 360;
const norm180 = a => { a = norm360(a); return a > 180 ? a - 360 : a; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

function polarEff(twa) {
  twa = Math.abs(norm180(twa));
  for (let i = 0; i < POLAR.length - 1; i++) {
    const [a0, e0] = POLAR[i], [a1, e1] = POLAR[i + 1];
    if (twa >= a0 && twa <= a1) return lerp(e0, e1, (twa - a0) / (a1 - a0));
  }
  return POLAR[POLAR.length - 1][1];
}

/* ---------------------------------------------------------------------
   État de la simulation
   --------------------------------------------------------------------- */
const S = {
  running: true,
  timeScale: 1,
  t: 6 * 3600,        // horloge de bord en secondes (06:00)

  // Environnement
  windDir: 270,       // direction d'où vient le vent (° compas)
  windSpd: 12,        // vent réel moyen (nds)
  windSpdInst: 12,    // vent instantané (avec rafales)
  gust: 25,           // 0..100 variabilité
  sea: 3,             // état de la mer Douglas 0..9
  weather: 'sun',
  tideRange: 3.0,     // amplitude (m)
  tidePhase: 0.25,    // 0=BM, 0.5=PM, 1=BM (fraction du cycle)
  curMax: 1.5,        // courant max de marée (nds)

  // Bateau
  heading: 45,        // cap compas (°)
  rudder: 0,          // -35..35 (° barre)
  stw: 0,             // vitesse surface (nds)
  heel: 0,            // gîte (°)
  leeway: 0,          // dérive (°)
  mainUp: true,
  jibUp: true,
  reef: 0,            // 0..3
  autoTrim: true,
  mainTrim: 0.6,      // 0 choqué .. 1 bordé
  jibTrim: 0.6,
  luffing: false,

  // Position (mètres, repère monde : +x est, +y nord)
  x: 0, y: 0,
  trail: [],
  waypoint: { x: 0, y: 1852 * 2 }, // 2 NM au nord par défaut

  // Pilote / manœuvres
  autohelm: false,
  autohelmHeading: 45,
  maneuver: null,     // {target, type}

  // Carte
  chartScale: 0.06,   // pixels par mètre
  placingWpt: false,

  // Alarmes
  aground: false,
};

/* ---------------------------------------------------------------------
   Modèle de fond (sonde) — bathymétrie douce + un haut-fond
   --------------------------------------------------------------------- */
function seabedDepth(x, y) {
  // profondeur "à zéro des cartes" avant marée
  const base = 14
    + 7 * Math.sin(x / 900) * Math.cos(y / 1100)
    + 4 * Math.sin((x + y) / 1700);
  // un haut-fond marqué autour de (600, 1200)
  const dx = x - 600, dy = y - 1200;
  const shoal = 12 * Math.exp(-(dx * dx + dy * dy) / (2 * 480 * 480));
  return base - shoal;
}
function tideHeight() {
  // hauteur d'eau ajoutée par la marée (sinusoïde autour de la mi-amplitude)
  return (S.tideRange / 2) * (1 - Math.cos(2 * Math.PI * S.tidePhase));
}
function tideCurrent() {
  // courant max à mi-marée, étale à PM/BM. Flot vers 045°, jusant vers 225°.
  const spd = S.curMax * Math.sin(2 * Math.PI * S.tidePhase);
  const dir = spd >= 0 ? 45 : 225;        // direction VERS laquelle va le courant
  return { spd: Math.abs(spd), dir };
}

/* ---------------------------------------------------------------------
   Vent apparent (depuis vent réel + vitesse bateau)
   Repère bateau : x = avant (étrave), y = tribord.
   --------------------------------------------------------------------- */
function apparentWind() {
  const rel = norm180(S.windDir - S.heading);     // d'où vient le vent / étrave
  const Vt = S.windSpdInst;
  // composantes du vent ressenti (vent réel - vitesse bateau)
  const awFwd = -Vt * Math.cos(rel * DEG) - S.stw;
  const awStb = -Vt * Math.sin(rel * DEG);
  const aws = Math.hypot(awFwd, awStb);
  const awa = Math.atan2(-awStb, -awFwd) / DEG;   // angle d'où vient le VA / étrave
  return { rel, twa: rel, aws, awa };
}

/* ---------------------------------------------------------------------
   Surface de toile effective (selon voiles hissées + ris)
   --------------------------------------------------------------------- */
function sailFactor() {
  let f = 0;
  if (S.mainUp) f += 0.55 * (1 - S.reef * 0.27);  // GV ~55% de la puissance
  if (S.jibUp) f += 0.45;                          // génois ~45%
  return clamp(f, 0, 1);
}

/* trim optimal (0 choqué .. 1 bordé) en fonction de l'angle au vent */
function optimalTrim(twa) {
  twa = Math.abs(norm180(twa));
  return clamp((150 - twa) / (150 - 40), 0, 1);
}

/* ---------------------------------------------------------------------
   Pas de simulation
   --------------------------------------------------------------------- */
function step(dt) {
  // --- Rafales : vent instantané oscille autour de la moyenne ---
  const gAmp = (S.gust / 100) * (0.35 * S.windSpd + 1);
  const gust = gAmp * (0.6 * Math.sin(S.t * 0.07) + 0.4 * Math.sin(S.t * 0.23 + 1.3));
  S.windSpdInst = Math.max(0, S.windSpd + gust);

  const aw = apparentWind();
  const twa = aw.twa;
  const absTwa = Math.abs(twa);

  // --- Réglage des voiles ---
  const opt = optimalTrim(twa);
  if (S.autoTrim) { S.mainTrim = opt; S.jibTrim = opt; }
  const trim = (S.mainTrim + S.jibTrim) / 2;
  const trimErr = Math.abs(trim - opt);
  const trimEff = clamp(1 - 0.7 * trimErr, 0.15, 1);

  // --- Dévent / faseyement dans le no-go ---
  S.luffing = absTwa < BOAT.noGo && sailFactor() > 0;

  // --- Vitesse cible via la polaire ---
  const power = clamp(S.windSpdInst / 14, 0, 1.05);     // montée en puissance
  let target = BOAT.hullSpeed * polarEff(twa) * power * sailFactor() * trimEff;

  // gîte excessive = perte de portance (croiseur surtoilé, pas assez arisé)
  if (S.heel > 28) target *= clamp(1 - (S.heel - 28) / 45, 0.3, 1);
  if (S.luffing) target *= 0.05;
  if (S.aground) target = 0;

  // --- Inertie : on tend vers la vitesse cible ---
  const accel = target > S.stw ? 0.35 : 0.6;            // freine plus vite qu'il n'accélère
  S.stw += (target - S.stw) * clamp(accel * dt, 0, 1);
  S.stw = Math.max(0, S.stw);

  // --- Gîte (depuis la pression du vent apparent et l'angle) ---
  const press = (aw.aws * aw.aws) / 400;
  const heelTarget = clamp(press * sailFactor() * Math.abs(Math.sin(absTwa * DEG)) * 30, 0, 55);
  S.heel += (heelTarget - S.heel) * clamp(2 * dt, 0, 1);

  // --- Manœuvre auto (virement / empannage) ---
  if (S.maneuver) {
    const err = norm180(S.maneuver.target - S.heading);
    S.rudder = clamp(err * 1.5, -35, 35);
    if (Math.abs(err) < 2) { S.maneuver = null; S.rudder = 0; }
  } else if (S.autohelm) {
    let tgt = S.autohelmHeading;
    if (S.placingWpt === false && S.waypoint) {
      // si pilote auto, on vise le waypoint
      const bearing = norm360(Math.atan2(S.waypoint.x - S.x, S.waypoint.y - S.y) / DEG);
      tgt = bearing;
      S.autohelmHeading = bearing;
    }
    const err = norm180(tgt - S.heading);
    S.rudder = clamp(err * 1.2, -25, 25);
  }

  // --- Rotation : il faut de l'erre pour que la barre agisse ---
  const wayFactor = clamp(S.stw / 2.5, 0.15, 1);
  S.heading = norm360(S.heading + (S.rudder / 35) * BOAT.turnRateMax * wayFactor * dt);

  // --- Dérive (leeway) : pousse sous le vent, surtout au près ---
  const side = Math.sign(twa) || 1;
  S.leeway = -side * BOAT.leewayMax * clamp(Math.cos(absTwa * DEG), 0, 1)
             * clamp(1 - S.stw / 6, 0, 1);

  // --- Déplacement : vitesse surface (cap+dérive) + courant ---
  const cog0 = S.heading + S.leeway;
  const vsMs = S.stw * KN_TO_MS;
  let vx = vsMs * Math.sin(cog0 * DEG);
  let vy = vsMs * Math.cos(cog0 * DEG);

  const cur = tideCurrent();
  const curMs = cur.spd * KN_TO_MS;
  vx += curMs * Math.sin(cur.dir * DEG);
  vy += curMs * Math.cos(cur.dir * DEG);

  S.x += vx * dt;
  S.y += vy * dt;

  // sillage
  if (S.t % 1 < dt || S.trail.length === 0) {
    S.trail.push({ x: S.x, y: S.y });
    if (S.trail.length > 600) S.trail.shift();
  }

  // --- Sonde & échouement ---
  const depth = seabedDepth(S.x, S.y) + tideHeight();
  S.aground = depth < BOAT.draft;
  if (S.aground) { S.stw = 0; }

  // --- Horloge & avance de la marée ---
  S.t += dt;
  S.tidePhase = (S.tidePhase + dt / (12.42 * 3600)) % 1;  // cycle ~12h25

  // mémoriser dernières valeurs calculées pour l'affichage
  S._aw = aw;
  S._cog = norm360(cog0);
  S._sog = Math.hypot(vx, vy) / KN_TO_MS;
  S._depth = depth;
  S._cur = cur;
}

/* ---------------------------------------------------------------------
   Rendu — Compas
   --------------------------------------------------------------------- */
function drawCompass(ctx) {
  const w = ctx.canvas.width, c = w / 2, R = c - 16;
  ctx.clearRect(0, 0, w, w);
  ctx.save(); ctx.translate(c, c);

  // rose tournante (cap en haut)
  ctx.save(); ctx.rotate(-S.heading * DEG);
  ctx.strokeStyle = '#1d3c54'; ctx.fillStyle = '#8fb0c6';
  ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let a = 0; a < 360; a += 10) {
    const big = a % 30 === 0;
    const r1 = R, r2 = R - (big ? 14 : 8);
    ctx.beginPath();
    ctx.moveTo(r1 * Math.sin(a * DEG), -r1 * Math.cos(a * DEG));
    ctx.lineTo(r2 * Math.sin(a * DEG), -r2 * Math.cos(a * DEG));
    ctx.lineWidth = big ? 2 : 1;
    ctx.strokeStyle = big ? '#2c5572' : '#173247';
    ctx.stroke();
  }
  const card = [['N', 0, '#f87171'], ['E', 90, '#8fb0c6'], ['S', 180, '#8fb0c6'], ['O', 270, '#8fb0c6']];
  for (const [t, a, col] of card) {
    ctx.fillStyle = col; ctx.font = 'bold 16px sans-serif';
    ctx.fillText(t, (R - 30) * Math.sin(a * DEG), -(R - 30) * Math.cos(a * DEG));
  }
  ctx.restore();

  // bateau fixe (pointe en haut)
  ctx.fillStyle = '#ffd166';
  ctx.beginPath();
  ctx.moveTo(0, -R + 8); ctx.lineTo(10, 14); ctx.lineTo(0, 6); ctx.lineTo(-10, 14);
  ctx.closePath(); ctx.fill();

  // lubber line + cap numérique
  ctx.fillStyle = '#e9f3fb'; ctx.font = 'bold 30px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(Math.round(S.heading).toString().padStart(3, '0') + '°', 0, 2);
  ctx.fillStyle = '#8fb0c6'; ctx.font = '11px sans-serif';
  ctx.fillText('CAP', 0, 22);
  ctx.restore();
}

/* ---------------------------------------------------------------------
   Rendu — Cadran de vent
   --------------------------------------------------------------------- */
function drawWind(ctx) {
  const w = ctx.canvas.width, c = w / 2, R = c - 16;
  ctx.clearRect(0, 0, w, w);
  ctx.save(); ctx.translate(c, c);

  // secteur "no-go" (près impossible) en haut
  ctx.fillStyle = 'rgba(248,113,113,.10)';
  ctx.beginPath(); ctx.moveTo(0, 0);
  ctx.arc(0, 0, R, (-90 - BOAT.noGo) * DEG, (-90 + BOAT.noGo) * DEG);
  ctx.closePath(); ctx.fill();

  // graduations
  ctx.strokeStyle = '#173247';
  for (let a = 0; a < 360; a += 30) {
    ctx.beginPath();
    ctx.moveTo(R * Math.sin(a * DEG), -R * Math.cos(a * DEG));
    ctx.lineTo((R - 10) * Math.sin(a * DEG), -(R - 10) * Math.cos(a * DEG));
    ctx.stroke();
  }
  ctx.fillStyle = '#8fb0c6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('BÂBORD', -R + 26, 0); ctx.fillText('TRIBORD', R - 26, 0);

  const aw = S._aw || apparentWind();

  // flèche vent réel (relatif à l'étrave)
  const drawArrow = (angle, color, len, head) => {
    const a = angle * DEG;
    const x = len * Math.sin(a), y = -len * Math.cos(a);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(x, y); ctx.stroke();
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(0, -head); ctx.lineTo(head * .7, head); ctx.lineTo(-head * .7, head); ctx.closePath(); ctx.fill();
    ctx.restore();
  };
  drawArrow(aw.twa, '#33c2ff', R - 24, 9);   // vent réel
  drawArrow(aw.awa, '#fbbf24', R - 48, 7);   // vent apparent

  // centre
  ctx.fillStyle = '#e9f3fb'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(Math.round(Math.abs(aw.twa)) + '°', 0, -4);
  ctx.fillStyle = '#33c2ff'; ctx.font = '10px sans-serif';
  ctx.fillText('VENT RÉEL', 0, 14);
  ctx.restore();
}

/* ---------------------------------------------------------------------
   Rendu — Carte
   --------------------------------------------------------------------- */
function drawChart(ctx) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  const sc = S.chartScale;                      // px/m
  const cx = w / 2, cy = h / 2;                 // bateau centré
  const toScreen = (x, y) => [cx + (x - S.x) * sc, cy - (y - S.y) * sc];

  // bathymétrie (échantillonnage léger)
  const grid = 28;
  for (let i = 0; i < w; i += grid) {
    for (let j = 0; j < h; j += grid) {
      const wx = S.x + (i + grid / 2 - cx) / sc;
      const wy = S.y - (j + grid / 2 - cy) / sc;
      const d = seabedDepth(wx, wy) + tideHeight();
      let col;
      if (d < BOAT.draft) col = 'rgba(180,80,60,.55)';        // échouable
      else if (d < 4) col = 'rgba(120,90,40,.40)';            // haut-fond
      else if (d < 8) col = 'rgba(40,90,120,.45)';
      else if (d < 16) col = 'rgba(20,70,110,.45)';
      else col = 'rgba(10,45,80,.45)';
      ctx.fillStyle = col;
      ctx.fillRect(i, j, grid, grid);
    }
  }

  // quadrillage NM (1852 m)
  ctx.strokeStyle = 'rgba(120,160,190,.12)';
  ctx.lineWidth = 1;
  const nm = 1852 * sc;
  const ox = ((cx - S.x * sc) % nm + nm) % nm;
  const oy = ((cy + S.y * sc) % nm + nm) % nm;
  for (let x = ox; x < w; x += nm) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = oy; y < h; y += nm) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

  // sillage
  if (S.trail.length > 1) {
    ctx.strokeStyle = '#3a6a86'; ctx.lineWidth = 2; ctx.beginPath();
    S.trail.forEach((p, k) => { const [sx, sy] = toScreen(p.x, p.y); k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.stroke();
  }

  // waypoint + route
  if (S.waypoint) {
    const [wx, wy] = toScreen(S.waypoint.x, S.waypoint.y);
    ctx.strokeStyle = 'rgba(52,211,153,.5)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(wx, wy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#34d399';
    ctx.beginPath(); ctx.arc(wx, wy, 6, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(wx, wy, 11, 0, 7); ctx.strokeStyle = '#34d399'; ctx.stroke();
  }

  // flèche vent (coin haut-gauche)
  drawCornerArrow(ctx, 46, 46, S.windDir + 180, '#33c2ff', 'Vent ' + Math.round(S.windSpdInst) + ' nds');
  // flèche courant (coin haut-droit)
  const cur = S._cur || tideCurrent();
  if (cur.spd > 0.05) drawCornerArrow(ctx, w - 46, 46, cur.dir, '#7c5cff', 'Courant ' + cur.spd.toFixed(1) + ' nds');

  // bateau
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(S.heading * DEG);
  ctx.fillStyle = S.aground ? '#f87171' : '#ffd166';
  ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(7, 10); ctx.lineTo(0, 6); ctx.lineTo(-7, 10); ctx.closePath(); ctx.fill();
  ctx.restore();

  // échelle
  ctx.fillStyle = '#8fb0c6'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('1 carreau = 1 NM', 8, h - 10);
}
function drawCornerArrow(ctx, x, y, dirTo, color, label) {
  ctx.save(); ctx.translate(x, y);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
  const a = dirTo * DEG, L = 22;
  const ex = L * Math.sin(a), ey = -L * Math.cos(a);
  ctx.beginPath(); ctx.moveTo(-ex, -ey); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.save(); ctx.translate(ex, ey); ctx.rotate(a);
  ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5, 6); ctx.lineTo(-5, 6); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(label, 0, 34);
  ctx.restore();
}

/* ---------------------------------------------------------------------
   Libellés
   --------------------------------------------------------------------- */
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
function gustLabel(g) { return g < 15 ? 'régulier' : g < 40 ? 'moyenne' : g < 70 ? 'forte' : 'très rafaleux'; }
function tidePhaseLabel(p) {
  if (p < 0.05 || p > 0.95) return 'basse mer (étale)';
  if (p < 0.45) return 'montante';
  if (p < 0.55) return 'pleine mer (étale)';
  return 'descendante';
}

/* ---------------------------------------------------------------------
   Mise à jour de l'affichage
   --------------------------------------------------------------------- */
const $ = id => document.getElementById(id);
function fmtHM(sec) {
  const t = Math.floor(sec) % 86400;
  return String(Math.floor(t / 3600)).padStart(2, '0') + ':' + String(Math.floor(t / 60) % 60).padStart(2, '0');
}
function updateReadouts() {
  const aw = S._aw || apparentWind();
  const wpDist = S.waypoint ? Math.hypot(S.waypoint.x - S.x, S.waypoint.y - S.y) : 0;
  const bearing = S.waypoint ? norm360(Math.atan2(S.waypoint.x - S.x, S.waypoint.y - S.y) / DEG) : 0;
  const vmg = S.waypoint ? S._sog * Math.cos(norm180(bearing - (S._cog || S.heading)) * DEG) : 0;

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
  const cur = S._cur || tideCurrent();
  $('roCurrent').textContent = cur.spd.toFixed(1) + ' nds / ' + Math.round(cur.dir).toString().padStart(3, '0') + '°';
  $('roWpt').textContent = (wpDist / 1852).toFixed(2) + ' NM @ ' + Math.round(bearing).toString().padStart(3, '0') + '°';
  $('clock').textContent = fmtHM(S.t);

  // alarmes
  const banner = $('alarmBanner');
  let msg = '';
  if (S.aground) msg = '⚠ ÉCHOUEMENT — fond insuffisant !';
  else if ((S._depth || 99) < BOAT.draft + 1.5) msg = '⚠ Petits fonds — sonde ' + (S._depth).toFixed(1) + ' m';
  else if (S.heel > 35) msg = '⚠ Gîte excessive — prends un ris !';
  if (msg) { banner.textContent = msg; banner.classList.remove('hidden'); }
  else banner.classList.add('hidden');
}

/* ---------------------------------------------------------------------
   Boucle principale
   --------------------------------------------------------------------- */
let last = performance.now();
const compassCtx = $('cCompass').getContext('2d');
const windCtx = $('cWind').getContext('2d');
const chartCtx = $('cChart').getContext('2d');

function loop(now) {
  const real = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (S.running) {
    // sous-pas pour rester stable à forte accélération temporelle
    let remaining = real * S.timeScale;
    const maxStep = 0.1;
    while (remaining > 0) { const d = Math.min(maxStep, remaining); step(d); remaining -= d; }
  }
  drawCompass(compassCtx);
  drawWind(windCtx);
  drawChart(chartCtx);
  updateReadouts();
  requestAnimationFrame(loop);
}

/* ---------------------------------------------------------------------
   Branchements UI
   --------------------------------------------------------------------- */
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
    case 'rudder': S.rudder = v; S.autohelm = false; $('autohelm').checked = false; break;
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

// barre au milieu
$('rudderCenter').onclick = () => { S.rudder = 0; $('rudder').value = 0; $('oRudder').textContent = '0°'; };

// pilote auto
$('autohelm').onchange = e => { S.autohelm = e.target.checked; if (S.autohelm) S.autohelmHeading = S.heading; };

// voiles
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

// virement / empannage
$('tackBtn').onclick = () => { S.maneuver = { target: norm360(2 * S.windDir - S.heading), type: 'tack' }; };
$('gybeBtn').onclick = () => { S.maneuver = { target: norm360(2 * S.windDir - S.heading), type: 'gybe' }; };

// accélération temporelle
$('timeSeg').addEventListener('click', e => {
  if (e.target.tagName !== 'BUTTON') return;
  [...$('timeSeg').children].forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  S.timeScale = parseFloat(e.target.dataset.t);
});
// pause
$('pauseBtn').onclick = () => {
  S.running = !S.running;
  $('pauseBtn').textContent = S.running ? '⏸ Pause' : '▶ Reprendre';
};

// météo
$('weatherSeg').addEventListener('click', e => {
  if (e.target.tagName !== 'BUTTON') return;
  [...$('weatherSeg').children].forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  applyWeather(e.target.dataset.w);
});
function applyWeather(w) {
  S.weather = w;
  // la météo influence vent / rafales / mer de façon réaliste
  const map = {
    sun:    { gust: 15 },
    clouds: { gust: 25 },
    rain:   { gust: 40 },
    fog:    { gust: 8, windCap: 8 },
    storm:  { gust: 85 },
  }[w];
  if (map.gust != null) { S.gust = map.gust; $('gust').value = map.gust; $('oGust').textContent = gustLabel(map.gust); }
  if (map.windCap != null && S.windSpd > map.windCap) {
    S.windSpd = map.windCap; $('windSpd').value = map.windCap; $('oWindSpd').textContent = map.windCap + ' nds';
  }
}

// scénarios prédéfinis
const PRESETS = {
  calm:    { windSpd: 4,  gust: 10, sea: 1, weather: 'sun',    tideRange: 2,  curMax: 0.5 },
  thermal: { windSpd: 11, gust: 20, sea: 2, weather: 'sun',    tideRange: 3,  curMax: 1.0 },
  breeze:  { windSpd: 16, gust: 25, sea: 3, weather: 'clouds', tideRange: 4,  curMax: 1.5 },
  gale:    { windSpd: 32, gust: 70, sea: 6, weather: 'rain',   tideRange: 6,  curMax: 3.0 },
  fog:     { windSpd: 6,  gust: 8,  sea: 1, weather: 'fog',    tideRange: 3,  curMax: 1.2 },
  storm:   { windSpd: 28, gust: 90, sea: 5, weather: 'storm',  tideRange: 5,  curMax: 2.5 },
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
    // suggère de réduire la toile si ça souffle
    const sugg = p.windSpd > 25 ? 2 : p.windSpd > 18 ? 1 : 0;
    S.reef = sugg; $('reef').value = sugg; $('oReef').textContent = sugg + ' ris';
  };
});

// reset position
$('resetBtn').onclick = () => {
  S.x = 0; S.y = 0; S.stw = 0; S.heel = 0; S.trail = []; S.aground = false;
};

// carte : zoom + placement waypoint
$('zoomIn').onclick = () => S.chartScale = clamp(S.chartScale * 1.4, 0.01, 0.4);
$('zoomOut').onclick = () => S.chartScale = clamp(S.chartScale / 1.4, 0.01, 0.4);
$('setWptBtn').onclick = () => { S.placingWpt = true; $('setWptBtn').classList.add('active'); };
$('cChart').addEventListener('click', e => {
  if (!S.placingWpt) return;
  const r = e.target.getBoundingClientRect();
  const px = (e.clientX - r.left) * (e.target.width / r.width);
  const py = (e.clientY - r.top) * (e.target.height / r.height);
  S.waypoint = {
    x: S.x + (px - e.target.width / 2) / S.chartScale,
    y: S.y - (py - e.target.height / 2) / S.chartScale,
  };
  S.placingWpt = false; $('setWptBtn').classList.remove('active');
});

// clavier : flèches = barre, espace = pause
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') { S.rudder = clamp(S.rudder - 5, -35, 35); S.autohelm = false; $('autohelm').checked = false; }
  if (e.key === 'ArrowRight') { S.rudder = clamp(S.rudder + 5, -35, 35); S.autohelm = false; $('autohelm').checked = false; }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') S.rudder = 0;
  if (e.code === 'Space') { e.preventDefault(); $('pauseBtn').click(); }
  $('rudder').value = S.rudder; $('oRudder').textContent = (S.rudder > 0 ? '+' : '') + S.rudder + '°';
});

requestAnimationFrame(loop);
