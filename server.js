// server.js
const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');
const crypto = require('crypto'); // For generating IDs

// --- Server Setup ---
const app = express();
const server = http.createServer(app);
// Enable clientTracking to easily iterate over clients if needed, though we manage players separately
const wss = new WebSocket.Server({ server, clientTracking: true });
const PORT = process.env.PORT || 3000;

console.log(`Lobby server starting on port ${PORT}...`);

// --- Serve the HTML file ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Game Constants ---
const CANVAS_WIDTH = 1200; // Reference size for server logic
const CANVAS_HEIGHT = 800;
const PLAYER_SIZE = 15;
const PLAYER_SPEED = 3.5; // Base speed for keyboard
const OBSTACLE_BASE_SIZE = 25;
const OBSTACLE_BASE_SPEED = 1.5;
const LEVEL_SCORE_THRESHOLD = 150;
const BASE_SPAWN_INTERVAL = 100; // Base milliseconds
const SPEED_LEVEL_MULTIPLIER = 0.20; // e.g., Lvl 2 speed = base * (1 + 1 * 0.20)
const SPAWN_RATE_LEVEL_MULTIPLIER = 0.25; // e.g., Lvl 2 interval = base / (1 + 1 * 0.25)
const SIZE_VARIANCE_LEVEL_MULTIPLIER = 1.5; // Extra random pixels added to max size per level
const RESPAWN_TIMEOUT = 20000; // 20 seconds
const IP_CLEANUP_INTERVAL = 60000; // 1 minute

const COLORS = ['#FF6347', '#4682B4', '#32CD32', '#FFD700', '#6A5ACD', '#FF69B4', '#00CED1', '#FFA07A'];
let globalColorIndex = 0;

// --- Global State ---
let players = {}; // { playerId: { ws, username, ip, lobbyId } } - Global refs
let lobbies = {}; // { lobbyId: { ... lobby state ..., gameLoopInterval, spawnTimer } } - Holds all game instances
let recentlyDeadIPs = {}; // { ipAddress: timestamp }
let MAIN_LOBBY_ID = null; // Will be set after creating the main lobby

// --- Helper Functions ---

function getIpFromConnection(ws, req) {
    const forwarded = req?.headers['x-forwarded-for'];
    let ip = forwarded ? forwarded.split(/, /)[0] : req?.socket?.remoteAddress;
    if (!ip && ws && ws._socket) ip = ws._socket.remoteAddress;
    if (ip && ip.startsWith('::ffff:')) return ip.substring(7);
    return ip || 'unknown';
}

function getRandomColor() {
    const color = COLORS[globalColorIndex % COLORS.length];
    globalColorIndex++;
    return color;
}

function generateLobbyId() {
    return crypto.randomBytes(4).toString('hex');
}

// Send message only to clients in a specific lobby
function broadcastToLobby(lobbyId, data) {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;
    const dataString = JSON.stringify(data);
    Object.keys(lobby.players).forEach(playerId => {
        const player = players[playerId]; // Use global map to find the WS object
        if (player?.ws?.readyState === WebSocket.OPEN) {
            try { player.ws.send(dataString); } catch (e) { console.error(`Broadcast error p ${playerId} l ${lobbyId}: ${e.message}`); }
        }
    });
}

// Send message to a specific client by player ID
function sendToClient(playerId, data) {
    const player = players[playerId];
    if (player?.ws?.readyState === WebSocket.OPEN) {
        try { player.ws.send(JSON.stringify(data)); } catch (e) { console.error(`Direct send error p ${playerId}: ${e.message}`); }
    }
}

// Periodically remove expired IPs from the recently dead list
function cleanupDeadIPs() {
    const now = Date.now();
    Object.keys(recentlyDeadIPs).forEach(ip => {
        if (now - recentlyDeadIPs[ip] > RESPAWN_TIMEOUT) {
            delete recentlyDeadIPs[ip];
        }
    });
}
setInterval(cleanupDeadIPs, IP_CLEANUP_INTERVAL);


