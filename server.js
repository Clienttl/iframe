// server.js
const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, clientTracking: true });
const PORT = process.env.PORT || 3000;

console.log(`Enhanced Evades server starting on port ${PORT}...`);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Game Constants ---
const CANVAS_WIDTH = 1200; // Reference size for server logic
const CANVAS_HEIGHT = 800;
const PLAYER_SIZE = 15;
const PLAYER_SPEED = 3.5; // Base speed for keyboard
const OBSTACLE_BASE_SIZE = 25; // Diameter
const OBSTACLE_BASE_SPEED = 1.5;
const LOBBY_LEVEL_SCORE_THRESHOLD = 250; // Score needed for lobby to level up
const BASE_SPAWN_INTERVAL = 120; // Base milliseconds for obstacle spawn
const SPEED_LEVEL_MULTIPLIER = 0.18; // Lobby level speed increase for obstacles
const SPAWN_RATE_LEVEL_MULTIPLIER = 0.22; // Lobby level spawn rate increase for obstacles
const SIZE_VARIANCE_LEVEL_MULTIPLIER = 1.2; // Lobby level obstacle size variance increase
const RESPAWN_TIMEOUT = 15000; // 15 seconds
const IP_CLEANUP_INTERVAL = 60000; // 1 minute

const SAFE_ZONE_WIDTH_RATIO = 0.20; // Left 20% of canvas is safe
const SAFE_ZONE_X_BOUNDARY = CANVAS_WIDTH * SAFE_ZONE_WIDTH_RATIO;

const PLAYER_BASE_XP_NEEDED = 100; // XP for player Lvl 1 -> 2
const PLAYER_XP_INCREMENT_FACTOR = 1.2;   // Multiplier for next level's XP (e.g., 100, 120, 144...)
const PLAYER_XP_PER_GAME_TICK = 1;     // XP gained per game tick while alive and outside safe zone initially (can adjust)

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
    if (!ip && ws && ws._socket) ip = ws._socket.remoteAddress; // Fallback for direct WS connection
    if (ip && ip.startsWith('::ffff:')) return ip.substring(7); // Handle IPv6-mapped IPv4
    return ip || 'unknown';
}

function getRandomColor() {
    const color = COLORS[globalColorIndex % COLORS.length];
    globalColorIndex++;
    return color;
}

function generateId() {
    return crypto.randomBytes(6).toString('hex'); // Shorter, still very unique
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
            // console.log(`Cleaned up IP ${ip} from dead list.`);
        }
    });
}
setInterval(cleanupDeadIPs, IP_CLEANUP_INTERVAL);


// Helper to format player data for broadcast
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
                color: pLobby.color, isAlive: pLobby.isAlive, size: pLobby.size,
                level: pLobby.level, xp: pLobby.xp, xpNeeded: pLobby.xpNeeded // Add player level info
            };
        }
    });
    return broadcastPlayers;
}

// --- Lobby Management ---

function createLobby(lobbyName, password = null) {
    const lobbyId = generateId(); // Use new shorter ID function
    lobbies[lobbyId] = {
        id: lobbyId,
        name: lobbyName,
        password: password,
        passwordProtected: !!password,
        players: {}, // { playerId: { x, y, color, isAlive, size, useMouse, mousePos, keys, level, xp, xpNeeded } }
        obstacles: [],
        lobbyLevel: 1, // Lobby's own difficulty level
        score: 0,      // Lobby's current score
        gameTimeStart: Date.now(),
        nextObstacleId: 0,
        gameRunning: false,
        gameLoopInterval: null,
        spawnTimer: null,
    };
    console.log(`Lobby created: "${lobbyName}" (ID: ${lobbyId})${password ? ' [PW Protected]' : ''}`);
    return lobbies[lobbyId];
}

// Create the default main lobby ONCE at server start
if (MAIN_LOBBY_ID === null) {
    const mainLobby = createLobby("Main Evade Arena"); // Give it a more descriptive name
    MAIN_LOBBY_ID = mainLobby.id;
    console.log(`Main Lobby ID set to: ${MAIN_LOBBY_ID}`);
}

