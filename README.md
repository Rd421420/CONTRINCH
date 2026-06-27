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
| **Allures** | **Vraie polaire** de vitesse (matrice force de vent × angle au vent, interpolation bilinéaire) : no-go, près, travers, largue, vent arrière. Coque ≈ 7,5 nds. |
| **Vent** | Vent réel (direction/force) + **vent apparent** calculé, rafales paramétrables. |
| **Voiles** | GV + génois (hissées ou non), **prise de ris** (0–3), écoutes auto ou manuelles, faseyement dans le no-go. |
| **Manœuvres** | Virer de bord, empanner. **Inertie de barre** (le gouvernail rejoint la consigne progressivement). |
| **Vagues** | État de mer Douglas 0–9 → hauteur de houle : **tangage/roulis** dans la vue à bord et **effet sur la vitesse** (frein dans le clapot debout, surf au portant). |
| **Gîte** | Calculée depuis la pression du vent apparent ; alarme si gîte excessive. |
| **Marée** | Amplitude, phase (montante/descendante/étale), hauteur d'eau, cycle ~12 h 25. |
| **Courant** | Courant de marée (flot/jusant) **variable selon le lieu** (accélère dans les petits fonds). |
| **Météo** | Soleil, nuages, pluie, brouillard, orage — influence rafales/vent **et le rendu de la vue à bord** (ciel, pluie, brouillard, éclairs). |
| **Sonde** | Bathymétrie + haut-fond, hauteur de marée, **alarme d'échouement** (TE 1,95 m). |
| **Navigation** | Waypoint cliquable, route, distance/relèvement, **VMG**, pilote auto. |

## Zone de navigation : L'Estartit — Îles Medes

Le plan d'eau reproduit (de façon stylisée mais reconnaissable) la côte de
**L'Estartit** sur la Costa Brava méditerranéenne :

- **Massif du Montgrí / Cap de la Barra** au nord, qui avance vers le large ;
- longue **plage de Pals** sablonneuse au sud (baie concave) ;
- **archipel des Îles Medes** au large à l'est (Meda Gran, Meda Petita + cailloux) ;
- profondeurs qui s'enfoncent vers le large, **échouement** sur la terre et les
  hauts-fonds, toponymes et marqueur du port sur la carte ;
- **silhouette de la côte** dessinée sur l'horizon dans la vue à bord ;
- réglages par défaut **méditerranéens** : marée faible (~0,5 m), Tramontane
  de secteur nord-ouest. Tous restent modifiables (n'importe quel vent / mer /
  marée / météo via les curseurs et scénarios).

Le bateau démarre à la sortie du port, cap au large, waypoint placé près des Medes.

## Plein écran

Bouton **⛶ Plein écran** dans la barre du haut (bascule entrée/sortie). Pratique
sur tablette ou pour une vue immersive sur ordinateur.

## Vue à bord, leçons et son

- **Vue à bord (horizon)** : perspective du barreur, **horizon qui s'incline** avec la gîte et tangue avec la houle, voiles visibles (et qui faseyent dans le no-go), bandeau de cap et girouette de vent apparent. Le décor change avec la météo.
- **Leçons guidées** : parcours en 7 étapes (près → travers → largue → virement → ris → empannage → waypoint) avec validation automatique et barre de progression.
- **Son & voix** : bouton **🔊 Son** pour activer le bruit du vent/des vagues (qui suit la force réelle) et les **annonces vocales** en français (consignes des leçons, alarmes de sonde/échouement). *À activer par un clic (politique des navigateurs).*
- **Mobile / tablette** : barre d'**onglets** en haut, une section à la fois, grosses commandes tactiles.

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