// --- Helper to format player data for broadcast ---
function getLobbyPlayersForBroadcast(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby) return {};

    const broadcastPlayers = {};
    Object.keys(lobby.players).forEach(id => {
        const pLobby = lobby.players[id];
        const pGlobal = players[id]; // Need global for username
        if(pLobby && pGlobal) {
            broadcastPlayers[id] = {
                id: id, username: pGlobal.username, x: pLobby.x, y: pLobby.y,
                color: pLobby.color, isAlive: pLobby.isAlive, size: pLobby.size
            };
        }
    });
    return broadcastPlayers;
}

// --- Lobby Management ---

function createLobby(lobbyName, password = null) {
    const lobbyId = generateLobbyId();
    lobbies[lobbyId] = {
        id: lobbyId,
        name: lobbyName,
        password: password, // Store plaintext (INSECURE for production!)
        passwordProtected: !!password,
        players: {}, // { playerId: { x, y, color, isAlive, size, useMouse, mousePos, keys } } - Lobby specific state
        obstacles: [],
        level: 1,
        score: 0,
        gameTimeStart: Date.now(),
        nextObstacleId: 0,
        gameRunning: false,
        gameLoopInterval: null, // ID for the lobby's game loop
        spawnTimer: null,       // ID for the lobby's obstacle spawner
    };
    console.log(`Lobby created: "${lobbyName}" (ID: ${lobbyId})${password ? ' [PW Protected]' : ''}`);
    return lobbies[lobbyId];
}

// Create the default main lobby ONCE at server start
if (MAIN_LOBBY_ID === null) {
    const mainLobby = createLobby("Main Lobby");
    MAIN_LOBBY_ID = mainLobby.id;
    console.log(`Main Lobby ID set to: ${MAIN_LOBBY_ID}`);
}

// Get data for the lobby browser list
function getLobbyList() {
    return Object.values(lobbies).map(lobby => ({ // Create serializable list
        id: lobby.id,
        name: lobby.name,
        playerCount: Object.keys(lobby.players).length,
        passwordProtected: lobby.passwordProtected
    }));
}

// Add a player to a lobby's state
function addPlayerToLobby(playerId, lobbyId) {
    const lobby = lobbies[lobbyId];
    const player = players[playerId]; // Global player ref
    if (!lobby || !player) {
        console.error(`Failed addPlayerToLobby: Lobby ${lobbyId} or Player ${playerId} not found.`);
        return false;
    }

    // Remove from previous lobby if switching (shouldn't happen with current UI flow but good practice)
    if (player.lobbyId && player.lobbyId !== lobbyId && lobbies[player.lobbyId]) {
        console.log(`Player ${playerId} switching lobbies from ${player.lobbyId} to ${lobbyId}`);
        removePlayerFromLobby(playerId, player.lobbyId, false); // Don't record dead IP on switch
    }

    player.lobbyId = lobbyId; // Update global player ref
    lobby.players[playerId] = { // Add lobby-specific state
        x: CANVAS_WIDTH / 2 + (Math.random() - 0.5) * 50,
        y: CANVAS_HEIGHT / 2 + (Math.random() - 0.5) * 50,
        color: getRandomColor(),
        isAlive: true,
        size: PLAYER_SIZE,
        useMouse: false,
        mousePos: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 }, // Initialize mousePos
        keys: {}
    };

    console.log(`Player ${player.username} (${playerId}) successfully added to lobby "${lobby.name}" (${lobbyId}) players.`);
    startGameIfNeeded(lobbyId); // Attempt to start this lobby's game loop if not running
    return true;
}