// Get data for the lobby browser list
function getLobbyList() {
    return Object.values(lobbies).map(lobby => ({
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

    if (player.lobbyId && player.lobbyId !== lobbyId && lobbies[player.lobbyId]) {
        console.log(`Player ${playerId} switching lobbies from ${player.lobbyId} to ${lobbyId}`);
        removePlayerFromLobby(playerId, player.lobbyId, false);
    }

    player.lobbyId = lobbyId; // Update global player ref
    lobby.players[playerId] = { // Add lobby-specific state including player level
        x: SAFE_ZONE_X_BOUNDARY / 2, // Start in safe zone
        y: CANVAS_HEIGHT / 2 + (Math.random() - 0.5) * 100, // Spread out a bit
        color: getRandomColor(),
        isAlive: true,
        size: PLAYER_SIZE,
        useMouse: false,
        mousePos: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 },
        keys: {},
        level: 1, // Player's personal level
        xp: 0,    // Player's current XP
        xpNeeded: PLAYER_BASE_XP_NEEDED // XP needed for next player level
    };

    console.log(`Player ${player.username} (${playerId}) successfully added to lobby "${lobby.name}" (${lobbyId}) players.`);
    startGameIfNeeded(lobbyId);
    return true;
}

// Remove player from lobby state and handle empty lobby cleanup
function removePlayerFromLobby(playerId, lobbyId, recordDeadIp = true) {
    const lobby = lobbies[lobbyId];
    if (!lobby || !lobby.players[playerId]) {
        return;
    }

    const playerGlobal = players[playerId];
    const playerLobby = lobby.players[playerId]; // Get before delete

    console.log(`Removing player ${playerGlobal?.username || playerId} from lobby "${lobby.name}" (${lobbyId})`);

    if (recordDeadIp && playerLobby && !playerLobby.isAlive && playerGlobal?.ip) {
        if (!recentlyDeadIPs[playerGlobal.ip]) {
            console.log(`Player ${playerGlobal.username} left dead. Adding IP ${playerGlobal.ip} to dead list.`);
            recentlyDeadIPs[playerGlobal.ip] = Date.now();
        }
    }

    delete lobby.players[playerId];
    if (playerGlobal) playerGlobal.lobbyId = null;

    if (lobbyId !== MAIN_LOBBY_ID && Object.keys(lobby.players).length === 0) {
        console.log(`Custom lobby "${lobby.name}" (${lobbyId}) is now empty. Removing.`);
        if (lobby.spawnTimer) { clearInterval(lobby.spawnTimer); lobby.spawnTimer = null; }
        if (lobby.gameLoopInterval) { clearInterval(lobby.gameLoopInterval); lobby.gameLoopInterval = null; }
        delete lobbies[lobbyId];
        broadcastLobbyListUpdate();
    } else {
        stopGameIfEmpty(lobbyId);
    }
}

// --- Per-Lobby Game Logic Functions ---

function startGameIfNeeded(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby || lobby.gameRunning || Object.keys(lobby.players).length === 0) return;

    console.log(`Starting game logic for lobby "${lobby.name}" (${lobbyId})`);
    lobby.gameRunning = true;
    lobby.gameTimeStart = Date.now();
    lobby.lobbyLevel = 1; lobby.score = 0; lobby.obstacles = []; // Reset lobby game state
    // Reset player levels/XP in lobby if desired, or let them persist. Here, we let them persist from join.
    startSpawning(lobbyId);
    if (!lobby.gameLoopInterval) {
        lobby.gameLoopInterval = setInterval(() => gameLoop(lobbyId), 1000 / 60);
    }
}

function stopGameIfEmpty(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby || !lobby.gameRunning || Object.keys(lobby.players).length > 0) return;

    console.log(`Stopping game logic for empty lobby "${lobby.name}" (${lobbyId})`);
    lobby.gameRunning = false;
    if (lobby.spawnTimer) { clearInterval(lobby.spawnTimer); lobby.spawnTimer = null; }
    if (lobby.gameLoopInterval) { clearInterval(lobby.gameLoopInterval); lobby.gameLoopInterval = null; }
    lobby.obstacles = []; // Clear obstacles
}

