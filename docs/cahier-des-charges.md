# Pré-étude de solvabilité et prise de rendez-vous

Cahier des charges et checklist de construction — ERA Dupont Romain
Version 2 — septembre 2026

*Modifications v2 : opérateur Twilio arrêté, délai J+2 ouvré, purge en base, modèle local précisé, coûts recalculés sur 128 demandes/mois.*

---

## 1. Ce que le système fait

Une demande de visite arrive par écrit (portail, formulaire du site, mail dans la boîte générale). Le système envoie un SMS au candidat, mène une courte conversation sur sa situation, calcule son taux d'effort au regard des critères Sésame, lui affiche le résultat, et — s'il est éligible — lui propose un créneau de visite cohérent avec les rendez-vous déjà posés dans le secteur.

**Ce qu'il ne fait pas :** il ne sélectionne pas. Le candidat qui ne passe pas les critères peut toujours maintenir sa demande, et cette demande arrive sur Telegram pour arbitrage humain. Voir §7.

**Périmètre :** demandes écrites uniquement. Les appels téléphoniques restent traités comme aujourd'hui, en direct.

**Volumétrie de référence :** 128 demandes sur le mois écoulé, soit environ 6 par jour ouvré.

---

## 2. Règles d'éligibilité

Source : Certification Sésame — Mila Services, contrat d'assurance collective. Taux d'effort retenu au contrat : **37 %**.

**Taux d'effort = loyer CC ÷ revenus nets mensuels avant impôts**

Traduit en coefficient utilisable dans le calcul :