// Remove player from lobby state and handle empty lobby cleanup
function removePlayerFromLobby(playerId, lobbyId, recordDeadIp = true) {
    const lobby = lobbies[lobbyId];
    // Check if lobby and player-in-lobby exist before proceeding
    if (!lobby || !lobby.players[playerId]) {
        // console.warn(`Attempted removePlayerFromLobby: Player ${playerId} or Lobby ${lobbyId} not found or player not in it.`);
        return;
    }

    const playerGlobal = players[playerId]; // Global ref
    const playerLobby = lobby.players[playerId]; // Lobby ref

    console.log(`Removing player ${playerGlobal?.username || playerId} from lobby "${lobby.name}" (${lobbyId})`);

    // Record IP if player was dead and flag is set
    if (recordDeadIp && playerLobby && !playerLobby.isAlive && playerGlobal?.ip) {
        if (!recentlyDeadIPs[playerGlobal.ip]) { // Avoid redundant logging if already added
            console.log(`Player ${playerGlobal.username} left dead. Adding IP ${playerGlobal.ip} to dead list.`);
            recentlyDeadIPs[playerGlobal.ip] = Date.now();
        }
    }

    delete lobby.players[playerId]; // Remove player from this lobby's list

    if (playerGlobal) playerGlobal.lobbyId = null; // Clear lobby association in global player map

    // Check if lobby is now empty AND it's NOT the main lobby
    if (lobbyId !== MAIN_LOBBY_ID && Object.keys(lobby.players).length === 0) {
        console.log(`Custom lobby "${lobby.name}" (${lobbyId}) is now empty. Removing.`);
        // Ensure intervals are cleared BEFORE deleting the lobby object
        if (lobby.spawnTimer) { clearInterval(lobby.spawnTimer); lobby.spawnTimer = null; }
        if (lobby.gameLoopInterval) { clearInterval(lobby.gameLoopInterval); lobby.gameLoopInterval = null; }
        delete lobbies[lobbyId]; // Remove the lobby itself from the global map
        broadcastLobbyListUpdate(); // Notify lobby browser users immediately of removal
    } else {
        // If lobby is not removed (either main lobby or still has players),
        // check if the game loop should stop (it will if player count is 0)
        stopGameIfEmpty(lobbyId);
    }
}

// --- Per-Lobby Game Logic Functions ---

// Starts the game loop and spawner if lobby isn't empty and not already running
function startGameIfNeeded(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.gameRunning || Object.keys(lobby.players).length === 0) return;

    console.log(`Starting game logic for lobby "${lobby.name}" (${lobbyId})`);
    lobby.gameRunning = true;
    lobby.gameTimeStart = Date.now(); // Reset score timer
    lobby.level = 1; lobby.score = 0; lobby.obstacles = []; // Reset game state
    startSpawning(lobbyId); // Start obstacle spawner for this lobby
    if (!lobby.gameLoopInterval) { // Prevent multiple intervals
        lobby.gameLoopInterval = setInterval(() => gameLoop(lobbyId), 1000 / 60); // ~60 FPS
    }
}

// Stops the game loop and spawner if lobby exists, is running, AND becomes empty
function stopGameIfEmpty(lobbyId) {
    const lobby = lobbies[lobbyId];
    // Stop only if lobby exists, is running, AND is empty
    if (!lobby || !lobby.gameRunning || Object.keys(lobby.players).length > 0) return;

    console.log(`Stopping game logic for empty lobby "${lobby.name}" (${lobbyId})`);
    lobby.gameRunning = false;
    if (lobby.spawnTimer) { clearInterval(lobby.spawnTimer); lobby.spawnTimer = null; }
    if (lobby.gameLoopInterval) { clearInterval(lobby.gameLoopInterval); lobby.gameLoopInterval = null; }
    // Keep lobby state (level/score) or reset? Resetting obstacles is good.
    lobby.obstacles = [];
    // lobby.score = 0; // Optional reset
    // lobby.level = 1; // Optional reset
}

// Starts/Restarts the obstacle spawner for a lobby based on its level
function startSpawning(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby) return; // Lobby doesn't exist
    if (lobby.spawnTimer) clearInterval(lobby.spawnTimer); // Clear previous timer if any

    // Calculate interval based on level - decrease interval (increase rate) as level increases
    const spawnInterval = Math.max(150, BASE_SPAWN_INTERVAL / (1 + (lobby.level - 1) * SPAWN_RATE_LEVEL_MULTIPLIER)); // Ensure minimum interval
    // console.log(`Lobby ${lobbyId}: Spawn interval Lvl ${lobby.level}: ${spawnInterval.toFixed(0)}ms`); // Can be noisy
    lobby.spawnTimer = setInterval(() => spawnObstacle(lobbyId), spawnInterval);
}