function startSpawning(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;
    if (lobby.spawnTimer) clearInterval(lobby.spawnTimer);

    const spawnInterval = Math.max(80, BASE_SPAWN_INTERVAL / (1 + (lobby.lobbyLevel - 1) * SPAWN_RATE_LEVEL_MULTIPLIER));
    lobby.spawnTimer = setInterval(() => spawnObstacle(lobbyId), spawnInterval);
}

function spawnObstacle(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby || !lobby.gameRunning) return;

    const sizeVariance = 20 + (lobby.lobbyLevel * SIZE_VARIANCE_LEVEL_MULTIPLIER);
    const size = OBSTACLE_BASE_SIZE + Math.random() * sizeVariance;
    const speed = (OBSTACLE_BASE_SPEED + Math.random() * 1.0) * (1 + (lobby.lobbyLevel - 1) * SPEED_LEVEL_MULTIPLIER);
    let x, y, vx, vy;

    const attempts = 5; // Try a few times to spawn outside safe zone properly
    for (let i = 0; i < attempts; i++) {
        const edge = Math.floor(Math.random() * 4);
        switch (edge) {
            case 0: x = Math.random() * CANVAS_WIDTH; y = -size; vx = (Math.random() - 0.5) * speed; vy = speed; break; // Top
            case 1: x = CANVAS_WIDTH + size; y = Math.random() * CANVAS_HEIGHT; vx = -speed; vy = (Math.random() - 0.5) * speed; break; // Right
            case 2: x = Math.random() * CANVAS_WIDTH; y = CANVAS_HEIGHT + size; vx = (Math.random() - 0.5) * speed; vy = -speed; break; // Bottom
            default:x = -size; y = Math.random() * CANVAS_HEIGHT; vx = speed; vy = (Math.random() - 0.5) * speed; break; // Left
        }

        // If spawning from top/bottom, try to ensure X is outside safe zone
        if ((edge === 0 || edge === 2) && x < SAFE_ZONE_X_BOUNDARY) {
            x = SAFE_ZONE_X_BOUNDARY + Math.random() * (CANVAS_WIDTH - SAFE_ZONE_X_BOUNDARY);
        }

        // Valid if starting right of boundary, or from L/R edges (as they'll cross into play area)
        if (x >= SAFE_ZONE_X_BOUNDARY || edge === 1 || edge === 3) {
            lobby.obstacles.push({ id: lobby.nextObstacleId++, x, y, vx, vy, size, color: '#ff4444' });
            return;
        }
    }
    // If all attempts fail, log it but don't spawn (or spawn anyway if desperate)
    // console.warn(`Lobby ${lobbyId}: Could not spawn obstacle outside safe zone after ${attempts} attempts.`);
}

