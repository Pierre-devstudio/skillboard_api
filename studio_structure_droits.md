# Studio – Structure des droits (admin / editor / user)

## 1) Objectif et périmètre
Cette note décrit la structure de droits **effectivement mise en place** dans Skillboard Studio.

- Les droits servent à **filtrer l’UI (menu)** et à **sécuriser l’API (403)**.
- Le rôle est **un droit d’accès**, pas une donnée RH : il est porté par **tbl_studio_user_access**.
- Principe : **masquer ≠ sécuriser**. La sécurité est appliquée côté API.

---

## 2) Source de vérité
### Table
**`public.tbl_studio_user_access`**
- `email` (clé logique utilisateur)
- `id_owner` (périmètre / tenant Studio)
- `archive` (filtre implicite : `COALESCE(archive,FALSE)=FALSE`)
- `role_code` (droit)

### Valeurs autorisées
`role_code` ∈ **`admin`**, **`editor`**, **`user`**
- Contrôle en base via contrainte `CHECK`.
- Normalisation : `lower(trim(role_code))`.
- Valeurs inconnues → forcées à `user`.

### Libellés affichés (UI)
- `admin` → **Administrateur**
- `editor` → **Éditeur**
- `user` → **Utilisateur**

### Rangs (comparaison)
- `admin` = 3
- `editor` = 2
- `user` = 1

---

## 3) Récupération du rôle côté API
### Endpoints impactés
- **`GET /studio/me/scope`** : renvoie `owners[]` enrichi avec `role_code` + `role_label`.
- **`GET /studio/context/{id_owner}`** : renvoie aussi `role_code` + `role_label` (utile dashboard/topbar).
- **`GET /studio/data/{id_owner}`** : renvoie `organisation` + `contact` ; le `contact.role` est dérivé de `role_code`.

### Super-admin
Si `is_super_admin` est vrai, le rôle est traité comme **admin**.

---

## 4) Gating UI (menu)
### Principe
Le menu porte un attribut `data-min-role` sur chaque entrée.

- `user` : visible pour tout le monde
- `editor` : visible pour `editor` + `admin`
- `admin` : visible uniquement pour `admin`

### Mécanisme
- Le front lit **`/studio/me/scope`** au chargement.
- `window.__studioRoleCode` est défini à partir de `owners[0].role_code` (ou de l’owner courant si `?id=` est présent).
- `applyMenuGating(roleCode)` masque/affiche `.menu-item[data-min-role]`.
- Nettoyage UX : les séparateurs `.menu-sep` sont masqués si inutiles (pas de séparateur isolé ou doublonné).

### Menu Studio (V1)
- **Dashboard** (min: user)
- **Vos données** (min: user)

Administration (admin only)
- **Votre organisation** (admin)
- **Vos collaborateurs** (admin)
- **Droits d’accès** (admin)
- **Vos partenaires** (admin)

Catalogues
- **Catalogue fiches de poste** (editor)
- **Catalogue compétences** (editor)
- **Catalogue formation (option)** (admin)

Clients
- **Vos clients** (editor)
- **Pilotage clients** (editor)

Support
- **Vos factures** (admin)
- **Vos documents** (admin)
- **Proposer une évolution** (user)

### Pages non développées
Les vues non implémentées pointent vers un placeholder commun :
- `menu_studio/studio_coming_soon.html`
- `menu_studio/studio_coming_soon.js` (titre auto = menu actif)

---

## 5) Sécurité API (vraie règle)
### Helper commun (backend)
Dans `studio_portal_common.py` :
- `studio_fetch_role_code(cur, email, id_owner, is_super_admin)`
- `studio_role_rank(role_code)`
- `studio_require_min_role(cur, u, id_owner, min_role)` → lève **HTTP 403** si droits insuffisants

### Règles appliquées
- **Modification entreprise : admin only**
  - `POST /studio/data/entreprise/{id_owner}` → vérifie `studio_require_min_role(..., "admin")`
  - Résultat attendu sinon : **403 Accès refusé (droits insuffisants)**

- **Modification contact : autorisée (user+)**
  - `POST /studio/data/contact/{id_owner}` → autorisée pour `user/editor/admin`
  - Le champ “Rôle” n’est **pas modifiable** ici (lecture seule).

- **Lecture data : autorisée (user+)**
  - `GET /studio/data/{id_owner}` → lecture autorisée si accès owner OK.

---

## 6) UX “Vos données” (rôle et édition)
### Rôle
- Affiché dans le champ **Rôle** (input disabled).
- Valeur issue de `tbl_studio_user_access.role_code` via `GET /studio/data/{id_owner}` → `contact.role`.
- **Non modifiable** depuis cette page (gestion future prévue ailleurs côté admin).

### Entreprise (édition)
- Côté API : admin only (403 sinon).
- Côté UI : si `window.__studioRoleCode != 'admin'` :
  - bouton **Modifier les informations** entreprise masqué
  - boutons save/cancel entreprise masqués
  - inputs entreprise restent disabled

### Confirmations
- Les confirmations “vertes” de succès ont été supprimées.
- Les erreurs sont conservées (message rouge) pour visibilité des échecs.

---

## 7) Ce que cette structure garantit
- Un cabinet peut donner à ses consultants un rôle **Éditeur** pour produire (catalogues/clients) sans exposer :
  - organisation interne
  - droits d’accès
  - factures/documents
- Un utilisateur standard ne voit que le nécessaire.
- L’API est protégée : l’UI ne suffit jamais.

---

## 8) Points prévus (non implémentés à ce stade)
- Mode **Cabinet vs Entreprise (Lite)** (filtrage de menus “Vos clients / Pilotage clients” en fonction d’un champ owner).
- Page “Droits d’accès” (admin) permettant de modifier `role_code` et les accès Studio/Insights/People.