// Creates a single obstacle for a specific lobby
function spawnObstacle(lobbyId) {
    const lobby = lobbies[lobbyId];
    // Ensure lobby exists and game is running for it
    if (!lobby || !lobby.gameRunning) return;

    const edge = Math.floor(Math.random() * 4);
    // Increase size variance with level
    const sizeVariance = 20 + (lobby.level * SIZE_VARIANCE_LEVEL_MULTIPLIER);
    const size = OBSTACLE_BASE_SIZE + Math.random() * sizeVariance;
    let x, y, vx, vy;
    // Increase base speed and random component with level
    const speed = (OBSTACLE_BASE_SPEED + Math.random() * 1.0) * (1 + (lobby.level - 1) * SPEED_LEVEL_MULTIPLIER);

    // Determine starting position and velocity based on edge
    switch (edge) {
        case 0: // Top
            x = Math.random() * CANVAS_WIDTH; y = -size;
            vx = (Math.random() - 0.5) * speed; vy = speed; // Allow more horizontal variance
            break;
        case 1: // Right
            x = CANVAS_WIDTH + size; y = Math.random() * CANVAS_HEIGHT;
            vx = -speed; vy = (Math.random() - 0.5) * speed; // Allow more vertical variance
            break;
        case 2: // Bottom
            x = Math.random() * CANVAS_WIDTH; y = CANVAS_HEIGHT + size;
            vx = (Math.random() - 0.5) * speed; vy = -speed; // Allow more horizontal variance
            break;
        default: // Left (case 3)
            x = -size; y = Math.random() * CANVAS_HEIGHT;
            vx = speed; vy = (Math.random() - 0.5) * speed; // Allow more vertical variance
            break;
    }
    lobby.obstacles.push({ id: lobby.nextObstacleId++, x, y, vx, vy, size, color: '#ff4444' });
}

// --- The Main Game Loop (Runs PER Lobby via setInterval) ---
function gameLoop(lobbyId) {
    const lobby = lobbies[lobbyId];
    // Safety check: If lobby disappeared or loop shouldn't run, stop the interval
    if (!lobby || !lobby.gameRunning) {
        if (lobby && lobby.gameLoopInterval) { // Check if interval ID exists
            console.warn(`Stopping orphaned game loop for lobby ${lobbyId}`);
            clearInterval(lobby.gameLoopInterval);
            lobby.gameLoopInterval = null; // Ensure ID is cleared
        } else if (!lobby) {
             // If lobby is gone, we can't clear interval using lobby ref, needs different approach if this becomes an issue
             // console.error(`gameLoop called for non-existent lobby ${lobbyId}! Interval may leak.`); // Can be noisy
        }
        return;
    }

    const now = Date.now();

    // --- Update Score ---
    if (Object.values(lobby.players).some(p => p.isAlive)) {
       lobby.score = Math.floor((now - lobby.gameTimeStart) / 100);
    } else {
        lobby.gameTimeStart = now - (lobby.score * 100); // Pause score
    }

    // --- Level Up Check ---
    const neededScore = lobby.level * LEVEL_SCORE_THRESHOLD;
    if (lobby.score >= neededScore) {
        lobby.level++;
        console.log(`Lobby ${lobbyId}: LEVEL UP! Reached Level ${lobby.level}`);
        startSpawning(lobbyId); // Adjust spawner
        broadcastToLobby(lobbyId, { type: 'levelUp', newLevel: lobby.level });
    }

    // --- Update Obstacles ---
    lobby.obstacles = lobby.obstacles.filter(o => {
        o.x += o.vx;
        o.y += o.vy;
        return o.x > -o.size * 3 && o.x < CANVAS_WIDTH + o.size * 3 &&
               o.y > -o.size * 3 && o.y < CANVAS_HEIGHT + o.size * 3;
    });

    // --- Player Update & Collision Detection ---
    const playerIdsInLobby = Object.keys(lobby.players);

    // 1. Player vs Obstacle Collision
    playerIdsInLobby.forEach(playerId => {
        const playerLobby = lobby.players[playerId];
        const playerGlobal = players[playerId];
        if (!playerLobby || !playerLobby.isAlive || !playerGlobal) return;

        for (const obstacle of lobby.obstacles) {
            const dx = playerLobby.x - obstacle.x;
            const dy = playerLobby.y - obstacle.y;
            const distanceSq = dx * dx + dy * dy;
            const collisionRadius = playerLobby.size + obstacle.size / 2;
            if (distanceSq < collisionRadius * collisionRadius) {
                playerLobby.isAlive = false;
                recentlyDeadIPs[playerGlobal.ip] = Date.now();
                // No break needed
            }
        }
    });

    // 2. Player vs Player Revival Collision
     playerIdsInLobby.forEach(idA => {
        const playerA = lobby.players[idA];
        if (!playerA || !playerA.isAlive) return;
        playerIdsInLobby.forEach(idB => {
            if (idA === idB) return;
            const playerB = lobby.players[idB];
            if (!playerB || playerB.isAlive) return;
            const dx = playerA.x - playerB.x;
            const dy = playerA.y - playerB.y;
            const distanceSq = dx * dx + dy * dy;
            const collisionRadius = playerA.size + playerB.size;
            if (distanceSq < collisionRadius * collisionRadius) {
                 const usernameA = players[idA]?.username || idA;
                 const usernameB = players[idB]?.username || idB;
                 console.log(`Lobby ${lobbyId}: Player ${usernameA} revived ${usernameB}`);
                 playerB.isAlive = true;
            }
        });
    });

    // --- Prepare State for Broadcast ---
    const broadcastPlayers = getLobbyPlayersForBroadcast(lobbyId); // Use helper

    const gameState = {
        type: 'gameState', players: broadcastPlayers, obstacles: lobby.obstacles,
        level: lobby.level, score: lobby.score
    };
    broadcastToLobby(lobbyId, gameState);
} // --- End of gameLoop ---


