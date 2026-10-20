/* The game owns the canvas; this page only handles loading and browser UI. */
const canvas = document.getElementById('canvas');
const statusLabel = document.getElementById('status');
const playButton = document.getElementById('play');
const playerName = document.getElementById('player-name');
const progress = document.querySelector('.progress');
const progressFill = document.getElementById('progress-fill');
// Versioned assets can live separately from the stable, same-origin gateway.
const launchOptions = new URLSearchParams(location.search);
const networkBase = new URL(launchOptions.get('network') || './', location.href);
if (networkBase.origin !== location.origin) throw new Error('The game gateway must be same-origin');
if (launchOptions.get('embedded') === '1') document.documentElement.classList.add('embedded');
const gateway = new URL('game', networkBase);
gateway.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
let started = false;
let offeredServers = [];
let serverRequest = 0;
let selectedServer = null;
let runtimeReady = false;
let clientProtocol = -1;
let resizeTimer = 0;

function browserGameSize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  // Render at the viewport's native CSS-pixel size whenever possible. Scaling
  // every desktop viewport down to the 800x600 minimum and stretching it back
  // with CSS makes small HUD text visibly blurry at fractional scale factors.
  // Smaller viewports still retain the game's minimum dimensions and aspect
  // ratio so the interface remains usable and mouse coordinates stay aligned.
  const scale = Math.max(1, 800 / width, 600 / height);
  return [Math.round(width * scale), Math.round(height * scale)];
}

function resizeGameToViewport() {
  if (!started) return;
  const [width, height] = browserGameSize();
  Module.ccall('netpanzer_web_resize', 'number', ['number', 'number'], [width, height]);
}

function queueGameResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeGameToViewport, 100);
}

function setProgress(value) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  progressFill.style.width = `${percent}%`;
  progress.setAttribute('aria-valuenow', String(percent));
}

