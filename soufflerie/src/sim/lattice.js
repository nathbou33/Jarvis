// Définition des réseaux de Boltzmann utilisés par le solveur.
// D2Q9 pour la soufflerie 2D, D3Q19 pour la soufflerie 3D.

function build(c, w) {
  const Q = c.length;
  const opp = c.map((ci) => c.findIndex((cj) => cj[0] === -ci[0] && cj[1] === -ci[1] && cj[2] === -ci[2]));
  return { Q, c, w, opp, nTex: Math.ceil(Q / 4) };
}

export const D2Q9 = build(
  [
    [0, 0, 0],
    [1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0],
    [1, 1, 0], [-1, 1, 0], [-1, -1, 0], [1, -1, 0],
  ],
  [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36]
);

export const D3Q19 = build(
  [
    [0, 0, 0],
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    [1, 1, 0], [-1, -1, 0], [1, -1, 0], [-1, 1, 0],
    [1, 0, 1], [-1, 0, -1], [1, 0, -1], [-1, 0, 1],
    [0, 1, 1], [0, -1, -1], [0, 1, -1], [0, -1, 1],
  ],
  [1 / 3, 1 / 18, 1 / 18, 1 / 18, 1 / 18, 1 / 18, 1 / 18,
    1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36, 1 / 36]
);