// --- WebSocket Connection Handling ---
wss.on('connection', (ws, req) => {
    const playerIp = getIpFromConnection(ws, req);
    // console.log(`Incoming connection from IP: ${playerIp}`); // Can be noisy

    // --- IP Respawn Check ---
    const deadTimestamp = recentlyDeadIPs[playerIp];
    if (deadTimestamp) {
        const timeSinceDeath = Date.now() - deadTimestamp;
        if (timeSinceDeath < RESPAWN_TIMEOUT) {
            const timeLeft = Math.ceil((RESPAWN_TIMEOUT - timeSinceDeath) / 1000);
            console.log(`Rejecting connection from recently dead IP: ${playerIp}. Time left: ${timeLeft}s`);
            ws.send(JSON.stringify({ type: 'respawnTimeout', timeLeft: timeLeft }));
            ws.close(1008, `Respawn timeout active (${timeLeft}s left)`);
            return;
        } else {
             console.log(`Respawn timeout expired for IP: ${playerIp}.`);
             delete recentlyDeadIPs[playerIp];
        }
    }

    // --- Player Initialization (Global Map) ---
    const playerId = crypto.randomBytes(6).toString('hex');
    players[playerId] = { ws: ws, username: `Player_${playerId.substring(0, 4)}`, ip: playerIp, lobbyId: null };
    ws.playerId = playerId; // Associate ID with WS for easier cleanup
    console.log(`Client accepted. Player ID: ${playerId}, IP: ${playerIp}`);

    // Send initial lobby list
    sendToClient(playerId, { type: 'lobbyList', lobbies: getLobbyList() });

    // --- Handle messages ---
    ws.on('message', (message) => {
        let data;
        try {
            if (message.length > 2048) { ws.close(1009, "Message too large"); return; }
            data = JSON.parse(message);
        } catch (error) { console.error(`Failed parse from ${playerId}:`, message, error); return; }

        const player = players[playerId];
        if (!player) { ws.close(1011, "Player data lost"); return; }

        const currentLobbyId = player.lobbyId;
        const lobby = currentLobbyId ? lobbies[currentLobbyId] : null;
        const playerLobbyData = lobby ? lobby.players[playerId] : null;

        // --- Message Routing ---
        if (!currentLobbyId) { // === BEFORE LOBBY ===
            handleLobbyBrowserCommands(playerId, data); // Pass player ID and message data
        } else { // === IN LOBBY ===
             handleInGameCommands(playerId, player, lobby, playerLobbyData, data); // Pass more context
        }
    }); // --- End ws.on('message') ---

    // --- Handle disconnection ---
    ws.on('close', (code, reason) => {
        const closedPlayerId = ws.playerId;
        const player = players[closedPlayerId];
        if (!player) { return; } // Already cleaned up
        console.log(`Client ${player.username} (ID: ${closedPlayerId}, IP: ${player.ip}) disconnected. Code: ${code}`);
        if (player.lobbyId) {
            removePlayerFromLobby(closedPlayerId, player.lobbyId, true);
            broadcastLobbyListUpdate();
        }
        delete players[closedPlayerId];
        console.log(`Global players remaining: ${Object.keys(players).length}`);
    }); // --- End ws.on('close') ---

    // --- Handle errors ---
    ws.on('error', (error) => {
         const errorPlayerId = ws.playerId;
         const player = players[errorPlayerId];
        console.error(`WSError for player ${player?.username || errorPlayerId} (IP: ${player?.ip}):`, error);
        if (player && player.lobbyId) {
            removePlayerFromLobby(errorPlayerId, player.lobbyId, true);
            broadcastLobbyListUpdate();
        }
        if (players[errorPlayerId]) delete players[errorPlayerId];
        // 'close' event should follow
    }); // --- End ws.on('error') ---

}); // --- End wss.on('connection') ---


