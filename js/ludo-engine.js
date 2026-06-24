import { COLOR_START } from './board.js';

const SAFE_TRACK_IDX = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

export function rollDice() {
  return Math.floor(Math.random() * 6) + 1;
}

function absIdx(color, pos) {
  return (COLOR_START[color] + pos - 1) % 52;
}

export function getMovablePieces(state, color, dice) {
  const player = state.players.find(p => p.color === color);
  if (!player) return [];
  const result = [];
  player.pieces.forEach((pos, idx) => {
    if (pos === 59) return;
    if (pos === 0) { if (dice === 6) result.push(idx); return; }
    if (pos + dice <= 59) result.push(idx);
  });
  return result;
}

export function movePiece(state, color, pieceIdx, dice) {
  const st = JSON.parse(JSON.stringify(state));
  const player = st.players.find(p => p.color === color);
  const oldPos = player.pieces[pieceIdx];
  const newPos = oldPos === 0 ? 1 : oldPos + dice;
  player.pieces[pieceIdx] = newPos;

  if (newPos >= 1 && newPos <= 52) {
    const landIdx = absIdx(color, newPos);
    if (!SAFE_TRACK_IDX.has(landIdx)) {
      for (const opp of st.players) {
        if (opp.color === color) continue;
        opp.pieces = opp.pieces.map(p => {
          if (p < 1 || p > 52) return p;
          return absIdx(opp.color, p) === landIdx ? 0 : p;
        });
      }
    }
  }

  if (player.pieces.every(p => p === 59)) {
    st.phase = 'game_over';
    st.winner = { id: player.id, name: player.name };
  }

  return st;
}

export function nextTurn(state) {
  const st = JSON.parse(JSON.stringify(state));
  const n = st.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (st.currentPlayerIndex + i) % n;
    if (st.players[idx].pieces.some(p => p !== 59)) {
      st.currentPlayerIndex = idx;
      break;
    }
  }
  st.diceValue    = null;
  st.diceRolled   = false;
  st.diceRolling  = false;
  st.movablePieces = [];
  st.lastMoved    = null;
  return st;
}