function setLoadingStatus(text) {
  const match = text.match(/^(.*?)\s*\((\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\)/);
  if (!match) {
    statusLabel.textContent = text;
    return;
  }
  const loaded = Number(match[2]);
  const total = Number(match[3]);
  const action = match[1].replace(/\.+$/, '').trim();
  const megabytes = bytes => (bytes / 1048576).toFixed(1);
  statusLabel.textContent = /download/i.test(action) && total > 100000
    ? `Downloading game data — ${megabytes(loaded)} of ${megabytes(total)} MB`
    : `${action} — ${Math.round(loaded / total * 100)}%`;
  if (total > 0) setProgress(loaded / total);
}

const storedName = localStorage.getItem('netpanzer.playerName');
playerName.value = storedName || `Player${Math.floor(1000 + Math.random() * 9000)}`;

function validPlayerName() {
  return /^[A-Za-z0-9 _-]{1,20}$/.test(playerName.value.trim());
}

function updatePlayState() {
  if (!runtimeReady || started) return;
  const valid = validPlayerName();
  playerName.setAttribute('aria-invalid', String(!valid));
  playButton.disabled = !valid || !selectedServer;
}

function chooseServer(servers) {
  const candidates = servers.filter(server => server.running && !server.password && !server.auth &&
    (server.protocol < 0 || server.protocol === clientProtocol) &&
    (server.maxplayers < 0 || server.players < server.maxplayers));
  candidates.sort((a, b) => {
    const aPopulated = a.players > 0 ? 1 : 0;
    const bPopulated = b.players > 0 ? 1 : 0;
    if (aPopulated !== bPopulated) return bPopulated - aPopulated;
    const aPlayers = a.players < 0 ? 0 : a.players;
    const bPlayers = b.players < 0 ? 0 : b.players;
    if (aPlayers !== bPlayers) return bPlayers - aPlayers;
    const aPing = a.ping < 0 ? Number.MAX_SAFE_INTEGER : a.ping;
    const bPing = b.ping < 0 ? Number.MAX_SAFE_INTEGER : b.ping;
    return aPing - bPing || a.id.localeCompare(b.id);
  });
  return candidates[0] || null;
}

async function prepareMatch() {
  selectedServer = null;
  playButton.disabled = true;
  playButton.textContent = 'Finding match…';
  statusLabel.textContent = 'Finding an available Outiva battlefield…';
  try {
    const response = await fetch(new URL('servers', networkBase), { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Matchmaking is unavailable');
    offeredServers = await response.json();
    selectedServer = chooseServer(offeredServers);
    if (!selectedServer) throw new Error('No battlefield is currently available');
    statusLabel.textContent = `${selectedServer.name} is ready.`;
    setProgress(1);
    playButton.textContent = 'Play NetPanzer';
    updatePlayState();
  } catch (error) {
    statusLabel.textContent = `${error.message}. Click Retry.`;
    playButton.textContent = 'Retry';
    playButton.disabled = false;
  }
}

playerName.addEventListener('input', updatePlayState);
playerName.addEventListener('change', () => {
  const name = playerName.value.trim();
  if (validPlayerName()) localStorage.setItem('netpanzer.playerName', name);
});
var Module = {
  canvas,
  websocket: { url: gateway.href, subprotocol: 'binary' },
  print: (...args) => console.log(...args),
  printErr: (...args) => console.error(...args),
  setStatus: text => { if (!started && text) setLoadingStatus(text); },
  onRuntimeInitialized() {
    runtimeReady = true;
    clientProtocol = Module.ccall('netpanzer_web_protocol', 'number', [], []);
    playerName.disabled = false;
    statusLabel.textContent = 'Locating the best Outiva battlefield…';
    setProgress(1);
    prepareMatch();
  },
  onAbort(reason) {
    document.body.classList.remove('game-running', 'game-launching');
    statusLabel.textContent = `Unable to run the game: ${reason}. Reload to retry.`;
    playButton.disabled = true;
  },
  onGameStatus(text, state) {
    statusLabel.textContent = text;
    statusLabel.dataset.state = state;
    if (state === 'playing') {
      document.body.classList.add('game-running');
      requestAnimationFrame(resizeGameToViewport);
    }
    if (['error', 'disconnected'].includes(state))
      document.body.classList.remove('game-running', 'game-launching');
  },
  async refreshGameServers(request) {
    serverRequest = request;
    try {
      const response = await fetch(new URL('servers', networkBase), { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Server list unavailable');
      const servers = await response.json();
      if (serverRequest !== request) return;
      offeredServers = servers;
      for (const s of servers) {
        Module.ccall('netpanzer_web_server', null,
          ['number', 'string', 'number', 'string', 'string', ...Array(7).fill('number')],
          [request, s.host, s.port, s.name, s.map, s.players, s.maxplayers, s.ping,
            s.protocol, s.password, s.auth, s.running]);
      }
      Module.ccall('netpanzer_web_servers_done', null, ['number', 'string'],
        [request, 'No compatible servers found. Try Refresh or enter a server address.']);
      Module.onGameStatus('Choose a server, enter your player name, then click Play.', 'menu');
    } catch (error) {
      if (serverRequest !== request) return;
      Module.ccall('netpanzer_web_servers_done', null, ['number', 'string'],
        [request, 'Server list unavailable. Click Refresh to retry.']);
      Module.onGameStatus('Server list unavailable. Click Refresh to retry.', 'menu');
    }
  },
  cancelGameServerRefresh() { serverRequest = 0; },
  selectGameServer(address) {
    const server = offeredServers.find(s => address === `${s.host}:${s.port}` ||
      (s.port === 3030 && address === s.host));
    if (!server) {
      if (launchOptions.get('public') === '1' && /^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(address)) {
        const destination = address.includes(':') ? address : `${address}:3030`;
        gateway.search = new URLSearchParams({ server: destination }).toString();
        Module.websocket.url = gateway.href;
        Module.onGameStatus('Enter the server password, or leave it blank, then click OK.', 'menu');
        return 2;
      }
      Module.onGameStatus('Select a server from this website\'s list. Other addresses are not supported.', 'menu');
      return false;
    }
    gateway.search = new URLSearchParams({ server: server.id }).toString();
    Module.websocket.url = gateway.href;
    return server.password ? 2 : 1;
  },
  onGameExit() {
    serverRequest = 0;
    document.body.classList.remove('game-running', 'game-launching');
    if (!['error', 'disconnected'].includes(statusLabel.dataset.state))
      statusLabel.textContent = 'Session ended.';
    playButton.textContent = 'Play again';
    playButton.disabled = false;
    playButton.onclick = () => location.reload();
  },
};
// Keep the canvas's CSS box aligned with its pixels, including letterboxed
// fullscreen and in-game resolution changes, so SDL maps the mouse correctly.
const updateAspect = () => canvas.style.setProperty('--game-ratio', canvas.width / canvas.height);
new MutationObserver(updateAspect).observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
updateAspect();
canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }));
canvas.addEventListener('keydown', event => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Tab', 'F1'].includes(event.key)) event.preventDefault();
});
playButton.onclick = () => {
  if (started) return;
  if (!selectedServer) {
    prepareMatch();
    return;
  }
  const name = playerName.value.trim();
  if (!validPlayerName()) {
    statusLabel.textContent = 'Use 1–20 letters, numbers, spaces, underscores, or hyphens.';
    playerName.focus();
    updatePlayState();
    return;
  }
  started = true;
  document.body.classList.add('game-launching');
  localStorage.setItem('netpanzer.playerName', name);
  playButton.disabled = true;
  playButton.textContent = 'Playing';
  const address = `${selectedServer.host}:${selectedServer.port}`;
  gateway.search = new URLSearchParams({ server: selectedServer.id }).toString();
  Module.websocket.url = gateway.href;
  Module.onGameStatus(`Connecting to ${selectedServer.name}…`, 'connecting');
  canvas.focus({ preventScroll: true });
  try {
    Module.callMain(['--master_server=none', `--connect=${address}`, `--player_name=${name}`]);
    resizeGameToViewport();
  } catch (error) {
    Module.onAbort(error.message || error);
  }
};
document.getElementById('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await canvas.parentElement.requestFullscreen();
    canvas.focus({ preventScroll: true });
  } catch (error) { statusLabel.textContent = `Fullscreen unavailable: ${error.message}`; }
};
document.addEventListener('fullscreenchange', () => {
  const fullscreenButton = document.getElementById('fullscreen');
  fullscreenButton.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen ↗';
  fullscreenButton.setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen');
  requestAnimationFrame(resizeGameToViewport);
});
window.addEventListener('resize', queueGameResize);
window.addEventListener('error', event => Module.onAbort(event.message || 'Download failed'));