// --- Message Handling Logic ---

function handleLobbyBrowserCommands(playerId, data) {
    switch(data.type) {
        case 'getLobbies':
            sendToClient(playerId, { type: 'lobbyList', lobbies: getLobbyList() });
            break;
        case 'createLobby':
            if (typeof data.lobbyName !== 'string' || data.lobbyName.trim().length === 0) {
                sendToClient(playerId, { type: 'createFailed', reason: 'Lobby name cannot be empty.' }); return;
            }
            const name = data.lobbyName.substring(0, 30).trim();
            const pass = typeof data.password === 'string' && data.password.length > 0 ? data.password.substring(0, 20) : null;
            const nameExists = Object.values(lobbies).some(l => l.name.toLowerCase() === name.toLowerCase());
            if (nameExists) {
                sendToClient(playerId, { type: 'createFailed', reason: `Lobby name "${name}" already exists.` }); return;
            }

            const newLobby = createLobby(name, pass);
            if (addPlayerToLobby(playerId, newLobby.id)) {
                // Send success message WITH ID and initial state
                const initialState = {
                    players: getLobbyPlayersForBroadcast(newLobby.id),
                    obstacles: newLobby.obstacles, level: newLobby.level, score: newLobby.score
                };
                sendToClient(playerId, {
                    type: 'joinSuccess', lobbyId: newLobby.id, lobbyName: newLobby.name,
                    playerId: playerId, initialState: initialState
                });
                broadcastLobbyListUpdate();
            } else {
                sendToClient(playerId, { type: 'createFailed', reason: 'Failed to add player to new lobby.' });
                if (Object.keys(newLobby.players).length === 0) delete lobbies[newLobby.id];
            }
            break;
        case 'joinLobby':
            if (!data.lobbyId) { sendToClient(playerId, { type: 'joinFailed', reason: 'Missing lobby ID.' }); return; }
            const targetLobby = lobbies[data.lobbyId];
            if (!targetLobby) { sendToClient(playerId, { type: 'joinFailed', reason: 'Lobby not found.' }); return; }
            if (targetLobby.passwordProtected) {
                if (typeof data.password !== 'string') { sendToClient(playerId, { type: 'passwordRequired', lobbyId: data.lobbyId }); return; }
                if (data.password !== targetLobby.password) { sendToClient(playerId, { type: 'joinFailed', reason: 'Incorrect password.' }); return; }
            }

            if (addPlayerToLobby(playerId, data.lobbyId)) {
                 // Send success message WITH ID and initial state
                 const initialState = {
                    players: getLobbyPlayersForBroadcast(targetLobby.id),
                    obstacles: targetLobby.obstacles, level: targetLobby.level, score: targetLobby.score
                 };
                sendToClient(playerId, {
                    type: 'joinSuccess', lobbyId: targetLobby.id, lobbyName: targetLobby.name,
                    playerId: playerId, initialState: initialState
                });
                broadcastLobbyListUpdate();
            } else { sendToClient(playerId, { type: 'joinFailed', reason: 'Failed to add player (error/full?).' }); }
            break;
        default:
            console.warn(`Player ${playerId} (not in lobby) sent invalid message type: ${data.type}`);
    }
}