| Situation | Taux | Revenus nets exigés | Coefficient |
|---|---|---|---|
| CDI (période d'essai comprise), fonctionnaire, militaire | 37 % | 2,70 × loyer CC | `2.70` |
| Retraité | 37 % | 2,70 × loyer CC | `2.70` |
| Auto-entrepreneur, profession libérale, indépendant | 37 % | 2,70 × loyer CC | `2.70` |
| CDD ou intérim, contrat > 12 mois | 25 % | 4,00 × loyer CC | `4.00` |
| Étudiant ou apprenti avec caution | 33 % | 3,03 × loyer CC | `3.03` |
| Dossier reposant sur un garant | 33 % | garant à 3,03 × loyer CC | `3.03` |

**Cas particulier du reste à vivre** — retraité ou personne handicapée, logement T1/T2/T3 uniquement :
`revenus nets − loyer CC > 550 €` (personne seule) ou `> 900 €` (couple).
Dérogatoire : s'applique à la place du taux d'effort, pas en plus.

**Exclusions sèches** — quelle que soit la situation :
- CDD ou intérim d'une durée inférieure ou égale à 12 mois (non assurable)
- Période de licenciement ou de préavis de démission
- Saisie sur salaire ou retenue liée à un avis à tiers détenteur

**Colocation :** revenus de tous les colocataires cumulés, un seul taux d'effort pour l'ensemble des signataires.

**Pluralité de cautions :** chaque cautionnaire s'engage individuellement pour la totalité du loyer, et doit gagner au moins **2 × le loyer CC**.

**Plafond assurable :** 5 000 € CC. Sans objet sur le portefeuille actuel, mais à câbler comme garde-fou.

### Revenus complémentaires pris en compte

13ᵉ mois, heures supplémentaires, revenus fonciers, pension alimentaire, rentes, AL/APL, allocations CAF ou CPAM (AF, AAH, ASI, ASPA, ASF, AEEH, pension de veuvage, pension d'invalidité).

**Taux confirmé : 25 %.** Ces revenus sont pondérés à part, ils ne s'additionnent pas simplement aux revenus principaux. La capacité de loyer se calcule donc par source (voir SMS 3 bis).

---

## 2 bis. Garanties : quatre branches, pas une case à cocher

Le type de garantie n'est pas un champ parmi d'autres — il détermine **quel référentiel s'applique**. Quatre branches, exclusives.

### Caution physique

Grille Mila du §2. Attention au seuil, qui change selon le nombre de cautions :

| | Seuil |
|---|---|
| Caution unique | 3,03 × loyer CC (taux garant 33 %) |
| Pluralité de cautions | **2 × loyer CC par tête**, sans cumul des revenus |

Chaque cautionnaire signe un acte séparé et s'engage pour la totalité du loyer. C'est pourquoi le seuil par tête est plus bas : deux personnes engagées chacune sur le tout valent mieux qu'une seule à trois fois le loyer.

**Conséquence pour le formulaire :** demander le **nombre** de cautions avant leurs revenus. Sans cette information, le calcul est faux.

### Visale (Action Logement)

**Visale ne se cumule ni avec une caution physique ni avec une GLI.** Le bailleur choisit une garantie et une seule. Les critères Mila ne s'appliquent donc pas du tout sur cette branche — c'est un autre référentiel, avec ses propres seuils.

Règles au 6 janvier 2026, **à vérifier sur visale.fr avant mise en production** et à revérifier chaque janvier :

| | Zone 1 | Zone 2 | Zone 3 |
|---|---|---|---|
| Plafond de loyer CC | 1 940 € | 1 575 € | 1 365 € |
| Forfait étudiant | 1 000 € | 840 € | 680 € |

- Taux d'effort maximum : **50 %**, soit des revenus d'au moins 2 × le loyer CC
- Forfait étudiant : jusqu'à 30 ans, sans examen des ressources tant que le loyer reste sous le forfait de zone
- Salariés de plus de 30 ans : conditions de ressources ou situation de mobilité professionnelle
- Couverture limitée aux 3 premières années du bail depuis 2026
- Le visa doit être obtenu **avant la signature du bail** — un bail signé avant activation n'est pas couvert

> ⚠️ **Zone Visale de Perpignan et des communes du portefeuille : à confirmer.** Le simulateur visale.fr donne la zone à partir de la commune. À relever une fois pour toutes les communes du portefeuille et à stocker dans la table `lots`.

**Deux cas à distinguer, et c'est le montant du visa qui tranche.**

*Le candidat a déjà son visa.* Le visa certifié porte un **loyer maximum garanti**. C'est ce montant qui décide, pas le taux d'effort :

| | |
|---|---|
| Montant du visa ≥ loyer CC du lot | dossier recevable, rendez-vous proposé |
| Montant du visa < loyer CC du lot | **refusé** — Visale ne couvrira pas ce bien |

Le visa ne se relève pas à la hausse : il faut une nouvelle demande auprès d'Action Logement, sur la base de ressources actualisées. Le message au candidat doit le dire, et donner l'écart en euros — c'est l'information qui lui permet d'agir.

Le formulaire doit donc demander, dès que Visale est déclaré : **avez-vous déjà votre visa, et quel montant y figure ?** Un visa annoncé sans montant part en arbitrage humain, jamais en verdict.

*Le candidat n'a pas encore de visa.* Pré-vérification seulement : plafond de zone, puis taux d'effort de 50 %. Le verdict maximal est `a_verifier_visale` — la pré-vérification est favorable, le candidat doit faire sa demande sur visale.fr. Le système ne délivre jamais de visa, et ne préjuge jamais de la réponse d'Action Logement.

**Une contrainte côté mandat.** Si le propriétaire a opté pour la GLI Mila sur son lot, Visale n'y est pas une option. Il faut donc un champ `accepte_visale` dans la table `lots`, renseigné à la prise de mandat. Sans lui, le système proposera Visale sur des biens où elle est impossible.

### Aucune garantie

Grille Mila du §2 sur les revenus propres du candidat.

### Autre — caution bancaire, garant payant, employeur

Sortie immédiate vers Telegram. Aucune règle automatisable : ces montages se jugent au cas par cas, et souvent avec le propriétaire.

### CONSEILLER

Disponible à tout moment de la séquence, y compris comme réponse à cette question. Sortie immédiate, verdict `a_qualifier`, notification Telegram. Aucun calcul n'est effectué.

---

## 3. Parcours candidat

```
Mail de demande (boîte générale)
        ↓
   Tri automatique — est-ce une demande de visite ?
        ↓
   Extraction : référence du lot, nom, mobile, mail
        ↓
   SMS 1 — présentation + question situation professionnelle
        ↓
   SMS 2 — garant oui/non
        ↓
   SMS 3 — revenus nets du foyer
        ↓
   Calcul du taux d'effort (déterministe, sans IA)
        ↓
   ├── Éligible ────→ SMS 4a : proposition de 2 créneaux (≥ J+2 ouvré)
   │                       ↓
   │                  Réponse → écriture Google Agenda + confirmation
   │
   └── Non éligible ─→ SMS 4b : critères + biens alternatifs + maintien possible
                            ↓
                       Si maintien → Telegram, arbitrage humain
```

Le candidat qui répond **CONSEILLER** à n'importe quel moment sort de la séquence et bascule sur Telegram pour rappel.

---

## 4. Script des messages

Ordre voulu : les questions à réponse fermée d'abord, le montant en dernier — quand le candidat est déjà engagé dans l'échange. C'est aussi la seule question qui demande de l'interprétation.

### SMS 1 — ouverture

> Bonjour, ici l'assistant automatisé de l'agence ERA Dupont Romain, au sujet de votre demande de visite pour le [RÉFÉRENCE / VILLE] à [LOYER] € charges comprises.
>
> Quelques questions rapides pour préparer votre dossier.
>
> Votre situation ? Répondez par un chiffre :
> 1 — CDI ou fonctionnaire
> 2 — CDD ou intérim
> 3 — Indépendant ou profession libérale
> 4 — Retraité
> 5 — Étudiant ou apprenti
> 6 — Autre
>
> Répondez CONSEILLER à tout moment pour être rappelé par un humain.

*Si réponse « 2 » → question intercalaire : « Votre contrat court sur plus de 12 mois ? OUI / NON »*

### SMS 2 — garantie

> Merci. Quelle garantie pouvez-vous présenter ?
> 1 — Une ou plusieurs personnes qui se portent caution
> 2 — La garantie Visale (Action Logement)
> 3 — Aucune garantie
> 4 — Autre (caution bancaire, garant payant, employeur)

*Si 1 → « Combien de personnes se portent caution ? » puis leurs revenus. Le nombre doit être demandé avant les montants : le seuil applicable en dépend (voir §2 bis).*
*Si 2 → « Avez-vous déjà votre visa Visale ? » puis « Quel montant de loyer maximum y figure ? ». Voir §2 bis.*
*Si 4 → sortie immédiate vers Telegram, arbitrage humain.*

### SMS 3 — revenus principaux

> Quels sont les revenus mensuels du foyer, en **net à payer avant impôt** — le montant en bas du bulletin de salaire, pas la somme virée sur le compte ?
>
> Indiquez le total si vous êtes plusieurs à signer le bail.

**Cette précision n'est pas cosmétique.** Mila calcule sur le net avant prélèvement à la source. Un candidat qui répond spontanément donne le net après prélèvement, inférieur de 5 à 15 %. Sans cette phrase, un dossier réellement à 2 000 € se présente à 1 850 € et se fait refuser à tort. C'est la première cause de faux négatif du système.

### SMS 3 bis — revenus complémentaires

> Percevez-vous l'un de ces revenus ? Indiquez le total mensuel, ou 0 :
> aide au logement (APL/AL), allocations familiales, pension alimentaire, revenus fonciers, 13ᵉ mois, heures supplémentaires, pension d'invalidité.

Ces revenus sont pris en compte par Mila **à un taux d'effort de 25 %**, distinct du taux principal. La capacité de loyer se calcule donc par source :

```
capacité = revenus principaux × 0,37 + revenus complémentaires × 0,25
éligible si capacité >= loyer CC
```

Un candidat à 1 750 € en CDI supporte 647 € de loyer. Avec 250 € d'APL, il monte à 710 € — et devient éligible sur un bien à 700 €. **Sans cette question, ce dossier est refusé à tort.**

### SMS 3 ter — composition du foyer (retraités et personnes handicapées uniquement)

> Vivez-vous seul ou en couple ?

Posée **uniquement** si la situation déclarée est « retraité » ou si un handicap est signalé : c'est le seul cas où la composition du foyer change le résultat (seuil de reste à vivre de 550 € ou 900 €). Pour tous les autres, la question est inutile et allonge la séquence pour rien.

### SMS 4a — situation compatible

> Merci. D'après les éléments que vous nous avez indiqués, votre situation semble compatible avec ce logement. Il s'agit d'une première approche déclarative : votre dossier sera étudié sur pièces après la visite.
>
> Deux créneaux de visite possibles :
> A — [JOUR] à [HEURE]
> B — [JOUR] à [HEURE]
>
> Répondez A ou B. Si aucun ne convient, répondez AUTRE.

Trois précautions dans cette formulation :

- **« semble compatible »**, pas « correspond ». Rien n'a été vérifié, tout est déclaratif.
- **« sera étudié sur pièces après la visite »** : le candidat sait que ce n'est pas un accord, et qu'un refus reste possible au dépôt du dossier.
- **Aucune mention de l'assurance loyers impayés.** Le candidat n'a pas à connaître le montage de garantie choisi par le propriétaire, et le nommer ferait passer un critère d'assureur pour un critère d'agence.

Variante Visale, quand le visa n'est pas encore obtenu :

> Merci. D'après vos éléments, votre situation semble compatible avec ce logement, sous réserve de l'obtention de votre visa auprès d'Action Logement et de l'étude de votre dossier sur pièces.

### SMS 4b — demande transmise

> Merci pour ces éléments. Votre demande est transmise à un conseiller, qui revient vers vous rapidement.

**Le système ne prononce aucun refus.** C'est le choix d'architecture le plus important du dispositif, et il simplifie tout le reste.

Ce message est envoyé pour tous les verdicts autres que favorables : `hors_criteres`, `non_assurable`, `a_qualifier`, `donnees_incompletes`. Le candidat n'apprend rien sur son dossier, et pour cause — rien n'a été décidé.

Ce qui disparaît avec ce choix :

- **Le mot-clé MAINTIEN** et tout le parsing associé
- **La question de l'article 22 du RGPD.** Il n'y a plus de décision automatisée, seulement une collecte d'informations et un aiguillage. La machine trie, elle ne tranche pas.
- **Le débat sur ce qu'il faut afficher.** Aucun seuil, aucun montant, aucun critère divulgué.
- **L'obligation de motiver un refus par SMS.** C'est toi qui écris le message final, comme aujourd'hui.

Ce que ça coûte : tous les dossiers non favorables passent par toi. Compte 40 à 50 par mois sur 128 demandes, soit deux ou trois par jour ouvré dans le récapitulatif de 18 h. L'écart avec les 38 arbitrages déjà prévus est faible.

Ce que ça apporte : tu vois passer les dossiers limites. Le CDD avec caution fonctionnaire, le lot vacant depuis six semaines — les cas où ton jugement vaut mieux qu'un ratio.

**Le gain de temps reste entier.** Ce qui est automatisé, c'est la collecte : tu ne fais plus l'entretien de qualification, tu ne fais plus que la décision. Le calcul te sert d'aide à la décision, pas de décideur.

### SMS 5 — confirmation

> C'est noté : visite du [ADRESSE] le [JOUR] à [HEURE]. Vous recevrez un rappel la veille. À bientôt.

### Filet de sécurité

Deux réponses incompréhensibles d'affilée sur la même question → bascule Telegram, fin de séquence automatique. Pas de troisième tentative.

### ⚠️ Ne pas utiliser STOP comme mot-clé de rappel

Twilio intercepte **STOP** avant que le message n'atteigne le webhook, et place définitivement le numéro en liste de blocage. Le mot-clé de mise en relation humaine doit donc être **CONSEILLER**, jamais STOP.

STOP reste actif comme véritable désinscription, ce qui est obligatoire. Interdit en France d'utiliser un numéro de téléphone comme mécanisme d'opt-out — un mot-clé ou un lien web, rien d'autre.

---

## 5. Attribution des créneaux

Rappel du principe arrêté : **la première visite ancre l'après-midi.** Les trois blocs terrain (lundi, mercredi, jeudi 14h–18h) démarrent vides. Le premier candidat qui réserve fixe la zone. Les suivants ne se voient proposer ce créneau que si leur lot est à moins de **12 km** de l'ancre.

### Règle première : même bien, créneaux consécutifs

**Les visites sont individuelles — un candidat par créneau.** Pas de visite groupée.

Le regroupement reste donc la règle première, mais il porte sur le **déplacement**, pas sur la visite : plusieurs candidats sur le même lot obtiennent des créneaux consécutifs sur le même après-midi. Un seul trajet, plusieurs candidats reçus l'un après l'autre, chacun seul dans le logement.

Ordre de priorité dans l'attribution :

1. **Des créneaux existent déjà sur ce lot cet après-midi** → le candidat prend le suivant, en enchaînement direct
2. **Sinon**, créneau proche d'une ancre existante (< 12 km)
3. **Sinon**, ouverture d'une nouvelle ancre
4. **Sinon**, semaine suivante

**Conséquence sur la cadence.** En visite individuelle, un créneau consomme le temps de visite plus le trajet. Sur quatre heures :

| | Durée par candidat | Capacité |
|---|---|---|
| Créneaux consécutifs, même lot | ~25 min | jusqu'à 8 |
| Lots différents dans la zone | ~40 min (visite + trajet) | 5 à 6 |

Le plafond de 6 par après-midi ne tient que si les lots sont réellement groupés. **Démarre à 5**, et remonte une fois que tu auras mesuré tes trajets réels. Un après-midi qui déborde, c'est le tampon du vendredi qui saute — et à terme, le bloc Chantier.

### Deux ancres par journée, pas une

Le défaut de la v1 : une seule ancre par après-midi. Le premier candidat qui réserve fixe la zone pour quatre heures, même s'il est isolé et qu'il n'y a rien d'autre à visiter dans son secteur.

Correction : **deux groupes indépendants par journée terrain**, chacun avec sa propre ancre.

> ⚠️ **Arbitrage à rendre.** Deux options, et elles n'ont pas le même coût.
>
> **Option A — matin + après-midi.** Deux zones réellement distinctes dans la journée. Mais les matinées portent aujourd'hui les blocs Chantier (mardi, jeudi 8h–10h) et les blocs Dossiers gestion. Ouvrir le terrain le matin revient à démonter la semaine type validée en septembre — c'est-à-dire à reprendre le problème que cette réorganisation devait régler.
>
> **Option B — après-midi coupé en deux.** 14h–16h zone A, 16h–18h zone B. Deux ancres, deux secteurs, aucun empiètement sur les matinées. Moins de latitude géographique, mais la semaine type tient.
>
> **Recommandation : option B.** Trois après-midis × 2 groupes = 6 zones desservies par semaine, ce qui couvre largement le portefeuille sur 10 communes. L'option A ne se justifierait qu'en cas de saturation avérée — à mesurer après deux mois, pas à anticiper.

### La table `lots` : ce que le système doit connaître des biens

SPI ne produit ni API, ni flux de diffusion exploitable, ni export. La table doit donc être alimentée autrement — et la bonne nouvelle est que le problème est bien plus petit qu'il n'en a l'air.

**Elle ne contient pas ton portefeuille, seulement les lots disponibles.** À un instant donné, c'est une poignée de biens, pas deux cents. Un lot y entre à la réception du préavis, il en sort à la signature du bail. La saisie manuelle est parfaitement tenable à ce volume.

| Champ | Origine |
|---|---|
| `ref`, `commune`, `type`, `loyer_cc` | saisie à l'entrée |
| `lat`, `lon` | géocodage automatique à la commune (API Adresse) |
| `accepte_visale` | décision du propriétaire, saisie à la prise de mandat |
| `zone_visale` | relevé une fois par commune, jamais modifié ensuite |
| `statut` | `disponible` / `loue` |

**Alimentation par commande Telegram.** Tu es déjà dans Telegram pour les arbitrages, autant y ajouter les lots :

```
/lot 12345 Bompas T3 780 visale-ok
/loue 12345
```

n8n reçoit la commande, géocode la commune, insère la ligne. Trente secondes, au moment où tu traites le préavis — donc dans un geste que tu fais déjà.

**Le géocodage à la commune suffit.** Ton seuil est à 12 km : l'adresse exacte ne change jamais la décision entre Bompas et Le Soler. C'est précisément ce qui rend l'absence d'API SPI indolore ici.

*Piste à garder pour plus tard, sans la construire maintenant : les mêmes informations sont publiées sur le site de l'agence. Une lecture automatique de tes propres annonces éviterait la saisie — mais c'est fragile et ça se casse à chaque refonte du site. À reconsidérer seulement si la saisie manuelle devient pesante.*

### Lecture de l'agenda : deux filtres distincts

Les rendez-vous s'écrivent dans **ton agenda principal**, celui qui contient aussi tes séances de sport, le BNI et tes rendez-vous personnels. Deux règles pour que ça ne dérape pas.

**Filtre d'occupation — tous les événements comptent.** Si tu as bloqué manuellement un créneau dans un après-midi terrain, le système ne doit rien proposer par-dessus, quel que soit le titre de l'événement.

**Filtre d'ancre — seuls les événements ImmoAgenda comptent.** L'ancre géographique d'un après-midi est le premier événement dont la description contient le bloc ImmoAgenda. Un déjeuner ou un rendez-vous propriétaire posé dans un bloc terrain occupe la place mais ne fixe aucune zone.

Les rendez-vous créés par le système portent le préfixe `VISITE —` dans leur titre, pour que tu distingues d'un coup d'œil ce que la machine a posé de ce que tu as posé toi-même.

### Format ImmoAgenda : identique à l'existant

Les rendez-vous créés par le système s'écrivent **exactement** comme ceux posés à la main, pour que le workflow de relance 24h et celui des avis Google les lisent sans modification. Le format a été relevé sur tes événements réels et le générateur reproduit l'original au caractère près.

```
── ImmoAgenda (ne pas modifier cette section) ──
Type d'événement: Visite

Client(s):
  MARTINE DURAND (MARTINE.DURAND@EXAMPLE.COM) 0600000000

Bien(s):

Référence 677 (508 € par mois)
9 Impasse Jordi Barre 66750 SAINT CYPRIEN
Vendeur:  EMPREINTE IMMOBILIER
── Fin ImmoAgenda ───────────
```

**Le séparateur est le caractère U+2500 (─), pas un tiret ASCII.** Une substitution silencieuse par un tiret classique casse les deux workflows sans message d'erreur. C'est le piège principal de cette partie.

Champs renseignés à la création :

| Champ Google Agenda | Contenu |
|---|---|
| `summary` | `VISITE — NOM Prénom — COMMUNE` |
| `location` | adresse complète du lot |
| `description` | bloc ImmoAgenda ci-dessus |
| `start` / `end` | créneau attribué, 30 min par défaut |

Les marqueurs `[RELANCE ENVOYÉE …]` et `[AVIS DEMANDÉ …]` restent gérés par les workflows existants, qui les ajoutent après le bloc. Le générateur ne les écrit jamais.

**Le même module sert à la lecture.** C'est la présence du bloc ImmoAgenda qui distingue un rendez-vous métier d'un événement personnel — donc qui détermine l'ancre géographique d'un après-midi. Un déjeuner de famille renvoie `null` et n'ancre rien.

### Deux mains écrivent dans le même agenda

Les candidats qui téléphonent continuent d'être saisis par toi dans **ImmoFacile**, comme aujourd'hui. Le système ne traite que les demandes écrites. Les deux voies produisent le même format, ce qui rend l'ensemble cohérent :

- les visites que tu saisis via ImmoFacile servent d'ancre au système
- les visites posées par le système sont lues par tes workflows de relance et d'avis

La question de l'email disparaît au passage : ImmoFacile capture le client complet, et les demandes de portail apportent l'adresse. Aucun événement ne devrait se retrouver sans email.

**Mais deux écrivains sur le même agenda créent un risque de collision**, et c'est le point qu'il faut traiter avant la mise en service.

Entre le moment où le système propose deux créneaux par SMS et celui où le candidat répond, il peut s'écouler plusieurs heures. Tu auras peut-être posé une visite ImmoFacile au même horaire entre-temps. Deux protections, à câbler ensemble :

**Règle arrêtée : deux plages proposées, bloquées 2 heures, et vérification systématique à la confirmation.**

| | |
|---|---|
| **Blocage provisoire** | Les **deux** créneaux proposés sont marqués `reserve_jusqu_a = maintenant + 2 h` dans `creneaux_reserves`. Le système ne les propose à personne d'autre pendant ce délai. |
| **Vérification à la confirmation** | À la réponse du candidat, relecture de l'agenda **avant** toute écriture. Le blocage en base ne suffit pas : il ne connaît que les réservations du système. |

Les deux créneaux sont bloqués, pas seulement celui que le candidat choisira — sinon deux candidats reçoivent la même option B et l'un des deux se fait reprendre son choix.

Le blocage ne te contraint jamais, toi : ImmoFacile ignore cette base, et c'est très bien ainsi. Tu gardes la priorité absolue sur ton agenda, et c'est la vérification à la confirmation qui absorbe le conflit.

### Que se passe-t-il au bout des 2 heures

```
T+0     Deux créneaux proposés, bloqués
T+2h    Sans réponse → les deux créneaux sont libérés
        Un SMS de relance part avec deux créneaux recalculés,
        bloqués à leur tour 2 h
T+4h    Toujours sans réponse → abandon de la séquence
        Le candidat entre dans le récapitulatif Telegram de 18 h
        Purge de la fiche à J+30
```

Une seule relance, pas deux. Un candidat qui ne répond pas à deux propositions successives ne répondra pas à la troisième, et chaque message coûte.

**Si le créneau est pris entre-temps** — par toi via ImmoFacile, ou par un autre candidat — le système ne renvoie jamais d'échec. Il reproposera : « ce créneau vient d'être pris, voici deux autres possibilités », et le compteur de 2 h repart. Le candidat ne doit jamais rester sans réponse à cause d'une collision technique.

### Plage d'envoi : heures ouvrées, sans exception

**Aucun SMS ne part en dehors de la plage `lundi–vendredi, 9h–19h`, jours fériés exclus.** La règle vaut pour tous les messages du système : première prise de contact, questions, propositions de créneaux, relances, confirmations.

La table `locatif.jours_feries` déjà nécessaire au calcul du J+2 sert ici aussi — un seul référentiel pour les deux usages.

Trois raisons de tenir cette règle strictement :

- Un SMS d'agence à 21 h ou le dimanche donne une impression de démarchage automatisé, exactement ce que le dispositif doit éviter
- Les opérateurs français filtrent les envois hors plage 08h–21h30 hors dimanche et jours fériés ; se caler sur 9h–19h met à l'abri de tout arbitrage
- Un candidat qui répond à 22 h ne trouvera personne, et son créneau se bloque pour rien

**Conséquence importante : le compteur de 2 heures est un compteur ouvré, pas une horloge.** Il se met en pause à 19 h et reprend à 9 h le lendemain ouvré.

| Proposition envoyée | Expiration |
|---|---|
| Mardi 10h | mardi 12h |
| Mardi 18h | mercredi 10h |
| Vendredi 18h | lundi 10h |
| Veille de jour férié 18h | surlendemain ouvré 10h |

Sans cette pause, une proposition partie vendredi 18 h expirerait à 20 h, libérerait les créneaux pendant tout le week-end et déclencherait une relance le lundi sur un candidat qui n'a jamais eu l'occasion de répondre.

**Les réponses entrantes, elles, sont traitées à toute heure.** Un candidat qui répond à 22 h voit sa réponse enregistrée immédiatement et son rendez-vous confirmé — c'est seulement le SMS de confirmation qui attend 9 h. Rien ne justifie de lui faire perdre son créneau parce qu'il consulte son téléphone le soir.

**Agence fermée le samedi.** Le week-end complet est donc non ouvré, pour la plage d'envoi comme pour le calcul du J+2. Un seul et même paramètre :

```js
const JOURS_OUVRES = [1, 2, 3, 4, 5];   // lundi à vendredi
const PLAGE_ENVOI  = { debut: 9, fin: 19 };
```

Ces deux constantes gouvernent tout : le J+2, le compteur de 2 h, la file d'attente des SMS. Aucune autre règle de calendrier à écrire ailleurs.

### Délai minimum : J+2 ouvré

Aucun créneau proposé avant **deux jours ouvrés pleins**, week-ends et jours fériés exclus.

```
date_mini = date_demande + 2 jours ouvrés
créneaux candidats = blocs terrain (lun / mer / jeu) dont la date >= date_mini
```

Jours fériés : **API Etalab**, gratuite et sans clé.
`https://calendrier.api.gouv.fr/jours-feries/metropole.json`
À appeler une fois par an, mettre en cache dans une table `jours_feries` — pas à chaque calcul.

Effet concret :
| Demande reçue | Premier créneau possible |
|---|---|
| Lundi | Mercredi après-midi |
| Mardi | Jeudi après-midi |
| Mercredi | Lundi suivant |
| Jeudi ou vendredi | Lundi suivant |

Autres règles :
- Plafond **6 visites** par après-midi terrain
- **Un seul EDL** par après-midi ; s'il y en a un, il devient l'ancre
- Aucun créneau proche disponible → semaine suivante. Jamais de déplacement isolé.
- Heures ordonnées par itinéraire, pas par ordre d'arrivée des demandes

Géocodage : **API Adresse data.gouv** (`https://api-adresse.data.gouv.fr/search/`) — gratuite, sans clé, hébergée en France.

Distance : formule de haversine sur les coordonnées. Pas d'appel à un service de routage en v1.

Écriture dans Google Agenda au format **ImmoAgenda** dans la description de l'événement, pour que le workflow de relance RDV 24h existant le lise sans modification.

---

## 6. Architecture n8n

### WF-1 · Tri de la boîte générale

| | |
|---|---|
| Déclencheur | IMAP / Gmail trigger, toutes les 10 min |
| Filtre 1 | Expéditeurs connus (SeLoger, LeBonCoin, Bien'ici) + mots-clés du formulaire du site |
| Filtre 2 | LLM sur le **corps du message seul** — « est-ce une demande de visite ? oui/non » + extraction référence, nom, mobile |
| Sortie | Ligne dans `locatif.candidats`, statut `nouveau` |

Le LLM ne reçoit jamais la base de lots, l'historique candidat, ni les coordonnées propriétaire. Uniquement le texte du mail.

### WF-2 · Séquence SMS — Twilio

| | |
|---|---|
| Déclencheur | Nouvelle ligne `locatif.candidats` statut `nouveau` |
| Ressource | **Long code français** (numéro mobile +33 acheté chez Twilio) |
| Envoi | Node Twilio natif n8n |
| Réception | Webhook Twilio « A MESSAGE COMES IN » → URL n8n → matching sur le numéro |
| État | Champ `etape_sms` (1 à 5) pour savoir quelle question a été posée |
| Timeout | Pas de réponse sous 48 h → un rappel, puis abandon et purge |

**Pourquoi un long code et pas un Sender ID alphanumérique :** l'alphanumérique est unidirectionnel, il ne peut pas recevoir de réponse. Le long code domestique est le seul choix compatible avec une conversation, et Twilio confirme le support du SMS bidirectionnel en France. Le short code est bidirectionnel aussi mais coûte cher et demande 8 à 10 semaines de provisionnement — sans objet ici.

**Contraintes horaires françaises.** Les SMS marketing sont limités à 08h00–21h30, du lundi au samedi, hors jours fériés ; hors de ces plages, filtrage ou blocage opérateur. Les messages transactionnels en sont exemptés, et une réponse à une demande émise par le candidat lui-même relève du transactionnel. **Se caler quand même sur 09h00–19h00 du lundi au vendredi** : ça évite tout débat, et un SMS d'agence à 21h ne sert personne. File d'attente dans n8n pour les demandes arrivées hors plage.

**Parsing des réponses**
- Réponses fermées (1 à 6, OUI/NON, A/B, CONSEILLER, MAINTIEN) : `switch` sur le texte normalisé. Aucun LLM.
- Montant des revenus : **regex d'abord**, LLM seulement en repli.

```
/(\d[\d\s.,]*)\s*(?:€|euros?|eur)?/i
→ normalisation : espaces et points supprimés, virgule = décimale
```

La regex couvre « 1850 », « 1 850 € », « 1850,50 », « 2000e ». Elle échoue sur « environ deux mille » ou « 1200 chacun on est deux » — ces cas partent au LLM, avec sortie JSON stricte :

```json
{"revenus": 2400, "confiance": "haute"}
```

Confiance basse → relance de la question, une seule fois.

**Modèle local recommandé : `qwen2.5:3b-instruct-q4_K_M`, déjà installé (1,9 Go).** C'est exactement le bon profil — version *instruct*, quantisation Q4. L'entrée fait vingt mots, la sortie vingt tokens : il répondra en quelques secondes, sans commune mesure avec la minute observée sur des emails entiers.

**Ne pas router les données candidats vers `glm-5.3:cloud`.** Le suffixe `cloud` signifie que l'inférence ne tourne pas sur le VPS : le texte part chez l'hébergeur du modèle. Excellent pour du brouillon ou du test, à exclure pour un message contenant nom, revenus ou situation professionnelle d'un candidat — sinon il faut le déclarer comme sous-traitant et vérifier sa localisation.

**`mistral:latest` (7B, ~4,4 Go) : le laisser où il est.** Sur un VPS de 8 Go qui porte déjà n8n et Postgres, son chargement en mémoire concurrence directement les services de production, pour un gain nul sur une extraction de nombre. Si tu le gardes pour d'autres usages, fixe `OLLAMA_KEEP_ALIVE=30s` afin qu'il libère la RAM au lieu de rester résident cinq minutes après chaque appel.

Mistral en API ne devient pertinent que si le taux d'échec du couple regex + qwen dépasse 10 % sur les cinquante premiers cas.

### WF-3 · Calcul d'éligibilité

Node Code, entièrement déterministe.

```
coefficient = table[situation]
seuil = loyer_cc * coefficient

exclusions → non éligible, motif explicite
si revenus >= seuil → éligible
si garant et revenus_garant >= loyer_cc * 3.03 → éligible
si (retraité ou handicapé) et type_lot in [T1,T2,T3]
   et revenus - loyer_cc > (couple ? 900 : 550) → éligible
sinon → hors critères
```

Aucune IA. Traçable, testable, rejouable sur d'anciens dossiers.

### WF-4 · Proposition de créneau

1. Géocodage de l'adresse du lot (API Adresse)
2. Calcul de `date_mini` = J+2 ouvré (table `jours_feries`)
3. Lecture des blocs terrain à partir de `date_mini` dans Google Agenda
4. Pour chacun : lecture de l'ancre (premier événement posé), calcul de la distance
5. Filtre `< 12 km` et `< 6 visites`
6. Renvoi des 2 meilleurs créneaux, ordonnés par itinéraire
7. Sur réponse du candidat : création de l'événement, description au format ImmoAgenda

### WF-5 · Demande de pièces après visite

Déclenché manuellement par toi, quand tu retiens un candidat.

- Mail automatique avec **la liste exacte des justificatifs correspondant à sa situation** (générée depuis le tableau Mila — c'est le gain réel de ce workflow)
- Réception sur une adresse dédiée, pas la boîte générale
- Notification Telegram quand toutes les pièces attendues sont arrivées
- Relance automatique à 48 h sur les pièces manquantes, nommées une par une

Dépôt dans SPI et sur Sésame : **manuel**, faute d'API. Deux minutes par dossier retenu, quelques dossiers par lot. Ce qui est automatisé, c'est la demande et la relance — c'est là qu'est le temps perdu aujourd'hui.

### WF-5 bis · Arbitrages Telegram

**Destinataire unique : toi.** Les conseillers ne reçoivent rien.

Volume attendu : environ 38 arbitrages par mois sur 128 demandes, soit **deux par jour ouvré**. C'est tenable, mais seulement si ces alertes ne t'interrompent pas — deux notifications par jour arrivées n'importe quand, c'est exactement le mécanisme de dispersion que la semaine type cherche à supprimer.

**Deux files, pas une :**

| File | Contenu | Traitement |
|---|---|---|
| Immédiate | `a_qualifier` avec demande de rappel explicite (CONSEILLER) | dans la journée |
| Différée | tous les dossiers non favorables, cas hors grille, réponses incomprises | groupée à 18h |

La file différée s'accumule dans n8n et part en **un seul message récapitulatif à 18h**, dans ton bloc « Clôture — micro-tâches ». Un message par jour, pas trente.

**Point de fragilité à assumer :** destinataire unique veut dire que le système s'arrête quand tu es absent. Une semaine de congés, ce sont dix arbitrages en attente et des candidats sans réponse. Prévois, avant la première absence, soit un second destinataire temporaire, soit une réponse automatique au bout de 72 h sans arbitrage.

### WF-6 bis · Journal des dossiers écartés

Sans lui, tu ne sauras jamais ce que le système te fait perdre. Un faux positif se rattrape en visite ; un faux négatif part sans laisser de trace.

Table `refus_log`, alimentée à chaque verdict `hors_criteres` ou `non_assurable`, **sans donnée nominative** — elle n'est donc pas concernée par la purge :

| Champ | Contenu |
|---|---|
| `date` | horodatage |
| `ref_lot`, `commune`, `loyer_cc` | le bien concerné |
| `situation` | catégorie professionnelle |
| `verdict`, `motif` | ce qui a été décidé |
| `ecart_seuil` | revenus déclarés − seuil exigé |
| `garantie` | caution / Visale / aucune |

À relire à trois mois, avec une question précise : parmi les lots où des candidats ont été écartés, lesquels ont finalement été loués, et à quelles conditions ? Si beaucoup l'ont été à des dossiers comparables, le seuil est trop haut ou la question des revenus complémentaires est mal posée.

C'est aussi ce journal qui te donnera la réponse chiffrée le jour où Mila confirme 37 % — ou annonce 40 %.

### WF-6 · Purge

**Recommandation : la purge se fait en base, pas dans n8n.** Un workflow n8n qui ne tourne pas est une purge qui n'a pas lieu, et personne ne s'en aperçoit avant le contrôle.

Sur le PostgreSQL du VPS, `pg_cron` demande `shared_preload_libraries` et un redémarrage du cluster — c'est-à-dire une coupure de tes autres bases. **Le cron système fait le même travail sans rien redémarrer :**

```
0 3 * * *  psql -d era_loyers -c "SELECT locatif.purger_candidats();"
```

Champ `purge_le` calculé à l'écriture de chaque ligne :

| Cas | Délai | `purge_le` |
|---|---|---|
| Candidat sans réponse au SMS | 30 jours | `cree_le + 30j` |
| Candidat hors critères, non retenu après arbitrage | 30 jours | `cree_le + 30j` |
| Candidat éligible non retenu après visite | 3 mois | `date_visite + 90j` |
| Candidat retenu | dossier bascule dans SPI | purge à la signature du bail |

Prévoir en parallèle une table `purge_log` (date, nombre de lignes supprimées) — c'est ce qui prouve que la purge tourne, en cas de contrôle.

Non négociable sur ce volume : 128 demandes par mois, c'est plus de 1 500 fiches par an. Sans purge, la base devient illisible avant la fin du premier trimestre.

---

## 7. Cadre juridique

**Base légale :** mesures précontractuelles (art. 6.1.b RGPD). Aucun consentement à recueillir.

**Article 22 — décision automatisée : hors sujet ici.** Le système ne prononce aucun refus. Tout dossier non favorable part en revue humaine et c'est Romain qui décide, puis qui écrit au candidat. Il n'y a donc pas de décision produisant des effets juridiques prise sur le seul fondement d'un traitement automatisé.

La seule chose à préserver, et elle est structurelle dans le code : **le message envoyé au candidat sur un verdict non favorable ne doit jamais annoncer ni sous-entendre un refus.** Il annonce une transmission, rien d'autre. Si un jour ce message devait dire « votre dossier ne correspond pas », l'article 22 redeviendrait applicable du jour au lendemain.

**Loi du 6 juillet 1989 :** aucun justificatif demandé au stade de la pré-étude. Uniquement du déclaratif. Les pièces ne sont demandées qu'aux candidats retenus après visite, et strictement dans la liste limitative.

**Mention à afficher** dans le SMS 1 : identité du responsable de traitement, finalité, durée de conservation, droits d'accès et de rectification, contact. Si la place manque dans le message, un lien court vers une page dédiée du site suffit — les URL de marque passent bien mieux les filtres opérateurs français que les raccourcisseurs génériques, à éviter absolument.

**Registre des traitements :** une ligne à ajouter.

**Sous-traitants à déclarer : Twilio seulement.** La base tourne sur ton VPS, le modèle de langage aussi (Ollama) : aucune donnée candidat ne quitte le serveur en dehors du texte des SMS. C'est la configuration la plus simple à déclarer et à défendre. Vérifier les clauses contractuelles types dans le DPA Twilio, qui est hors UE.

**Contrepartie assumée : la sauvegarde t'incombe.** Plus d'hébergeur pour la gérer à ta place. Une base perdue, ce sont les rendez-vous en cours et les séquences SMS en vol. Vérifie que ta sauvegarde VPS couvre le schéma `locatif` avant la mise en service, pas après.

**Point le plus exposé :** Google Agenda, où le nom et le téléphone des candidats sont déjà écrits aujourd'hui. Le nouveau système n'aggrave rien mais ne le règle pas non plus.

---

## 8. Checklist de construction

### Préalables — à faire avant de coder

- [x] Opérateur SMS arrêté : **Twilio**
- [x] Taux confirmés : 37 % revenus stables, 25 % revenus complémentaires
- [x] Compte Twilio et long code français — pris en charge par Romain
- [ ] Créer une adresse mail dédiée au dépôt de pièces
- [ ] Faire valider par le juridique ERA ou ton conseil : le libellé du SMS 4a
- [ ] Publier la page de mention d'information sur le site, sous une URL de la marque

### Socle

- [ ] Créer le schéma `locatif` dans la base PostgreSQL existante du VPS (`schema.sql` fourni)
- [ ] Table `lots` limitée aux biens disponibles, géocodée à la commune
- [ ] Commandes Telegram `/lot` et `/loue` pour l'alimenter sans quitter l'outil
- [ ] Relever la zone Visale de chaque commune du portefeuille (une fois pour toutes)
- [ ] Table `jours_feries` alimentée depuis l'API Etalab
- [ ] Table de correspondance situation → coefficient → liste de justificatifs
- [ ] Ligne de crontab pour `purger_candidats()`, vérifier `purge_log` après 24 h
- [ ] Vérifier que la sauvegarde du VPS couvre bien le schéma `locatif`

### Workflows

- [ ] WF-3 calcul d'éligibilité — **construire celui-ci en premier**, il est déterministe et se teste seul
- [ ] Rejouer WF-3 sur 20 dossiers passés dont tu connais l'issue, vérifier que le verdict correspond
- [ ] WF-1 tri boîte générale — tester sur 30 mails réels avant activation
- [ ] Tester la regex de montant sur 30 réponses réelles avant de brancher le LLM
- [ ] WF-2 séquence SMS — tester sur ton propre numéro, puis sur 3 collègues
- [ ] Vérifier que STOP est bien traité comme désinscription et CONSEILLER comme mise en relation
- [ ] WF-4 créneaux — vérifier le géocodage sur 10 adresses du portefeuille, dont des communes rurales
- [ ] Vérifier le calcul J+2 ouvré sur les cas limites : demande un vendredi, veille de 1er novembre, pont de mai
- [ ] Vérifier la pause nocturne et week-end du compteur de 2 h (proposition vendredi 18h → expiration lundi 10h)
- [ ] WF-5 demande de pièces
- [ ] WF-6 purge — vérifier après 24 h que `purge_log` se remplit

### Mise en service

- [ ] Phase 1 — **le système propose, tu valides.** Chaque verdict et chaque créneau arrive sur Telegram avant envoi. Environ 100 décisions, soit trois semaines au rythme actuel.
- [ ] Phase 2 — automatisation des cas nets, arbitrage humain sur les cas limites uniquement
- [ ] Briefer les conseillers : les règles du §2 deviennent le référentiel commun de l'agence

---

## 9. Points ouverts

| Sujet | Décision attendue |
|---|---|
| Libellé du message 4a | Juridique ERA (le 4b n'annonce plus rien de décisionnel) |
| Regex + qwen2.5:3b suffisants, ou Mistral API ? | Test sur 50 cas |
| Seuil de 12 km — à ajuster après les premières semaines | Terrain |

---

## 10. Coûts prévisionnels

Base : **128 demandes par mois**.

Tous les candidats ne vont pas au bout des huit messages — les non-répondants sortent au deuxième ou troisième. Moyenne réaliste : cinq à six messages par dossier.

| Hypothèse | Coût par dossier | Par mois | Par an |
|---|---|---|---|
| Prudente (ton estimation, 8 messages) | 0,70 € | 90 € | 1 075 € |
| Réaliste (5–6 messages, entrants quasi gratuits) | 0,40 € | 51 € | 615 € |

Autres postes :
| Poste | Coût |
|---|---|
| Location du long code Twilio | ~1 à 3 € / mois |
| API Adresse data.gouv, API jours fériés | 0 € |
| Ollama sur le VPS | 0 € |
| n8n, PostgreSQL sur le VPS | déjà en place |

**Ce que ça remplace.** 128 appels de qualification à 10 minutes, c'est **21 heures par mois** — près de trois journées pleines, à toi ou à un conseiller. Sur l'année, 250 heures.

**Gain net attendu**, une fois la phase de validation passée :

| | |
|---|---|
| Temps de qualification actuel | 21 h / mois |
| Dossiers restant à traiter en direct (maintiens, réponses incomprises, demandes de rappel) | ~30 %, soit ~38 dossiers |
| Temps résiduel, contexte déjà collecté | ~3 h / mois |
| **Gain net** | **~18 h / mois** |

Pendant la phase 1, la validation de chaque verdict sur Telegram coûte environ 30 secondes par dossier, soit 1 h par mois. Le gain est donc déjà réel dès le premier mois de fonctionnement.

Même à l'hypothèse de coût haute, le dispositif revient à environ 5 € de l'heure gagnée.

Les entrants coûtent une fraction de centime, les sortants sont l'essentiel de la facture. Si le budget devient un sujet, le levier n'est pas de changer d'opérateur mais de raccourcir la séquence : fusionner les questions 1 et 2 dans un seul message fait tomber la note de 20 % sans rien perdre.