// --- The Main Game Loop (Runs PER Lobby via setInterval) ---
function gameLoop(lobbyId) {
    const lobby = lobbies[lobbyId];
    if (!lobby || !lobby.gameRunning) {
        if (lobby && lobby.gameLoopInterval) {
            console.warn(`Stopping orphaned game loop for lobby ${lobbyId}`);
            clearInterval(lobby.gameLoopInterval);
            lobby.gameLoopInterval = null;
        }
        return;
    }

    const now = Date.now();

    // --- Update Lobby Score & Level ---
    if (Object.values(lobby.players).some(p => p.isAlive)) {
       lobby.score = Math.floor((now - lobby.gameTimeStart) / 100);
    } else {
        lobby.gameTimeStart = now - (lobby.score * 100); // Pause score
    }

    const neededScoreForLobbyLevelUp = lobby.lobbyLevel * LOBBY_LEVEL_SCORE_THRESHOLD;
    if (lobby.score >= neededScoreForLobbyLevelUp) {
        lobby.lobbyLevel++;
        console.log(`Lobby ${lobbyId}: LOBBY LEVEL UP! Reached Level ${lobby.lobbyLevel}`);
        startSpawning(lobbyId);
        broadcastToLobby(lobbyId, { type: 'lobbyLevelUp', newLobbyLevel: lobby.lobbyLevel });
    }

    // --- Update Obstacles ---
    lobby.obstacles = lobby.obstacles.filter(o => {
        o.x += o.vx; o.y += o.vy;
        // Remove if too far off-screen OR too deep into safe zone and moving further left
        if (o.x < (SAFE_ZONE_X_BOUNDARY - o.size * 2) && o.vx < 0) return false;
        return o.x > -o.size * 3 && o.x < CANVAS_WIDTH + o.size * 3 &&
               o.y > -o.size * 3 && o.y < CANVAS_HEIGHT + o.size * 3;
    });

    const playerIdsInLobby = Object.keys(lobby.players);

    // --- Player Update, XP, Level Up, Collision Detection ---
    playerIdsInLobby.forEach(playerId => {
        const pLobby = lobby.players[playerId];
        const pGlobal = players[playerId];
        if (!pLobby || !pGlobal) return;

        // Player XP and Leveling
        if (pLobby.isAlive) {
            // XP gain condition (e.g., only outside safe zone, or always alive)
            // For now, gain XP always when alive
            pLobby.xp += PLAYER_XP_PER_GAME_TICK;

            if (pLobby.xp >= pLobby.xpNeeded) {
                pLobby.level++;
                pLobby.xp = 0; // Or pLobby.xp -= pLobby.xpNeeded; for rollover XP
                pLobby.xpNeeded = Math.floor(PLAYER_BASE_XP_NEEDED * Math.pow(PLAYER_XP_INCREMENT_FACTOR, pLobby.level - 1));
                console.log(`Player ${pGlobal.username} (Lobby ${lobbyId}) leveled up to ${pLobby.level}. Next XP: ${pLobby.xpNeeded}`);
                // Notify all players in lobby about this specific player's level up
                broadcastToLobby(lobbyId, { type: 'playerLeveledUp', playerId: playerId, newLevel: pLobby.level, xpNeeded: pLobby.xpNeeded });
            }
        }

        // Player vs Obstacle Collision
        if (pLobby.isAlive) {
            const playerInSafeZone = pLobby.x - pLobby.size < SAFE_ZONE_X_BOUNDARY; // Check left edge of player
            if (!playerInSafeZone) {
                for (const obstacle of lobby.obstacles) {
                    // Obstacles that are mostly in the safe zone don't harm players outside it.
                    // This check means if an obstacle's center is in the safe zone, it's "safe".
                    if (obstacle.x < SAFE_ZONE_X_BOUNDARY) continue;

                    const dx = pLobby.x - obstacle.x;
                    const dy = pLobby.y - obstacle.y;
                    const distanceSq = dx * dx + dy * dy;
                    const collisionRadius = pLobby.size + obstacle.size / 2; // obstacle.size is diameter
                    if (distanceSq < collisionRadius * collisionRadius) {
                        pLobby.isAlive = false;
                        recentlyDeadIPs[pGlobal.ip] = Date.now();
                        // No break needed; player could theoretically be hit by multiple in one frame
                    }
                }
            }
        }
    });

    // Player vs Player Revival Collision
    playerIdsInLobby.forEach(idA => {
        const playerA = lobby.players[idA];
        if (!playerA || !playerA.isAlive) return; // Reviver must be alive

        playerIdsInLobby.forEach(idB => {
            if (idA === idB) return; // Cannot revive self
            const playerB = lobby.players[idB];
            if (!playerB || playerB.isAlive) return; // Revivee must be dead

            const dx = playerA.x - playerB.x;
            const dy = playerA.y - playerB.y;
            const distanceSq = dx * dx + dy * dy;
            const collisionRadius = playerA.size + playerB.size; // Sum of radii
            if (distanceSq < collisionRadius * collisionRadius) {
                 const usernameA = players[idA]?.username || idA;
                 const usernameB = players[idB]?.username || idB;
                 console.log(`Lobby ${lobbyId}: Player ${usernameA} revived ${usernameB}`);
                 playerB.isAlive = true;
                 // Potentially remove playerB's IP from recentlyDeadIPs if revived,
                 // or let timeout naturally handle it for fairness. For now, let timeout handle.
            }
        });
    });

    // --- Prepare State for Broadcast ---
    const broadcastPlayers = getLobbyPlayersForBroadcast(lobbyId);
    const gameState = {
        type: 'gameState', players: broadcastPlayers, obstacles: lobby.obstacles,
        lobbyLevel: lobby.lobbyLevel, score: lobby.score,
        safeZoneWidthRatio: SAFE_ZONE_WIDTH_RATIO // Send to client for drawing
    };
    broadcastToLobby(lobbyId, gameState);
}