function handleInGameCommands(playerId, playerGlobal, lobby, playerLobbyData, data) {
    // Safety checks
    if (!lobby) { console.error(`InGameCmd Error: Player ${playerId} lobby missing!`); playerGlobal.lobbyId = null; playerGlobal.ws.close(1011); return; }
    if (!playerLobbyData) { console.error(`InGameCmd Error: Player ${playerId} lobby data missing!`); delete lobby.players[playerId]; playerGlobal.lobbyId = null; playerGlobal.ws.close(1011); return; }

    // Handle in-game messages
    switch(data.type) {
        case 'setUsername':
             if (typeof data.username === 'string') {
                const sanitizedUsername = data.username.substring(0, 16).replace(/[^a-zA-Z0-9_.\- ]/g, '');
                if (playerGlobal.username !== sanitizedUsername) {
                    playerGlobal.username = sanitizedUsername || `Player_${playerId.substring(0,4)}`;
                }
            }
            break;
        case 'input':
            if (data.keys) playerLobbyData.keys = data.keys;
            if (data.mousePos) playerLobbyData.mousePos = data.mousePos;
            if (typeof data.useMouse === 'boolean') playerLobbyData.useMouse = data.useMouse;
            // Apply movement calculation immediately
            if (playerLobbyData.isAlive) {
                if (playerLobbyData.useMouse && playerLobbyData.mousePos) { // Direct mouse position
                    playerLobbyData.x = playerLobbyData.mousePos.x;
                    playerLobbyData.y = playerLobbyData.mousePos.y;
                } else { // Keyboard movement
                    let dx = 0, dy = 0;
                    if (playerLobbyData.keys['w'] || playerLobbyData.keys['arrowup']) dy -= 1; if (playerLobbyData.keys['s'] || playerLobbyData.keys['arrowdown']) dy += 1;
                    if (playerLobbyData.keys['a'] || playerLobbyData.keys['arrowleft']) dx -= 1; if (playerLobbyData.keys['d'] || playerLobbyData.keys['arrowright']) dx += 1;
                    const len = Math.sqrt(dx * dx + dy * dy);
                    if (len > 0) { dx = (dx / len) * PLAYER_SPEED; dy = (dy / len) * PLAYER_SPEED; }
                    playerLobbyData.x += dx;
                    playerLobbyData.y += dy;
                }
                // Clamp position
                playerLobbyData.x = Math.max(playerLobbyData.size, Math.min(CANVAS_WIDTH - playerLobbyData.size, playerLobbyData.x));
                playerLobbyData.y = Math.max(playerLobbyData.size, Math.min(CANVAS_HEIGHT - playerLobbyData.size, playerLobbyData.y));
            }
            break;
        // Ignore lobby management commands when already in a game
        case 'getLobbies': case 'joinLobby': case 'createLobby':
            console.warn(`Player ${playerId} in lobby ${playerGlobal.lobbyId} sent disallowed command: ${data.type}`);
            break;
        default:
             console.warn(`Player ${playerId} (in lobby ${playerGlobal.lobbyId}) sent unknown message type: ${data.type}`);
    }
}


// Function to send updated lobby list to players *not* currently in a lobby
function broadcastLobbyListUpdate() {
     const list = getLobbyList(); // Get current lobby data
     Object.keys(players).forEach(pid => {
         const player = players[pid];
         // Check player exists and is NOT in a lobby
         if (player && !player.lobbyId) {
             sendToClient(pid, { type: 'lobbyList', lobbies: list });
         }
     });
}

// --- Start the HTTP Server ---
server.listen(PORT, () => {
    console.log(`HTTP server running, hosting WS on port ${PORT}`);
});

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing server gracefully...');
    // Stop all lobby loops first
    Object.keys(lobbies).forEach(lobbyId => {
        const lobby = lobbies[lobbyId];
        if (lobby) {
             if (lobby.gameLoopInterval) clearInterval(lobby.gameLoopInterval);
             if (lobby.spawnTimer) clearInterval(lobby.spawnTimer);
             lobby.gameLoopInterval = null; lobby.spawnTimer = null; lobby.gameRunning = false;
        }
    });
    console.log('All lobby game loops stopped.');
    wss.clients.forEach(ws => { if (ws.readyState < 2) ws.close(1001, "Server Shutting Down"); });
    console.log('Sent close notification to clients.');
    server.close(() => { console.log('HTTP server closed.'); process.exit(0); });
    setTimeout(() => { console.error("Graceful shutdown timed out."); process.exit(1); }, 5000);
});
