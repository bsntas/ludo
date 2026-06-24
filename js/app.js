import { joinRoom, selfId } from 'https://esm.sh/trystero@0.21.0/mqtt';
import { buildBoard, renderPieces } from './board.js';
import { rollDice, getMovablePieces, movePiece, nextTurn } from './ludo-engine.js';

const APP_ID      = 'bsntas-ludo-v1';
const ROOM_CONFIG = { appId: APP_ID, brokerUrl: 'wss://broker.hivemq.com:8884/mqtt' };
const COLOR_ORDER = ['red', 'blue', 'green', 'yellow'];
const DICE_FACES  = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

class LudoApp {
  constructor() {
    this.myName      = '';
    this.myColor     = 'red';
    this.isHost      = false;
    this.trRoom      = null;
    this.sendMsg     = null;
    this.hostPeerId  = null;
    this.roomCode    = null;
    this.publicState = null;
    this._toastTimer = null;
    this._heartbeatInterval = null;
    this._reconnecting = false;
    this._lobbyPlayers = [];
    this._boardBuilt = false;
    this.bindUI();
  }

  genCode() { return Math.random().toString(36).substr(2, 6).toUpperCase(); }

  showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + id).classList.add('active');
  }

  showToast(msg, type = 'info') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className   = 'toast show toast-' + type;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }

  takenColors() { return this._lobbyPlayers.map(p => p.color); }

  // ─── Host flow

  createGame() {
    const name = document.getElementById('player-name').value.trim();
    if (!name) { this.showToast('Enter your name', 'error'); return; }
    this.myName  = name;
    this.isHost  = true;
    this._lobbyPlayers = [{ id: selfId, name, color: this.myColor }];
    const code = this.genCode();
    this.roomCode = code;
    this.trRoom = joinRoom(ROOM_CONFIG, code);
    const [sendMsg, onMsg] = this.trRoom.makeAction('msg');
    this.sendMsg = sendMsg;
    this._heartbeatInterval = setInterval(() => { if (this.trRoom) this._broadcastLobby(); }, 25000);
    this.trRoom.onPeerJoin(peerId => sendMsg({ type: 'host-hello', name: this.myName, color: this.myColor }, peerId));
    this.trRoom.onPeerLeave(peerId => {
      const pl = this._lobbyPlayers.find(p => p.id === peerId);
      if (!pl) return;
      if (this.publicState?.phase === 'playing') { this.showToast(`${pl.name} disconnected`, 'warn'); return; }
      this._lobbyPlayers = this._lobbyPlayers.filter(p => p.id !== peerId);
      this.showToast(`${pl.name} left the lobby`, 'warn');
      this._broadcastLobby();
      this.renderLobbyPlayers();
    });
    onMsg((data, peerId) => {
      if (!this.isHost) return;
      if (data.type === 'guest-join') {
        if (this._lobbyPlayers.length >= 4) { sendMsg({ type:'error', message:'Room is full (max 4)', fatal:true }, peerId); return; }
        if (this._lobbyPlayers.find(p => p.name.toLowerCase() === data.name.toLowerCase())) { sendMsg({ type:'error', message:'Name already taken', fatal:true }, peerId); return; }
        let color = data.color;
        const taken = this.takenColors();
        if (taken.includes(color)) color = COLOR_ORDER.find(c => !taken.includes(c)) || 'red';
        this._lobbyPlayers.push({ id: peerId, name: data.name, color });
        this._broadcastLobby();
        this.renderLobbyPlayers();
        return;
      }
      if (data.type === 'action') { this._handleAction(peerId, data); return; }
      if (data.type === 'ping')   { this._broadcastLobby(); }
    });
    this.showScreen('lobby');
    document.getElementById('room-code-display').textContent = code;
    document.getElementById('btn-start').style.display   = '';
    document.getElementById('waiting-text').style.display = 'none';
    this.saveSession();
    this.renderLobbyPlayers();
  }

  _broadcastLobby() {
    if (!this.sendMsg) return;
    const state = { type: 'lobby-state', players: this._lobbyPlayers };
    for (const p of this._lobbyPlayers) if (p.id !== selfId) this.sendMsg(state, p.id);
  }

  _broadcastGameState() {
    if (!this.sendMsg || !this.publicState) return;
    for (const p of this.publicState.players) {
      if (p.id !== selfId) this.sendMsg({ type: 'game-state', state: this.publicState }, p.id);
    }
    this._renderGame();
  }

  // ─── Guest flow

  joinGame() {
    const name = document.getElementById('player-name').value.trim();
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (!name) { this.showToast('Enter your name', 'error'); return; }
    if (!code) { this.showToast('Enter a room code', 'error'); return; }
    this.myName = name; this.isHost = false; this.hostPeerId = null;
    const btnJoin = document.getElementById('btn-join');
    btnJoin.disabled = true; btnJoin.textContent = 'Searching…';
    this.trRoom = joinRoom(ROOM_CONFIG, code);
    const [sendMsg, onMsg] = this.trRoom.makeAction('msg');
    this.sendMsg = sendMsg;
    const joinTimeout = setTimeout(() => {
      if (!this.hostPeerId) {
        this.showToast(`Room "${code}" not found`, 'error');
        btnJoin.disabled = false; btnJoin.textContent = 'Join →';
        this.trRoom?.leave?.(); this.trRoom = null;
      }
    }, 30000);
    this.trRoom.onPeerLeave(peerId => {
      if (peerId === this.hostPeerId) { this.showToast('Host disconnected — reconnecting…', 'warn'); this._attemptReconnect(); }
    });
    onMsg((data, peerId) => {
      if (this.isHost) return;
      if (data.type === 'host-hello' && !this.hostPeerId) {
        clearTimeout(joinTimeout);
        this.hostPeerId = peerId; this.roomCode = code;
        sendMsg({ type: 'guest-join', name: this.myName, color: this.myColor }, peerId);
        this.showScreen('lobby');
        document.getElementById('room-code-display').textContent  = code;
        document.getElementById('btn-start').style.display   = 'none';
        document.getElementById('waiting-text').style.display = '';
        btnJoin.disabled = false; btnJoin.textContent = 'Join →';
        this.saveSession();
        return;
      }
      if (peerId !== this.hostPeerId) return;
      if (data.type === 'lobby-state') {
        this._lobbyPlayers = data.players;
        const me = data.players.find(p => p.id === selfId);
        if (me) this.myColor = me.color;
        this.renderLobbyPlayers();
        return;
      }
      if (data.type === 'game-state') {
        this.publicState = data.state;
        this._enterGameScreen();
        return;
      }
      if (data.type === 'error') {
        this.showToast(data.message, 'error');
        if (data.fatal) { btnJoin.disabled = false; btnJoin.textContent = 'Join →'; this.trRoom?.leave?.(); this.trRoom = null; }
      }
    });
  }

  _attemptReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    const code = this.roomCode, name = this.myName;
    try { this.trRoom?.leave?.(); } catch (_) {}
    this.trRoom = null; this.sendMsg = null; this.hostPeerId = null;
    setTimeout(() => {
      this._reconnecting = false;
      document.getElementById('player-name').value     = name;
      document.getElementById('room-code-input').value = code;
      this.joinGame();
    }, 2000);
  }

  // ─── Lobby

  renderLobbyPlayers() {
    const players = this._lobbyPlayers;
    document.getElementById('player-list').innerHTML = players.map((p, i) => `
      <div class="lobby-player">
        <div class="player-color-dot pcd-${p.color}"></div>
        <span class="lobby-player-name">${escHtml(p.name)}</span>
        ${i === 0 ? '<span class="host-chip">HOST</span>' : ''}
      </div>`).join('');
    document.getElementById('player-count').textContent = `${players.length} / 4 players`;
    if (this.isHost) {
      const ok = players.length >= 2;
      document.getElementById('btn-start').textContent = ok ? 'Start Game' : 'Waiting for players…';
      document.getElementById('btn-start').disabled    = !ok;
    }
  }

  // ─── Game start

  startGame() {
    if (!this.isHost) return;
    if (this._lobbyPlayers.length < 2) { this.showToast('Need at least 2 players', 'error'); return; }
    this.publicState = {
      phase: 'playing',
      players: this._lobbyPlayers.map(p => ({ ...p, pieces: [0,0,0,0] })),
      currentPlayerIndex: 0,
      diceValue: null,
      diceRolled: false,
      diceRolling: false,
      movablePieces: [],
      lastMoved: null,
      lastAction: 'Game started! Roll the dice.',
      winner: null,
    };
    this._broadcastGameState();
    this._enterGameScreen();
  }

  _enterGameScreen() {
    this.showScreen('game');
    if (!this._boardBuilt) {
      buildBoard(document.getElementById('ludo-board'));
      this._boardBuilt = true;
    }
    this._renderGame();
  }

  // ─── Game engine (host only)

  _handleAction(playerId, data) {
    if (!this.publicState || this.publicState.phase !== 'playing') return;
    const st  = this.publicState;
    const cur = st.players[st.currentPlayerIndex];
    if (cur.id !== playerId) return;

    const act = data.action || data.type;

    if (act === 'roll') {
      if (st.diceRolled || st.diceRolling) return;
      const dice    = rollDice();
      const movable = getMovablePieces(st, cur.color, dice);

      st.diceRolling   = true;
      st.diceRolled    = false;
      st.diceValue     = null;
      st.lastAction    = `${cur.name} is rolling…`;
      st.movablePieces = [];
      st.lastMoved     = null;
      this.publicState = st;
      this._broadcastGameState();

      setTimeout(() => {
        const s = this.publicState;
        if (!s || s.phase !== 'playing') return;
        s.diceRolling    = false;
        s.diceValue      = dice;
        s.diceRolled     = true;
        s.lastAction     = `${cur.name} rolled a ${dice}`;
        s.movablePieces  = movable.map(idx => ({ color: cur.color, idx }));
        this.publicState = s;
        this._broadcastGameState();
        if (movable.length === 0) {
          setTimeout(() => {
            if (!this.publicState || this.publicState.phase !== 'playing') return;
            this.publicState = nextTurn(this.publicState);
            this.publicState.lastAction = `${cur.name} rolled ${dice} — no moves, turn passed`;
            this._broadcastGameState();
          }, 1500);
        }
      }, 550);
      return;
    }

    if (act === 'move') {
      if (!st.diceRolled || st.diceRolling) return;
      const { pieceIdx } = data;
      if (pieceIdx === undefined || pieceIdx === null) return;
      const movable = getMovablePieces(st, cur.color, st.diceValue);
      if (!movable.includes(pieceIdx)) return;

      const dice = st.diceValue;
      const prevOpp = {};
      for (const opp of st.players) {
        if (opp.color !== cur.color) prevOpp[opp.color] = [...opp.pieces];
      }

      let newSt = movePiece(st, cur.color, pieceIdx, dice);
      const newPos = newSt.players.find(p => p.color === cur.color).pieces[pieceIdx];

      const captured = [];
      for (const opp of newSt.players) {
        if (opp.color === cur.color) continue;
        opp.pieces.forEach((pos, i) => {
          if (prevOpp[opp.color][i] !== 0 && pos === 0) captured.push(opp.name);
        });
      }

      let msg = `${cur.name} moved piece ${pieceIdx + 1}`;
      if (captured.length) msg += ` — captured ${captured.join(' & ')}!`;
      if (newPos === 59)   msg += ' — reached home!';

      newSt.lastAction    = msg;
      newSt.movablePieces = [];
      newSt.lastMoved     = { color: cur.color, idx: pieceIdx };

      if (newSt.phase === 'game_over') {
        this.publicState = newSt;
        this._broadcastGameState();
        return;
      }

      if (dice === 6) {
        newSt.diceValue   = null;
        newSt.diceRolled  = false;
        newSt.diceRolling = false;
        newSt.lastAction += ' — rolled 6, play again!';
      } else {
        const savedMsg = newSt.lastAction;
        newSt = nextTurn(newSt);
        newSt.lastAction = savedMsg;
      }

      this.publicState = newSt;
      this._broadcastGameState();
      return;
    }

    if (act === 'pass') {
      if (!st.diceRolled || st.diceRolling) return;
      const name = cur.name, dice = st.diceValue;
      this.publicState = nextTurn(st);
      this.publicState.lastAction = `${name} passed (rolled ${dice})`;
      this._broadcastGameState();
    }
  }

  sendAction(type, payload = {}) {
    if (this.isHost) {
      this._handleAction(selfId, { type, ...payload });
    } else if (this.hostPeerId && this.sendMsg) {
      this.sendMsg({ type: 'action', action: type, ...payload }, this.hostPeerId);
    }
  }

  // ─── Rendering

  _renderGame() {
    const st = this.publicState;
    if (!st) return;
    const myIdx    = st.players.findIndex(p => p.id === selfId);
    const isMyTurn = st.currentPlayerIndex === myIdx;
    const cur      = st.players[st.currentPlayerIndex];

    const badge = document.getElementById('turn-badge');
    badge.textContent = isMyTurn ? '✨ Your Turn!' : `${cur?.name || ''}'s Turn`;
    badge.className   = 'turn-badge' + (isMyTurn ? ' my-turn' : '');
    document.getElementById('last-action').textContent = st.lastAction || '';

    const chip = document.getElementById('dice-chip');
    if (st.diceRolling) {
      chip.textContent   = '🎲';
      chip.style.display = '';
      chip.className     = 'dice-chip rolling';
      chip.dataset.val   = '';
    } else if (st.diceValue) {
      const newVal = String(st.diceValue);
      chip.textContent   = DICE_FACES[st.diceValue] || st.diceValue;
      chip.style.display = '';
      if (chip.dataset.val !== newVal) {
        chip.className   = 'dice-chip landed';
        chip.dataset.val = newVal;
        setTimeout(() => { if (chip.classList.contains('landed')) chip.className = 'dice-chip'; }, 450);
      }
    } else {
      chip.style.display = 'none';
      chip.className     = 'dice-chip';
      chip.dataset.val   = '';
    }

    document.getElementById('btn-roll').disabled =
      !isMyTurn || st.diceRolled || st.diceRolling;
    document.getElementById('btn-pass').style.display =
      (isMyTurn && st.diceRolled && !st.diceRolling) ? '' : 'none';

    const movable = (isMyTurn && st.diceRolled && !st.diceRolling)
      ? (st.movablePieces || []) : [];
    const onPieceClick = isMyTurn
      ? (color, idx) => this.sendAction('move', { pieceIdx: idx })
      : null;
    const boardEl = document.getElementById('ludo-board');
    renderPieces(boardEl, st.players, movable, onPieceClick);

    if (st.lastMoved) {
      const { color, idx } = st.lastMoved;
      const pieceEl = boardEl.querySelector(`.piece-${color}[data-idx="${idx}"]`);
      if (pieceEl) {
        pieceEl.classList.remove('just-moved');
        void pieceEl.offsetWidth;
        pieceEl.classList.add('just-moved');
      }
    }

    if (st.phase === 'game_over') this._showGameOver();
  }

  _showGameOver() {
    const st  = this.publicState;
    const won = st.winner?.id === selfId;
    document.getElementById('go-title').textContent = won ? '🏆 You Win!' : 'Game Over!';
    document.getElementById('go-msg').textContent   = won
      ? 'You got all 4 pieces home first!'
      : `${st.winner?.name || 'Someone'} won the game!`;
    document.getElementById('modal-gameover').classList.add('visible');
    if (won) this._launchConfetti();
  }

  _launchConfetti() {
    const c = document.getElementById('confetti-container');
    if (!c) return;
    c.innerHTML = '';
    const cols = ['#f5c842','#e53e3e','#3182ce','#38a169','#d69e2e','#fff','#ff88cc','#88ffee'];
    for (let i = 0; i < 72; i++) {
      const el = document.createElement('div');
      el.className = 'confetti-piece';
      el.style.setProperty('--cdur',   (1.6 + Math.random() * 2.2).toFixed(2) + 's');
      el.style.setProperty('--cdelay', (Math.random() * 1.4).toFixed(2) + 's');
      el.style.left       = (Math.random() * 100) + '%';
      el.style.background = cols[Math.floor(Math.random() * cols.length)];
      el.style.width      = (6 + Math.random() * 8) + 'px';
      el.style.height     = (6 + Math.random() * 8) + 'px';
      el.style.borderRadius = Math.random() > .4 ? '50%' : '2px';
      c.appendChild(el);
    }
    setTimeout(() => { c.innerHTML = ''; }, 5200);
  }

  playAgain() {
    document.getElementById('modal-gameover').classList.remove('visible');
    if (this.isHost) {
      this.publicState = null;
      this._lobbyPlayers = this._lobbyPlayers.map(p => ({ id: p.id, name: p.name, color: p.color }));
      this._broadcastLobby();
      this.showScreen('lobby');
      this.renderLobbyPlayers();
    }
  }

  saveSession() {
    if (!this.roomCode) return;
    try { sessionStorage.setItem('ludo-session', JSON.stringify({ roomCode: this.roomCode, playerName: this.myName, playerColor: this.myColor, isHost: this.isHost })); } catch (_) {}
  }

  bindUI() {
    const $ = id => document.getElementById(id);
    document.querySelectorAll('.color-pick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.color-pick-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.myColor = btn.dataset.color;
      });
    });
    $('btn-create').addEventListener('click',     () => this.createGame());
    $('btn-join').addEventListener('click',       () => this.joinGame());
    $('player-name').addEventListener('keydown',  e => { if (e.key==='Enter') { const c=$('room-code-input').value.trim(); if(c) this.joinGame(); else this.createGame(); } });
    $('room-code-input').addEventListener('keydown', e => { if (e.key==='Enter') this.joinGame(); });
    $('btn-copy').addEventListener('click', () => {
      const code = $('room-code-display').textContent;
      navigator.clipboard.writeText(code).then(() => this.showToast('Room code copied!')).catch(() => this.showToast('Code: ' + code));
    });
    $('btn-start').addEventListener('click',      () => this.startGame());
    $('btn-roll').addEventListener('click',       () => this.sendAction('roll'));
    $('btn-pass').addEventListener('click',       () => this.sendAction('pass'));
    $('btn-play-again').addEventListener('click', () => this.playAgain());
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new LudoApp();
  const $ = id => document.getElementById(id);
  try {
    const raw = sessionStorage.getItem('ludo-session');
    if (raw) {
      const { roomCode, playerName, playerColor, isHost } = JSON.parse(raw);
      if (playerName) $('player-name').value = playerName;
      if (playerColor) {
        document.querySelectorAll('.color-pick-btn').forEach(b => b.classList.toggle('active', b.dataset.color === playerColor));
        window.app.myColor = playerColor;
      }
      if (!isHost && roomCode) { $('room-code-input').value = roomCode; window.app.showToast(`Tap "Join →" to rejoin ${roomCode}`, 'info'); }
    }
  } catch (_) { sessionStorage.removeItem('ludo-session'); }
});
