# Recherche design d’onglets (inspirations web)

## Sources consultées

1. **Material Design 3 — Tabs**  
   https://m3.material.io/components/tabs/overview
2. **Atlassian Design System — Tabs**  
   https://atlassian.design/components/tabs/
3. **Nielsen Norman Group — Navigation Tabs Guidelines**  
   https://www.nngroup.com/articles/tabs-used-right/
4. **Radix UI Tabs (pattern d’implémentation clair)**  
   https://www.radix-ui.com/primitives/docs/components/tabs

## Ce qui ressort de la recherche

- Éviter les onglets “trop décorés” lorsque la zone de travail est dense : privilégier la lisibilité et un **état actif très clair**.
- Préférer des onglets avec:
  - un contraste élevé pour l’onglet actif,
  - un état hover léger,
  - des bords moins arrondis pour une lecture plus “pro”.
- Pour les sous-onglets (ex. pages PDF), un style **“tab-bar” avec séparation basse** est souvent plus lisible qu’un style “pills” complet.

## Direction retenue dans l’interface

- **Onglets principaux** (`.page-tabs`):
  - conteneur plus discret (moins glossy),
  - onglets plus compacts,
  - actif en dégradé accentué mais propre.
- **Onglets de pages PDF** (`.plan-page-tabs`):
  - ajout d’une ligne de séparation,
  - onglets en “cartes” avec bord supérieur arrondi,
  - actif mis en avant sans ombre excessive.

## Pourquoi ce choix

Ce compromis reprend les bonnes pratiques vues dans Material/Atlassian (clarté d’état, hiérarchie visuelle) tout en gardant l’identité visuelle du projet (dégradés et accents colorés).
