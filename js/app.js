import { joinRoom, selfId } from 'https://esm.sh/trystero@0.21.0/mqtt';

const APP_ID      = 'bsntas-ludo-v1';
const ROOM_CONFIG = {
  appId:     APP_ID,
  brokerUrl: 'wss://broker.hivemq.com:8884/mqtt',
};

const COLOR_ORDER = ['red', 'blue', 'green', 'yellow'];

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
    // players: [{ id, name, color }]
    this._lobbyPlayers = [];
    this.bindUI();
  }

  // ─── Utilities ───────────────────────────────────────────────

  genCode() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
  }

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

  takenColors() {
    return this._lobbyPlayers.map(p => p.color);
  }

  // ─── Host flow ───────────────────────────────────────────────

  createGame() {
    const name = document.getElementById('player-name').value.trim();
    if (!name) { this.showToast('Enter your name', 'error'); return; }

    this.myName  = name;
    this.isHost  = true;
    this._lobbyPlayers = [{ id: selfId, name, color: this.myColor }];

    const code    = this.genCode();
    this.roomCode = code;

    this.trRoom = joinRoom(ROOM_CONFIG, code);
    const [sendMsg, onMsg] = this.trRoom.makeAction('msg');
    this.sendMsg = sendMsg;

    // Keep MQTT alive
    this._heartbeatInterval = setInterval(() => {
      if (this.trRoom) this._broadcastLobby();
    }, 25000);

    this.trRoom.onPeerJoin(peerId => {
      sendMsg({ type: 'host-hello', name: this.myName, color: this.myColor }, peerId);
    });

    this.trRoom.onPeerLeave(peerId => {
      const pl = this._lobbyPlayers.find(p => p.id === peerId);
      if (!pl) return;
      this._lobbyPlayers = this._lobbyPlayers.filter(p => p.id !== peerId);
      this.showToast(`${pl.name} left the lobby`, 'warn');
      this._broadcastLobby();
      this.renderLobbyPlayers();
    });

    onMsg((data, peerId) => {
      if (!this.isHost) return;

      if (data.type === 'guest-join') {
        if (this._lobbyPlayers.length >= 4) {
          sendMsg({ type: 'error', message: 'Room is full (max 4)', fatal: true }, peerId);
          return;
        }
        if (this._lobbyPlayers.find(p => p.name.toLowerCase() === data.name.toLowerCase())) {
          sendMsg({ type: 'error', message: 'Name already taken', fatal: true }, peerId);
          return;
        }
        // Resolve color conflict
        let color = data.color;
        const taken = this.takenColors();
        if (taken.includes(color)) {
          color = COLOR_ORDER.find(c => !taken.includes(c)) || 'red';
        }
        this._lobbyPlayers.push({ id: peerId, name: data.name, color });
        this._broadcastLobby();
        this.renderLobbyPlayers();
        return;
      }

      if (data.type === 'ping') {
        this._broadcastLobby();
      }
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
    for (const p of this._lobbyPlayers) {
      if (p.id !== selfId) this.sendMsg(state, p.id);
    }
  }

  // ─── Guest flow ──────────────────────────────────────────────

  joinGame() {
    const name = document.getElementById('player-name').value.trim();
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (!name) { this.showToast('Enter your name', 'error'); return; }
    if (!code) { this.showToast('Enter a room code', 'error'); return; }

    this.myName     = name;
    this.isHost     = false;
    this.hostPeerId = null;

    const btnJoin = document.getElementById('btn-join');
    btnJoin.disabled    = true;
    btnJoin.textContent = 'Searching…';

    this.trRoom = joinRoom(ROOM_CONFIG, code);
    const [sendMsg, onMsg] = this.trRoom.makeAction('msg');
    this.sendMsg = sendMsg;

    const joinTimeout = setTimeout(() => {
      if (!this.hostPeerId) {
        this.showToast(`Room "${code}" not found — check the code and retry`, 'error');
        btnJoin.disabled    = false;
        btnJoin.textContent = 'Join →';
        this.trRoom?.leave?.();
        this.trRoom = null;
      }
    }, 30000);

    this.trRoom.onPeerLeave(peerId => {
      if (peerId === this.hostPeerId) {
        this.showToast('Host disconnected — reconnecting…', 'warn');
        this._attemptReconnect();
      }
    });

    onMsg((data, peerId) => {
      if (this.isHost) return;

      if (data.type === 'host-hello' && !this.hostPeerId) {
        clearTimeout(joinTimeout);
        this.hostPeerId = peerId;
        this.roomCode   = code;
        sendMsg({ type: 'guest-join', name: this.myName, color: this.myColor }, peerId);
        this.showScreen('lobby');
        document.getElementById('room-code-display').textContent  = code;
        document.getElementById('btn-start').style.display   = 'none';
        document.getElementById('waiting-text').style.display = '';
        btnJoin.disabled    = false;
        btnJoin.textContent = 'Join →';
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
        this.showScreen('game');
        // renderGame() wired in Step 4
        return;
      }

      if (data.type === 'error') {
        this.showToast(data.message, 'error');
        if (data.fatal) {
          btnJoin.disabled    = false;
          btnJoin.textContent = 'Join →';
          this.trRoom?.leave?.();
          this.trRoom = null;
        }
      }
    });
  }

  _attemptReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    const code = this.roomCode;
    const name = this.myName;
    try { this.trRoom?.leave?.(); } catch (_) {}
    this.trRoom     = null;
    this.sendMsg    = null;
    this.hostPeerId = null;
    setTimeout(() => {
      this._reconnecting = false;
      document.getElementById('player-name').value     = name;
      document.getElementById('room-code-input').value = code;
      this.joinGame();
    }, 2000);
  }

  // ─── Lobby rendering ─────────────────────────────────────────

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
      const canStart = players.length >= 2;
      document.getElementById('btn-start').textContent = canStart ? 'Start Game' : 'Waiting for players…';
      document.getElementById('btn-start').disabled    = !canStart;
    }
  }

  // ─── Start (host only) ───────────────────────────────────────

  startGame() {
    if (!this.isHost) return;
    if (this._lobbyPlayers.length < 2) {
      this.showToast('Need at least 2 players', 'error');
      return;
    }
    // Game engine wired in Step 3/4 — placeholder transition for now
    const state = { phase: 'playing', players: this._lobbyPlayers };
    for (const p of this._lobbyPlayers) {
      if (p.id !== selfId) this.sendMsg({ type: 'game-state', state }, p.id);
    }
    this.publicState = state;
    this.showScreen('game');
  }

  // ─── Session persistence ─────────────────────────────────────

  saveSession() {
    if (!this.roomCode) return;
    try {
      sessionStorage.setItem('ludo-session', JSON.stringify({
        roomCode:    this.roomCode,
        playerName:  this.myName,
        playerColor: this.myColor,
        isHost:      this.isHost,
      }));
    } catch (_) {}
  }

  // ─── UI bindings ─────────────────────────────────────────────

  bindUI() {
    const $ = id => document.getElementById(id);

    document.querySelectorAll('.color-pick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.color-pick-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.myColor = btn.dataset.color;
      });
    });

    $('btn-create').addEventListener('click', () => this.createGame());
    $('btn-join').addEventListener('click',   () => this.joinGame());

    $('player-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const code = $('room-code-input').value.trim();
        if (code) this.joinGame(); else this.createGame();
      }
    });
    $('room-code-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.joinGame();
    });

    $('btn-copy').addEventListener('click', () => {
      const code = $('room-code-display').textContent;
      navigator.clipboard.writeText(code)
        .then(() => this.showToast('Room code copied!'))
        .catch(() => this.showToast('Code: ' + code));
    });

    $('btn-start').addEventListener('click', () => this.startGame());
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new LudoApp();
  try {
    const raw = sessionStorage.getItem('ludo-session');
    if (raw) {
      const { roomCode, playerName, playerColor, isHost } = JSON.parse(raw);
      if (playerName) $('player-name').value = playerName;
      if (playerColor) {
        document.querySelectorAll('.color-pick-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.color === playerColor);
        });
        window.app.myColor = playerColor;
      }
      if (!isHost && roomCode) {
        $('room-code-input').value = roomCode;
        window.app.showToast(`Tap "Join →" to rejoin ${roomCode}`, 'info');
      }
    }
  } catch (_) {
    sessionStorage.removeItem('ludo-session');
  }

  function $(id) { return document.getElementById(id); }
});
