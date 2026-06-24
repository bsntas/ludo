// 52-square outer track [row, col], indexed 0-51, going clockwise from Red's start
export const TRACK = [
  [6,1],[6,2],[6,3],[6,4],[6,5],           // 0-4   Red side →
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],     // 5-10  ↑
  [0,7],[0,8],                              // 11-12 →
  [1,8],[2,8],[3,8],[4,8],[5,8],           // 13-17 Blue side ↓
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],// 18-23 →
  [7,14],[8,14],                            // 24-25 ↓
  [8,13],[8,12],[8,11],[8,10],[8,9],       // 26-30 Green side ←
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],// 31-36 ↓
  [14,7],[14,6],                            // 37-38 ←
  [13,6],[12,6],[11,6],[10,6],[9,6],       // 39-43 Yellow side ↑
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],     // 44-49 ←
  [7,0],[6,0],                              // 50-51 ↑
];

// Home column cells (6 deep each, index 0 = entry, 5 = closest to center)
export const HOME_COL = {
  red:    [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],
  blue:   [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],
  green:  [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],
  yellow: [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],
};

// Where each color enters the outer track (track index of first square)
export const COLOR_START = { red: 0, blue: 13, green: 26, yellow: 39 };

// Positions of the 4 piece bases inside the home zone, before entering track
export const HOME_BASE = {
  red:    [[1,1],[1,3],[3,1],[3,3]],
  blue:   [[1,10],[1,12],[3,10],[3,12]],
  green:  [[10,10],[10,12],[12,10],[12,12]],
  yellow: [[10,1],[10,3],[12,1],[12,3]],
};

export const CENTER = [7, 7];

const SAFE_POS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

// Build cell-type lookup once
const CTYPE = new Map();
(function buildMap() {
  // Home zones
  for (let r = 0; r <= 5; r++) {
    for (let c = 0; c <= 5; c++) CTYPE.set(`${r},${c}`, 'zone-red');
    for (let c = 9; c <= 14; c++) CTYPE.set(`${r},${c}`, 'zone-blue');
  }
  for (let r = 9; r <= 14; r++) {
    for (let c = 0; c <= 5; c++) CTYPE.set(`${r},${c}`, 'zone-yellow');
    for (let c = 9; c <= 14; c++) CTYPE.set(`${r},${c}`, 'zone-green');
  }
  // Outer track
  TRACK.forEach(([r,c], i) => {
    if      (i === 0)  CTYPE.set(`${r},${c}`, 'start-red');
    else if (i === 13) CTYPE.set(`${r},${c}`, 'start-blue');
    else if (i === 26) CTYPE.set(`${r},${c}`, 'start-green');
    else if (i === 39) CTYPE.set(`${r},${c}`, 'start-yellow');
    else if (SAFE_POS.has(i)) CTYPE.set(`${r},${c}`, 'safe');
    else CTYPE.set(`${r},${c}`, 'path');
  });
  // Home columns
  Object.entries(HOME_COL).forEach(([color, cells]) =>
    cells.forEach(([r,c]) => CTYPE.set(`${r},${c}`, `hcol-${color}`))
  );
  // Center
  CTYPE.set('7,7', 'center');
  // Mark base positions (for circle indicator)
  Object.values(HOME_BASE).flat().forEach(([r,c]) => {
    if (!CTYPE.has(`${r},${c}`)) CTYPE.set(`${r},${c}`, 'blank');
  });
})();

/** Create the 15x15 board grid inside el */
export function buildBoard(el) {
  el.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'board-grid';
  const baseCells = new Set(
    Object.values(HOME_BASE).flat().map(([r,c]) => `${r},${c}`)
  );
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const cell = document.createElement('div');
      const key = `${r},${c}`;
      const t = CTYPE.get(key) || 'blank';
      cell.className = `bcell bcell-${t}${baseCells.has(key) ? ' bcell-base' : ''}`;
      cell.dataset.pos = key;
      grid.appendChild(cell);
    }
  }
  el.appendChild(grid);
}

/**
 * Convert a piece's logical position to board [row, col].
 * pos: 0=home base, 1-52=outer track, 53-58=home column, 59=center
 */
export function pieceCoords(color, pos, pieceIdx) {
  if (pos === 0)  return HOME_BASE[color][pieceIdx];
  if (pos <= 52)  return TRACK[(COLOR_START[color] + pos - 1) % 52];
  if (pos <= 58)  return HOME_COL[color][pos - 53];
  return CENTER;
}

/** Place all pieces onto the board grid */
export function renderPieces(el, players, movablePieces, onPieceClick) {
  const grid = el.querySelector('.board-grid');
  if (!grid) return;

  // Remove old pieces
  grid.querySelectorAll('.piece').forEach(p => p.remove());
  grid.querySelectorAll('.bcell').forEach(c => c.classList.remove('multi-2','multi-3','multi-4'));

  // Group pieces by cell
  const cellMap = new Map();
  for (const player of players) {
    const { color, pieces } = player;
    pieces.forEach((pos, idx) => {
      const [r, c] = pieceCoords(color, pos, idx);
      const key = `${r},${c}`;
      if (!cellMap.has(key)) cellMap.set(key, []);
      cellMap.get(key).push({ color, idx, pos });
    });
  }

  for (const [key, pcs] of cellMap) {
    const cellEl = grid.querySelector(`[data-pos="${key}"]`);
    if (!cellEl) continue;
    if (pcs.length > 1) cellEl.classList.add(`multi-${Math.min(pcs.length, 4)}`);
    pcs.forEach(({ color, idx }) => {
      const p = document.createElement('div');
      const isMovable = movablePieces?.some(m => m.color === color && m.idx === idx);
      p.className = `piece piece-${color}${isMovable ? ' movable' : ''}`;
      p.dataset.color = color;
      p.dataset.idx   = String(idx);
      if (isMovable && onPieceClick) {
        p.addEventListener('click', () => onPieceClick(color, idx));
      }
      cellEl.appendChild(p);
    });
  }
}