// --- WebSocket Connection Handling ---
wss.on('connection', (ws, req) => {
    const playerIp = getIpFromConnection(ws, req);
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

    const playerId = generateId();
    players[playerId] = { ws: ws, username: `Player_${playerId.substring(0, 4)}`, ip: playerIp, lobbyId: null };
    ws.playerId = playerId; // Associate ID with WS for easier cleanup on close/error
    console.log(`Client accepted. Player ID: ${playerId}, IP: ${playerIp}`);
    sendToClient(playerId, { type: 'lobbyList', lobbies: getLobbyList() });

    ws.on('message', (message) => {
        let data;
        try {
            const messageString = message.toString(); // Ensure it's a string for JSON.parse
            if (Buffer.byteLength(messageString) > 2048) { // Check byte length for safety
                ws.close(1009, "Message too large");
                return;
            }
            data = JSON.parse(messageString);
        } catch (error) { console.error(`Failed parse from ${playerId}:`, message, error); return; }

        const player = players[playerId];
        if (!player) { ws.close(1011, "Player data lost"); return; }

        const currentLobbyId = player.lobbyId;
        const lobby = currentLobbyId ? lobbies[currentLobbyId] : null;
        const playerLobbyData = lobby ? lobby.players[playerId] : null;

        if (!currentLobbyId) { // Not in a lobby yet
            handleLobbyBrowserCommands(playerId, data);
        } else { // Already in a lobby
             handleInGameCommands(playerId, player, lobby, playerLobbyData, data);
        }
    });

    ws.on('close', (code, reason) => {
        const closedPlayerId = ws.playerId; // Use stored ID
        const player = players[closedPlayerId];
        if (!player) return; // Already cleaned up or never fully registered
        console.log(`Client ${player.username} (ID: ${closedPlayerId}, IP: ${player.ip}) disconnected. Code: ${code}, Reason: ${reason}`);
        if (player.lobbyId) {
            removePlayerFromLobby(closedPlayerId, player.lobbyId, true); // recordDeadIp might be conditional
            broadcastLobbyListUpdate(); // Notify lobby browser users
        }
        delete players[closedPlayerId]; // Remove from global player map
        console.log(`Global players remaining: ${Object.keys(players).length}`);
    });

    ws.on('error', (error) => {
         const errorPlayerId = ws.playerId;
         const player = players[errorPlayerId];
        console.error(`WSError for player ${player?.username || errorPlayerId} (IP: ${player?.ip}):`, error.message);
        // Aggressively clean up on error to prevent lingering states
        if (player && player.lobbyId) {
            removePlayerFromLobby(errorPlayerId, player.lobbyId, true);
            broadcastLobbyListUpdate();
        }
        if (players[errorPlayerId]) delete players[errorPlayerId];
        // 'close' event should typically follow an error that closes the socket
    });
});


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
                const initialState = {
                    players: getLobbyPlayersForBroadcast(newLobby.id), obstacles: newLobby.obstacles,
                    lobbyLevel: newLobby.lobbyLevel, score: newLobby.score,
                    safeZoneWidthRatio: SAFE_ZONE_WIDTH_RATIO
                };
                sendToClient(playerId, {
                    type: 'joinSuccess', lobbyId: newLobby.id, lobbyName: newLobby.name,
                    playerId: playerId, initialState: initialState
                });
                broadcastLobbyListUpdate(); // Notify other lobby browsers
            } else {
                sendToClient(playerId, { type: 'createFailed', reason: 'Failed to add player to new lobby.' });
                if (Object.keys(newLobby.players).length === 0) delete lobbies[newLobby.id]; // Clean up if failed to add first player
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
                 const initialState = {
                    players: getLobbyPlayersForBroadcast(targetLobby.id), obstacles: targetLobby.obstacles,
                    lobbyLevel: targetLobby.lobbyLevel, score: targetLobby.score,
                    safeZoneWidthRatio: SAFE_ZONE_WIDTH_RATIO
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
    if (!lobby) { console.error(`InGameCmd Error: Player ${playerId} lobby missing!`); playerGlobal.lobbyId = null; if (playerGlobal.ws.readyState < 2) playerGlobal.ws.close(1011); return; }
    if (!playerLobbyData) { console.error(`InGameCmd Error: Player ${playerId} lobby data missing!`); delete lobby.players[playerId]; playerGlobal.lobbyId = null; if (playerGlobal.ws.readyState < 2) playerGlobal.ws.close(1011); return; }

    switch(data.type) {
        case 'setUsername':
             if (typeof data.username === 'string') {
                const sanitizedUsername = data.username.substring(0, 16).replace(/[^a-zA-Z0-9_.\- ]/g, '').trim();
                if (playerGlobal.username !== sanitizedUsername && sanitizedUsername.length > 0) {
                    playerGlobal.username = sanitizedUsername;
                } else if (sanitizedUsername.length === 0) {
                    playerGlobal.username = `Player_${playerId.substring(0,4)}`; // Default if empty
                }
            }
            break;
        case 'input':
            if (playerLobbyData.isAlive) {
                if (data.keys) playerLobbyData.keys = data.keys;
                if (data.mousePos && typeof data.mousePos.x === 'number' && typeof data.mousePos.y === 'number') {
                     playerLobbyData.mousePos = {
                        x: Math.max(0, Math.min(CANVAS_WIDTH, data.mousePos.x)),
                        y: Math.max(0, Math.min(CANVAS_HEIGHT, data.mousePos.y))
                     };
                }
                if (typeof data.useMouse === 'boolean') playerLobbyData.useMouse = data.useMouse;

                let targetX = playerLobbyData.x;
                let targetY = playerLobbyData.y;

                if (playerLobbyData.useMouse && playerLobbyData.mousePos) {
                    targetX = playerLobbyData.mousePos.x;
                    targetY = playerLobbyData.mousePos.y;
                } else {
                    let dx = 0, dy = 0;
                    if (playerLobbyData.keys['w'] || playerLobbyData.keys['arrowup']) dy -= 1;
                    if (playerLobbyData.keys['s'] || playerLobbyData.keys['arrowdown']) dy += 1;
                    if (playerLobbyData.keys['a'] || playerLobbyData.keys['arrowleft']) dx -= 1;
                    if (playerLobbyData.keys['d'] || playerLobbyData.keys['arrowright']) dx += 1;
                    const len = Math.sqrt(dx * dx + dy * dy);
                    if (len > 0) { targetX += (dx / len) * PLAYER_SPEED; targetY += (dy / len) * PLAYER_SPEED; }
                }
                playerLobbyData.x = Math.max(playerLobbyData.size, Math.min(CANVAS_WIDTH - playerLobbyData.size, targetX));
                playerLobbyData.y = Math.max(playerLobbyData.size, Math.min(CANVAS_HEIGHT - playerLobbyData.size, targetY));
            }
            break;
        case 'chat':
            if (typeof data.message === 'string' && data.message.trim().length > 0 && data.message.length < 150) {
                const sanitizedMessage = data.message.trim().replace(/</g, "<").replace(/>/g, ">"); // Basic XSS prevention
                broadcastToLobby(lobby.id, {
                    type: 'chatMessage',
                    username: playerGlobal.username,
                    message: sanitizedMessage,
                    playerId: playerId // So client can style its own messages differently
                });
            }
            break;
        case 'getLobbies': case 'joinLobby': case 'createLobby':
            console.warn(`Player ${playerId} in lobby ${playerGlobal.lobbyId} sent disallowed command: ${data.type}`);
            break;
        default:
             console.warn(`Player ${playerId} (in lobby ${playerGlobal.lobbyId}) sent unknown message type: ${data.type}`);
    }
}

// Function to send updated lobby list to players *not* currently in a lobby
function broadcastLobbyListUpdate() {
     const list = getLobbyList();
     Object.keys(players).forEach(pid => {
         const player = players[pid];
         if (player && !player.lobbyId) { // Only send to players in lobby browser
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
    setTimeout(() => { console.error("Graceful shutdown timed out."); process.exit(1); }, 5000); // Force exit after 5s
});
