# ⛵ Simulateur de voile — Croiseur 11 m

Application web autonome pour se familiariser avec la voile sur un **voilier de
croisière d'environ 11 m** (sloop : grand-voile + génois). Tout est centré sur
une **centrale d'instruments** type table à cartes, avec une vue de dessus.

## Lancer l'appli

Aucune installation : ouvre simplement **`index.html`** dans un navigateur
(double-clic ou glisser-déposer dans la fenêtre du navigateur).

> Tout fonctionne hors-ligne, en local. Pas de serveur, pas de dépendance.

## Ce que le simulateur modélise

| Domaine | Détail |
|---|---|
| **Allures** | Polaire de vitesse simplifiée d'un croiseur 11 m : no-go (vent debout), près, travers, largue, vent arrière. Vitesse de coque ≈ 7,5 nds. |
| **Vent** | Vent réel (direction/force) + **vent apparent** calculé, rafales paramétrables. |
| **Voiles** | GV + génois (hissées ou non), **prise de ris** (0–3), écoutes auto ou manuelles, faseyement dans le no-go. |
| **Manœuvres** | Virer de bord, empanner (auto-barre qui passe le bateau de l'autre bord). |
| **Gîte** | Calculée depuis la pression du vent apparent ; alarme si gîte excessive. |
| **Marée** | Amplitude, phase (montante/descendante/étale), hauteur d'eau, cycle ~12 h 25. |
| **Courant** | Courant de marée (flot/jusant), vecteur ajouté à la route fond. |
| **Météo** | Soleil, nuages, pluie, brouillard, orage — influence rafales et vent. |
| **Mer** | État de la mer échelle Douglas 0–9. |
| **Sonde** | Bathymétrie + haut-fond, hauteur de marée, **alarme d'échouement** (TE 1,95 m). |
| **Navigation** | Waypoint cliquable, route, distance/relèvement, **VMG**, pilote auto. |

## Commandes

- **Barre** : curseur, ou **flèches ←/→** du clavier (↑/↓ = barre au milieu).
- **Voiles** : cases GV/Génois, curseur de ris, écoutes (si « réglage auto » décoché).
- **Virer / Empanner** : boutons dédiés.
- **Pilote auto** : tient le cap, ou vise le waypoint.
- **Carte** : « Placer le waypoint » puis clic sur la carte ; boutons zoom ＋/－.
- **Environnement** : vent, rafales, mer, météo, marée, courant — tous réglables.
- **Scénarios** : pétole, brise thermique, F4, coup de vent F7, brouillard, grain orageux.
- **Accélération du temps** : ×1 à ×1800 pour voir évoluer la marée. **Espace** = pause.

## Repère / lecture des instruments

- **STW** = vitesse surface (dans l'eau) · **SOG** = vitesse fond (avec courant).
- **COG** = route fond réelle · **VMG** = vitesse utile vers le waypoint.
- **Vent réel** (bleu) et **vent apparent** (jaune) sur le cadran de vent ;
  le secteur rouge en haut = zone où l'on ne peut pas remonter (no-go).

## Modèle simplifié — avertissement

C'est un outil **pédagogique** : la physique est volontairement simplifiée
(polaire approchée, pas de hauteur de vagues sur la coque, pas de salinité,
etc.). Ne pas l'utiliser pour de la navigation réelle.

## Idées d'évolutions

Voir les questions en fin de conversation : sons/voix, vagues animées,
zones de navigation réelles (cartes SHOM), trafic/AIS, mode régate avec
chrono de départ, sauvegarde de scénarios, etc.
