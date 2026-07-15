# RÃˆGLES TYPOGRAPHIQUES NOVOSKILL

**Statut : rÃ¨gle projet obligatoire**
**PÃ©rimÃ¨tre : Insights, Studio, People, Learn, Partner, portails, formulaires publics et composants partagÃ©s**

## 1. Gouvernance
Les familles, tailles, graisses, interlignes et espacements de lettres dÃ©finis ici constituent le socle unique de Novoskill. **Il est interdit dâ€™en crÃ©er de nouveaux sans accord explicite de Pierre ou demande expresse de sa part.** Toute Ã©volution passe par `static/novoskill_typography.css`.

## 2. Familles autorisÃ©es
- `--ns-font-ui` : Inter, Segoe UI, Arial, sans-serif. Toute lâ€™interface.
- `--ns-font-system` : Segoe UI, Arial, sans-serif. Secours technique uniquement.
- `--ns-font-mono` : Roboto Mono, Consolas, Monaco, monospace. JSON, logs et donnÃ©es techniques.
- `--ns-font-signature` : Segoe Script, Brush Script MT, cursive. Signatures manuscrites dâ€™Ã©valuations et dâ€™entretiens uniquement.

La famille signature est interdite dans les titres, boutons, badges, menus et textes mÃ©tier.

## 3. Tailles autorisÃ©es
- `--ns-text-xs` : 12 px. MÃ©tadonnÃ©es et aides secondaires.
- `--ns-text-sm` : 13 px. Tableaux denses et texte secondaire.
- `--ns-text-md` : 14 px. Texte courant, champs et boutons.
- `--ns-text-lg` : 15 px. Titres de cartes et valeurs renforcÃ©es.
- `--ns-title-sm` : 17 px. Titres de sections et modals.
- `--ns-title-md` : 20 px. Titres de pages.
- `--ns-title-lg` : 24 px. Grands titres exceptionnels et signatures.
- `--ns-kpi` : 28 px. Valeurs KPI majeures.

Aucun texte fonctionnel sous 12 px. Toute information nÃ©cessaire pour comprendre ou agir doit Ãªtre au minimum Ã  13 px.

## 4. Graisses autorisÃ©es
- `--ns-weight-regular` : 400.
- `--ns-weight-medium` : 500.
- `--ns-weight-semibold` : 600.
- `--ns-weight-bold` : 700.

Les poids 800 et 900 et les valeurs intermÃ©diaires sont interdits.

## 5. Interlignes autorisÃ©s
- `--ns-leading-tight` : 1,15.
- `--ns-leading-title` : 1,25.
- `--ns-leading-ui` : 1,35.
- `--ns-leading-body` : 1,50.
- `--ns-leading-long` : 1,60.

## 6. Espacements de lettres autorisÃ©s
- `--ns-letter-tight` : -0,01 em.
- `--ns-letter-normal` : 0.
- `--ns-letter-label` : 0,04 em.

## 7. AccessibilitÃ© obligatoire
- Cible : WCAG 2.2 AA et RGAA en vigueur.
- Contraste minimal du texte courant : 4,5:1.
- Contraste minimal des composants et icÃ´nes utiles : 3:1.
- Lecture et fonctionnalitÃ©s conservÃ©es Ã  200 % de zoom.
- Aucune hauteur fixe ne doit couper un texte mÃ©tier.
- Aucune information ne repose uniquement sur une couleur.
- Focus clavier visible sur tous les Ã©lÃ©ments interactifs.

## 8. ImplÃ©mentation
- Utiliser uniquement les variables `--ns-*`.
- Aucun style typographique inline.
- Aucun `!important` typographique.
- RÃ©utiliser les composants existants avant toute rÃ¨gle locale.
- Une console peut changer ses couleurs, jamais son Ã©chelle typographique.
- Les signatures manuscrites utilisent `.ns-signature`, `[data-signature]` ou `.signature-manuscrite`.

## 9. ContrÃ´le avant livraison
1. VÃ©rifier quâ€™aucune valeur hors socle nâ€™a Ã©tÃ© ajoutÃ©e.
2. Tester Ã  100 %, 150 % et 200 % de zoom.
3. VÃ©rifier la lisibilitÃ© des tableaux, badges, boutons et textes secondaires.
4. VÃ©rifier le focus clavier et les contrastes.
5. VÃ©rifier que les textes longs ne sont ni coupÃ©s ni chevauchÃ©s.
