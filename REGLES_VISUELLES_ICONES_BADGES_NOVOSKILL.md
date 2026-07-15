# Référentiel visuel Novoskill — Icônes et badges

**Statut : règle projet obligatoire**
**Périmètre : Insights, Studio, People, Learn, Partner**
**Objet : uniformiser les icônes, badges, statuts et codes sans logique locale par écran**

---

## 1. Principes généraux

1. Un concept métier correspond à une icône unique dans toutes les consoles.
2. Une icône existante ne doit pas être redessinée localement dans une page.
3. Toute nouvelle icône doit être ajoutée au référentiel avant utilisation.
4. Les SVG utilisent uniquement `currentColor`.
5. Les couleurs sont portées par les classes CSS, jamais écrites directement dans les SVG.
6. Les badges sont définis selon leur fonction métier, pas selon la page qui les affiche.
7. Une information ne doit jamais être portée uniquement par la couleur.
8. Les anciens styles locaux doivent être supprimés lors de leur remplacement.
9. Aucun nouveau `font-size`, `padding`, `border-radius`, `stroke-width` ou code couleur lié aux icônes et badges ne doit être créé sans validation.

---

## 2. Règles techniques des icônes

### 2.1 Format SVG

Toutes les icônes officielles utilisent :

```html
<svg viewBox="0 0 24 24" aria-hidden="true">
```

Règles communes :

```css
fill: none;
stroke: currentColor;
stroke-width: 1.8;
stroke-linecap: round;
stroke-linejoin: round;
```

### 2.2 Tailles autorisées

| Token | Taille | Usage |
|---|---:|---|
| `--ns-icon-xs` | 14 px | Statut, badge, information secondaire |
| `--ns-icon-sm` | 16 px | Bouton compact, action de tableau |
| `--ns-icon-md` | 18 px | Bouton standard, menu |
| `--ns-icon-lg` | 20 px | Titre de carte |
| `--ns-icon-xl` | 24 px | Bloc métier, carte principale |
| `--ns-icon-kpi` | 28 px | Indicateur ou KPI |

Aucune taille intermédiaire ne doit être ajoutée localement.

### 2.3 Conteneur commun

```css
.ns-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  line-height: 1;
  color: currentColor;
}

.ns-icon svg {
  width: 100%;
  height: 100%;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
```

---

## 3. Référentiel métier des icônes

| Concept métier | Icône officielle retenue |
|---|---|
| Collaborateur | Utilisateur simple |
| Effectif / groupe | Groupe de personnes |
| Organisation | Bâtiment |
| Service | Organigramme simple |
| Poste | Mallette |
| Compétence | Cible avec coche |
| Certification | Ruban médaille |
| Formation | Chapeau de diplômé |
| Activité | Liste structurée |
| Criticité | Bouclier avec alerte |
| Contraintes | Curseurs |
| Information | Cercle information |
| Commentaire | Bulle de dialogue |
| Cotation conventionnelle | Document avec sceau |
| Analyse | Graphique analytique |
| Cartographie | Réseau de nœuds |
| Calendrier | Calendrier |
| Planification | Calendrier avec horloge |
| Demande RH | Clipboard |
| Actions RH | Checklist |
| Simulation RH | Scénario ramifié |
| IA | Étincelles |
| Consultation | Œil |
| Modification | Crayon |
| Enregistrement | Disquette |
| Archivage | Boîte d’archive |
| PDF | Document PDF |
| Navigation | Chevron |
| Fermeture | Croix |
| Téléphone | Téléphone |
| Email | Enveloppe |
| Paramètres | Engrenage |

### 3.1 Règle de cohérence

Une même action ne peut pas utiliser plusieurs icônes selon les consoles.

Exemples :

- `Consulter` utilise toujours l’œil.
- `Modifier` utilise toujours le crayon.
- `Archiver` utilise toujours la boîte d’archive.
- `Exporter en PDF` utilise toujours le document PDF.
- `Compétence` utilise toujours la cible avec coche.
- `Certification` utilise toujours le ruban médaille.

---

## 4. Référentiel des badges

### 4.1 Structure commune

Tous les badges héritent d’une base commune :

```css
.ns-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  min-height: 24px;
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  font-size: var(--ns-text-xs);
  font-weight: var(--ns-weight-semibold);
  line-height: 1.2;
  white-space: nowrap;
  border: 1px solid transparent;
}
```

Aucun badge ne doit recréer localement sa hauteur, son padding, son rayon ou sa graisse.

---

## 5. Familles officielles de badges

### 5.1 Badge code

Classe principale :

```text
ns-badge ns-badge-code
```

Usages :

- code compétence ;
- code poste ;
- code certification ;
- code formation ;
- référence métier.

Une couleur distincte est conservée par objet métier.

| Objet métier | Variante |
|---|---|
| Compétence | `ns-badge-code--competence` |
| Poste | `ns-badge-code--poste` |
| Certification | `ns-badge-code--certification` |
| Formation | `ns-badge-code--formation` |
| Autre référence | `ns-badge-code--neutral` |

### 5.2 Badge statut

Classe principale :

```text
ns-badge ns-badge-status
```

Variantes :

```text
ns-badge-status--success
ns-badge-status--warning
ns-badge-status--danger
ns-badge-status--info
ns-badge-status--neutral
```

Exemples de correspondance :

