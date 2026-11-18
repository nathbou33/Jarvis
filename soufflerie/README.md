# Soufflerie numérique

Application de soufflerie virtuelle 2D/3D pour étudier l'aérodynamique d'une **Formule 1**, d'une **Hypercar** d'endurance et d'une **citadine compacte**. L'écoulement est réellement calculé sur la carte graphique (méthode de Boltzmann sur réseau, turbulence LES), et les efforts sont mesurés sur le maillage comme avec la balance d'une soufflerie physique.

Elle s'installe comme une application (PWA) sur téléphone, tablette et ordinateur, et fonctionne hors ligne après la première ouverture.

## Ce que fait l'application

- **Deux souffleries** : 3D (D3Q19) avec fumée en particules, plan de coupe et pression pariétale ; 2D (D2Q9) haute résolution avec fumée par peigne, coupe longitudinale, silhouette ou vue de dessus.
- **Réglages** : vitesse du vent (20 à 400 km/h), lacet (plateau tournant), sol roulant, roues en rotation, température, altitude, turbulence d'entrée, finesse du maillage.
- **Réglages voiture** : incidences d'ailerons, aéro active mode Z/X (F1), canards (Hypercar), becquet et rétroviseurs (citadine), hauteurs de caisse avant/arrière.
- **Mesures** : traînée, appui ou portance (N et kg), Cx, Cz, SCx, SCz, finesse, équilibre avant/arrière, puissance absorbée, force latérale, répartition par composant (carrosserie, fond plat, ailerons, roues), historique et convergence.
- **Visualisations** : fumée, vitesse, pression Cp, vorticité, pertes de pression totale, vitesse axiale, lignes de courant, sonde ponctuelle, distribution de Cp le long de la carrosserie, profil de sillage.
- **Export** : copie des résultats, CSV de l'historique, capture d'écran.

La fiche **Méthode** (bouton ⓘ) détaille les équations, les conditions aux limites et les limites de validité (similitude de Reynolds, résolution).

## Lancer en local

```bash
cd soufflerie
npm install
npm run dev        # http://127.0.0.1:5173
```

Production :

```bash
npm run build          # dossier dist/ à héberger (HTTPS requis pour l'installation)
npm run build:single   # dist-single/soufflerie.html : tout en un seul fichier
```

## Installer comme une application

Une fois `dist/` hébergé en HTTPS (GitHub Pages, Netlify, serveur de l'école…) :

- **Android / Chrome / Edge** : menu ⋮ → *Installer l'application*.
- **iPhone / iPad (Safari)** : bouton Partager → *Sur l'écran d'accueil*.
- **Ordinateur (Chrome / Edge)** : icône d'installation dans la barre d'adresse.

## Configuration requise

Navigateur avec WebGL 2 et rendu flottant (`EXT_color_buffer_float`) : Chrome, Edge, Firefox, Safari 15 ou plus récent. Sur téléphone, la qualité « Rapide » est choisie par défaut ; sur ordinateur avec carte graphique dédiée, « Fine » ou « Très fine » donnent des résultats plus précis.

## Organisation du code

| Dossier | Contenu |
|---|---|
| `src/sim/lbm.js` | Solveur LBM générique (D2Q9 / D3Q19), shaders générés, collision régularisée + Smagorinsky, efforts par échange de quantité de mouvement |
| `src/sim/tunnel.js` | Domaine, voxelisation, unités physiques ↔ réseau, dépouillement des efforts, moyennes et convergence |
| `src/geometry/` | Modèles procéduraux des trois voitures (maillages fermés), voxelisation par lancer de rayons, livrées |
| `src/viz/` | Vue 2D (fumée advectée, champs, lignes de courant) et vue 3D (particules, plan de coupe, Cp pariétal) |
| `src/ui/` | Contrôles, graphiques, fiche méthode |
| `tests/` | Pages de validation (cylindre à Re = 100, rendu des voitures, convergence des efforts) |

## Validation

`tests/cylinder.html` reproduit l'écoulement autour d'un cylindre à Re = 100 : le solveur donne Cx ≈ 1,41 (valeur de référence 1,33–1,45 selon le confinement), puis reste stable jusqu'à Re = 10⁷ grâce au modèle LES.
