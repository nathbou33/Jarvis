// Fiche « Méthode et hypothèses » : ce que calcule la soufflerie et comment lire les résultats.

export function infoHTML(t) {
  const g = t?.grid;
  const live = g
    ? `<div class="eq">Grille ${g.nx} × ${g.ny}${g.nz > 1 ? ` × ${g.nz}` : ''} = ${(g.nx * g.ny * g.nz).toLocaleString('fr-FR')} cellules · Δx = ${(g.dx * 1000).toFixed(1)} mm · ν<sub>LB</sub> = ${t.nuLB.toExponential(2)} · Δt = ${(t.dt * 1e6).toFixed(1)} µs/pas</div>`
    : '';
  return `
<h2 id="infoTitle">Méthode et hypothèses</h2>
<p>Cette soufflerie numérique résout réellement l'écoulement de l'air autour de la voiture, sur la carte graphique, à chaque image. Les efforts affichés sont mesurés sur le maillage, pas tirés d'un tableau.</p>
${live}
<h3>Solveur</h3>
<ul>
  <li><b>Méthode de Boltzmann sur réseau (LBM)</b> : réseau D3Q19 en 3D, D2Q9 en 2D. Le fluide est représenté par des populations de particules qui se propagent puis entrent en collision.</li>
  <li><b>Collision BGK régularisée</b> (projection sur les moments d'ordre 2), stable aux faibles viscosités.</li>
  <li><b>Turbulence : simulation des grandes échelles (LES)</b> avec le modèle de Smagorinsky (C<sub>s</sub> = 0,17), appliqué directement sur le tenseur des contraintes hors équilibre.</li>
  <li><b>Parois</b> : rebond à mi-chemin (bounce-back). Les roues en rotation sont des parois mobiles (terme de quantité de mouvement de Ladd), imposées quand la roue couvre au moins 6 cellules de rayon.</li>
  <li><b>Sol roulant</b> : en 2D, tapis mobile à la vitesse du vent là où le soubassement est résolu (au moins 3 cellules), paroi glissante ailleurs. En 3D, paroi glissante : pas de couche limite au sol, comme sur route, sans l'entraînement artificiel qu'un tapis produirait dans un soubassement d'une ou deux cellules. Sol roulant coupé : paroi fixe adhérente, comme une soufflerie à sol fixe.</li>
  <li><b>Ailerons en 3D</b> : une maille de plusieurs centimètres ne peut pas résoudre des éléments d'aile de 2 cm d'épaisseur séparés par des fentes de 1 à 2 cm. En 3D, les ailerons sont donc modélisés comme en simulation d'éoliennes (méthode des éléments de pale) : chaque tranche d'envergure lit la vitesse et l'angle de l'air calculés juste en amont, une polaire d'aile multi-éléments (portance selon l'incidence, traînée de profil et traînée induite liée à l'allongement) donne l'effort, et la réaction est réinjectée dans l'écoulement, réparti autour de la corde. L'aileron dévie ainsi réellement l'air et réagit au sillage de la voiture. Les plaques d'extrémité restent des parois. En 2D, les ailerons sont résolus géométriquement.</li>
  <li><b>Demi-modèle</b> : à lacet nul, la 3D ne calcule qu'une moitié de la veine avec un plan de symétrie (réflexion spéculaire), ce qui permet une maille plus fine à coût égal.</li>
  <li><b>Démarrage progressif</b> : l'écoulement part du repos, la vitesse d'entrée monte en douceur avec une viscosité élevée qui amortit les ondes acoustiques du démarrage.</li>
  <li><b>Veine</b> : écoulement amont imposé en entrée avec une couche absorbante (turbulence d'entrée réglable), frontières ouvertes à gradient nul en haut et sur les côtés (comportement proche d'une veine à jet ouvert, peu sensible au blocage), sortie à pression imposée précédée d'une zone éponge qui amortit tourbillons et ondes acoustiques.</li>
  <li><b>Viscosité de volume</b> : la partie isotrope des contraintes est relaxée séparément, ce qui amortit les ondes acoustiques propres à un solveur faiblement compressible sans modifier la viscosité de cisaillement.</li>
</ul>
<h3>Efforts et coefficients</h3>
<p>Les efforts sont obtenus par échange de quantité de mouvement sur chaque lien fluide-paroi, ventilés par composant (carrosserie, fond plat, ailerons, roues) puis convertis en unités réelles :</p>
<div class="eq">F = F<sub>LB</sub> · ρ · (V / U<sub>LB</sub>)² · Δx²   ·   Cx = D / (½ ρ V² S)   ·   Cz = L / (½ ρ V² S)</div>
<p>S est le maître-couple calculé sur la géométrie fine (pas sur les voxels). Le taux de blocage (part de la section occupée par la voiture) est indiqué ; les frontières étant ouvertes, aucune correction n'est appliquée. La pression des faces en contact (pneu sur le sol, pièces assemblées) est prise égale à la pression amont. Le sens « appui » correspond à Cz négatif. L'équilibre avant/arrière résulte du moment de tangage autour du contact de l'essieu avant (la traînée y contribue). En 2D, les grandeurs sont par mètre d'envergure et rapportées à la longueur de la voiture.</p>
<h3>Similitude et limites</h3>
<ul>
  <li><b>Reynolds.</b> Le Reynolds réel (Re ≈ 10<sup>7</sup>) est hors de portée de toute grille de quelques millions de cellules. Comme en soufflerie physique sur maquette, on travaille à un Reynolds de grille plus faible, la LES modélisant les petites échelles. En 2D, ce Reynolds est plafonné vers 2·10<sup>4</sup> : au-delà, la turbulence bidimensionnelle (sans équivalent réel) fait fusionner les tourbillons jusqu'à remplir la veine. Les forces varient bien en V², les coefficients étant peu sensibles au Reynolds pour des formes à arêtes vives.</li>
  <li><b>Résolution.</b> En 3D, une voiture couvre 50 à 120 cellules de long selon la finesse. C'est suffisant pour l'écoulement global, le sillage et les tendances, mais les profils en marches d'escalier et les couches limites non résolues font surestimer la traînée des formes profilées, d'autant plus que la maille est grossière. Les ailerons multi-éléments et les fentes plus fines qu'une cellule se confondent, et une garde au sol de moins de 2 cellules ferme le soubassement, ce qui supprime l'effet de sol. Utilisez la 3D pour comparer des configurations entre elles et visualiser l'écoulement, et la 2D (maille de 1 à 3 cm) pour les profils, les ailerons et le soubassement.</li>
  <li><b>Éléments fins.</b> En 3D, les pièces plus fines qu'une cellule (bras de suspension, halo, déflecteurs et ailettes du fond, volutes, dérive) sont exclues de la grille : elles y deviendraient des murs de plusieurs centimètres. Les entrées d'air des pontons et de la boîte à air, dont le débit de refroidissement n'est pas modélisé, sont représentées par un nez arrondi. Tout reste visible à l'écran, et la 2D les calcule.</li>
  <li><b>Compressibilité.</b> Le solveur est faiblement compressible (Mach réseau ≈ 0,14–0,17), cohérent avec un écoulement routier incompressible (Mach réel &lt; 0,35).</li>
  <li><b>Moyennes.</b> L'écoulement est instationnaire : les efforts affichés sont moyennés sur les 1,6 dernières unités de temps convectif t* = t·V/L, après exclusion du transitoire (1,6 t* après un démarrage, 0,4 à 0,6 t* après un changement de réglage). L'indicateur « stabilisé » s'allume quand les deux moitiés de la fenêtre concordent à 5 % près. L'option « champ moyen » affiche une moyenne temporelle glissante des champs.</li>
  <li><b>Modèles de voitures.</b> Géométries génériques construites aux cotes réelles de chaque catégorie, sans reproduire une voiture de marque précise.
    <ul>
      <li><b>Formule 1</b>, grandes cotes du règlement technique FIA 2026 : empattement 3 400 mm, largeur 1 900 mm, hauteur 950 mm, pneus 18" plus étroits (AV 280 mm, AR 375 mm), aileron avant réduit à 1 800 mm, aileron arrière à deux éléments sans « beam wing », aéro active (volets avant et arrière en mode virage ou ligne droite), fond plus plat aux tunnels réduits, masse minimale 768 kg.</li>
      <li><b>Hypercar</b> type LMH : 4,95 × 2,00 m, empattement 3,10 m, pneus 29/71-18 et 34/71-18, dérive dorsale, aileron à cols de cygne, masse 1 030 kg.</li>
      <li><b>Citadine</b> compacte 5 portes : 4,28 × 1,79 × 1,46 m, empattement 2,62 m, pneus 225/45 R17, masse 1 250 kg.</li>
    </ul>
  </li>
</ul>
<h3>Importer son propre modèle</h3>
<ul>
  <li><b>Formats</b> : GLB (recommandé), glTF à fichier unique, STL (binaire ou texte) et OBJ. Bouton « Importer » ou glisser-déposer le fichier sur la vue.</li>
  <li><b>Orientation</b> : la longueur est la plus grande dimension ; le haut suit la convention du format (Y pour glTF et OBJ, Z pour STL). L'avant est deviné (habitacle ou aileron en arrière du milieu) et réglable : « Inverser avant / arrière », « Retourner ».</li>
  <li><b>Échelle</b> : l'unité est déduite de la taille (mètres, centimètres, millimètres, pouces) ; la longueur réelle se règle ensuite. La voiture est posée sur le sol et centrée.</li>
  <li><b>Voxelisation robuste</b> : les modèles téléchargés sont rarement fermés. La surface est marquée sur une grille fine selon les trois axes, l'extérieur est rempli depuis les bords, et tout ce qui n'est pas atteint est solide : un habitacle ouvert ou un trou de quelques millimètres ne fausse pas le calcul.</li>
  <li><b>Limites</b> : les roues ne tournent pas, les efforts sont donnés pour la voiture entière (pas de ventilation par composant), et l'empattement servant à l'équilibre est estimé à 60 % de la longueur. À lacet nul, la 3D utilise la moitié gauche du modèle (plan de symétrie).</li>
</ul>
<h3>Lecture des visualisations</h3>
<ul>
  <li><b>Fumée</b> : traceur passif lâché en amont, comme en soufflerie réelle (lignes d'émission). En 3D, jusqu'à 260 000 particules sont transportées par le champ de vitesse calculé ; le mode « multi-flux » lâche une nappe d'environ 150 filets (250 en modèle complet) répartis sur toute la largeur et la hauteur, plus un rang au ras du sol pour suivre le soubassement.</li>
  <li><b>Contact fumée-carrosserie</b> : la fumée glisse sur la forme réelle de la voiture. Un champ de distance fin (1,5 à 3 cm) est calculé sur toutes les pièces visibles, ailerons et petites pièces compris ; une particule qui l'atteint est replacée sur la paroi, le long de laquelle elle continue. Les pas de transport sont assez courts pour ne jamais sauter par-dessus une pièce mince. La fumée ne traverse donc pas la carrosserie, même là où la grille de calcul est plus grossière que la voiture.</li>
  <li><b>Pertes de pression totale</b> : 1 − Cp<sub>0</sub> ; le sillage et les tourbillons apparaissent nettement.</li>
  <li><b>Plan de coupe transversal</b> derrière la voiture : équivalent d'un sondage de sillage, idéal pour voir les tourbillons de bout d'aileron et des roues.</li>
  <li><b>Ralenti</b> : la fumée et les roues tournent au ralenti, à une vitesse cohérente entre elles ; le temps physique simulé est indiqué dans la barre d'état.</li>
</ul>
<h3>Ordres de grandeur réels</h3>
<ul>
  <li>Citadine compacte : Cx ≈ 0,28–0,33, S ≈ 2,1–2,3 m², légère portance.</li>
  <li>Hypercar d'endurance : le règlement enferme l'aéro dans une fenêtre étroite, avec une finesse de l'ordre de 4.</li>
  <li>Formule 1 : SCx ≈ 1,0–1,5 m², SCz ≈ −3 à −5 m² selon le réglage ; le fond plat fournit plus de la moitié de l'appui.</li>
</ul>`;
}