| Statut | Variante |
|---|---|
| Actif, validé, terminé | `success` |
| En cours, à traiter, reporté | `warning` |
| Bloqué, critique, refusé | `danger` |
| Planifié, transmis, informatif | `info` |
| Archivé, inactif, annulé | `neutral` |

### 5.3 Badge niveau de maîtrise

Classe principale :

```text
ns-badge ns-badge-level
```

Les quatre niveaux conservent quatre couleurs différentes, choisies dans des gammes proches afin de rester cohérentes visuellement.

| Niveau | Variante |
|---|---|
| Débutant | `ns-badge-level--beginner` |
| Intermédiaire | `ns-badge-level--intermediate` |
| Avancé | `ns-badge-level--advanced` |
| Expert | `ns-badge-level--expert` |

Règle visuelle :

- même saturation générale ;
- même luminosité de fond ;
- même contraste texte/fond ;
- progression perceptible sans rupture chromatique excessive.

### 5.4 Badge criticité

Classe principale :

```text
ns-badge ns-badge-criticality
```

Variantes :

```text
ns-badge-criticality--low
ns-badge-criticality--moderate
ns-badge-criticality--high
ns-badge-criticality--critical
```

### 5.5 Badge rôle

Classe principale :

```text
ns-badge ns-badge-role
```

Usages :

- manager ;
- formateur ;
- administrateur ;
- superviseur ;
- titulaire ;
- candidat.

### 5.6 Badge exigence

Classe principale :

```text
ns-badge ns-badge-requirement
```

Usages :

- obligatoire ;
- recommandé ;
- optionnel ;
- requis ;
- à valider.

### 5.7 Badge catégorie

Classe principale :

```text
ns-badge ns-badge-category
```

Usages :

- domaine de compétence ;
- catégorie de certification ;
- famille métier ;
- type de formation.

### 5.8 Badge produit

Classe principale :

```text
ns-badge ns-badge-product
```

Variantes :

```text
ns-badge-product--insights
ns-badge-product--studio
ns-badge-product--people
ns-badge-product--learn
ns-badge-product--partner
```

---

## 6. Couleurs sémantiques

Les couleurs doivent être définies dans un fichier central de tokens visuels.

```css
:root {
  --ns-success-text: #166534;
  --ns-success-bg: #f0fdf4;
  --ns-success-border: #bbf7d0;

  --ns-warning-text: #92400e;
  --ns-warning-bg: #fffbeb;
  --ns-warning-border: #fde68a;

  --ns-danger-text: #991b1b;
  --ns-danger-bg: #fef2f2;
  --ns-danger-border: #fecaca;

  --ns-info-text: #1e40af;
  --ns-info-bg: #eff6ff;
  --ns-info-border: #bfdbfe;

  --ns-neutral-text: #475569;
  --ns-neutral-bg: #f8fafc;
  --ns-neutral-border: #cbd5e1;
}
```

Les couleurs spécifiques aux objets métier et aux niveaux seront définies dans les mêmes tokens centraux.

---

## 7. Accessibilité

1. Le contraste texte/fond doit rester lisible.
2. Le texte du badge reste obligatoire.
3. Une icône décorative utilise `aria-hidden="true"`.
4. Une action composée uniquement d’une icône doit avoir un `aria-label`.
5. Les états ne doivent pas être différenciés uniquement par la couleur.
6. Les icônes interactives conservent une zone cliquable suffisante, indépendamment de leur taille graphique.

---

## 8. Interdictions

Sont interdits après migration :

- SVG inline différent pour un concept déjà référencé ;
- nouvelles icônes issues d’une autre bibliothèque ;
- tailles d’icônes arbitraires ;
- couleur intégrée directement dans un SVG ;
- badge recréé localement ;
- couleur de statut choisie dans une page ;
- nouvelle classe contenant `badge`, `pill`, `chip`, `status` ou `tag` sans validation ;
- usage d’une corbeille pour l’archivage ;
- usage d’une certification représentée par un bouclier ;
- duplication d’un même SVG dans plusieurs fichiers ;
- surcharge locale avec `!important` pour corriger une icône ou un badge.

---

## 9. Fichiers cibles du socle visuel

Le référentiel devra être implémenté avec :

```text
static/novoskill_visual_tokens.css
static/novoskill_icons.svg
```

Le premier centralise :

- tailles ;
- couleurs ;
- badges ;
- conteneurs d’icônes ;
- états et variantes.

Le second centralise toutes les icônes officielles sous forme de symboles SVG réutilisables.

---

## 10. Procédure d’évolution

Avant d’ajouter une icône ou un badge :

1. vérifier si le concept existe déjà ;
2. réutiliser l’élément officiel lorsqu’il existe ;
3. documenter le nouveau concept lorsqu’il est réellement distinct ;
4. valider son ajout ;
5. ajouter le SVG ou la variante CSS dans le socle central ;
6. ne jamais créer d’exception locale sans justification métier validée.

---

## 11. Décisions validées

- Compétence : cible avec coche.
- Certification : ruban médaille.
- Poste : mallette.
- Cotation conventionnelle : document avec sceau.
- Criticité : bouclier avec alerte.
- Contraintes : curseurs.
- Actions RH : checklist.
- Simulation RH : scénario ramifié.
- Niveaux de maîtrise : quatre couleurs distinctes dans des gammes proches.
- Codes métier : une couleur distincte par type d’objet.
