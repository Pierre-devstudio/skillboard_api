# Règles typographiques Novoskill

**Statut : règle projet obligatoire**

Ce document fixe le socle typographique commun aux consoles Insights, Studio, People, Learn et Partner. Aucun nouveau `font-family`, `font-size`, `font-weight`, `line-height` ou `letter-spacing` ne peut être créé sans accord explicite de Pierre.

## 1. Familles autorisées

1. Interface : `var(--ns-font-ui)` soit Inter, Segoe UI, Arial, sans-serif.
2. Technique : `var(--ns-font-mono)` uniquement pour code, JSON, identifiants et journaux techniques.
3. Signature manuscrite : `var(--ns-font-signature)` uniquement pour les signatures d'évaluation, d'entretien et documents associés.

La famille système `var(--ns-font-system)` est un fallback technique, pas une identité visuelle supplémentaire.

## 2. Tailles autorisées

- `--ns-text-xs` : 12 px, métadonnées et aides secondaires.
- `--ns-text-sm` : 13 px, tableaux denses et texte secondaire.
- `--ns-text-md` : 14 px, texte courant, champs et boutons.
- `--ns-text-lg` : 15 px, titres de cartes et valeurs renforcées.
- `--ns-title-sm` : 17 px, titres de sections et modals.
- `--ns-title-md` : 20 px, titres de pages.
- `--ns-title-lg` : 24 px, grands titres rares.
- `--ns-kpi` : 28 px, valeurs KPI majeures.

Aucun texte fonctionnel ne descend sous 12 px. Les informations nécessaires à la compréhension ou à l'action utilisent au minimum 13 px.

Exception : la taille utilisée pour dessiner une signature dans un canvas n'est pas une taille de texte d'interface et peut dépasser cette échelle.

## 3. Graisses autorisées

- 400 : texte courant.
- 500 : valeur ou texte légèrement renforcé.
- 600 : boutons, labels importants et titres de cartes.
- 700 : titres de pages et KPI.

Les valeurs intermédiaires et les graisses 800 à 950 sont interdites.

## 4. Interlignes autorisés

- 1.15 : KPI et titres très courts.
- 1.25 : titres.
- 1.35 : boutons, badges et tableaux.
- 1.5 : texte courant.
- 1.6 : textes longs.

## 5. Espacement des lettres

Valeurs autorisées : `-0.01em`, `0`, `0.04em`.

## 6. Accessibilité obligatoire

- Contraste du texte courant : 4,5:1 minimum.
- Contraste des composants et icônes utiles : 3:1 minimum.
- Zoom à 200 % sans perte de contenu ni chevauchement.
- Les couleurs ne portent jamais seules une information.
- Le focus clavier reste visible.
- Aucun contenu métier n'est masqué par une hauteur fixe ou un `overflow: hidden` sans accès alternatif.

## 7. Règles de développement

- Utiliser les variables du fichier `static/novoskill_typography.css`.
- Aucun style typographique inline nouveau.
- Aucun `!important` typographique.
- Aucun import de police externe non validé.
- La signature manuscrite reste strictement limitée aux zones de signature.
- Toute exception demande une validation explicite avant développement.
