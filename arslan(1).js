const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    Browsers,
    DisconnectReason,
    jidDecode,
    generateForwardMessageContent,
    generateWAMessageFromContent,
    downloadContentFromMessage,
    getContentType
} = require('@whiskeysockets/baileys');

const config = require('./config');
const events = require('./command');
const { sms } = require('./lib/msg');
const { 
    connectdb,
    saveSessionToMongoDB,
    getSessionFromMongoDB,
    deleteSessionFromMongoDB,
    getUserConfigFromMongoDB,
    updateUserConfigInMongoDB,
    addNumberToMongoDB,
    removeNumberFromMongoDB,
    getAllNumbersFromMongoDB,
    saveOTPToMongoDB,
    verifyOTPFromMongoDB,
    incrementStats,
    getStatsForNumber
} = require('./lib/database');
const { handleAntidelete } = require('./lib/antidelete');

const express = require('express');
const fs = require('fs-extra');
const pino = require('pino');
const path = require('path');
const crypto = require('crypto');
const FileType = require('file-type');
const axios = require('axios');
const bodyparser = require('body-parser');
const moment = require('moment-timezone');

const prefix = config.PREFIX;
const mode = config.MODE;
const router = express.Router();

// ===== FIX: SERVER LIMIT INCREASED =====
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS) || 1000; // Default 1000 connections
global.activeUsers = global.activeUsers || new Map(); // Use Map instead of Set for better tracking
global.connectionLocks = global.connectionLocks || new Map();

// ===== STATUS TRACKING =====
const serverStartTime = Date.now();

function formatUptime(ms) {
    let totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    totalSeconds %= 86400;
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

// ===== CLEANUP STALE CONNECTIONS =====
function cleanupStaleConnections() {
    const now = Date.now();
    const STALE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
    let cleaned = 0;
    
    for (const [number, connectionData] of global.activeUsers.entries()) {
        if (connectionData && (now - connectionData.timestamp) > STALE_TIMEOUT) {
            console.log(`🧹 Cleaning stale connection: ${number}`);
            global.activeUsers.delete(number);
            global.connectionLocks.delete(number);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`✅ Cleaned ${cleaned} stale connections. Active: ${global.activeUsers.size}/${MAX_CONNECTIONS}`);
    }
}

// Run cleanup every 5 minutes
setInterval(cleanupStaleConnections, 5 * 60 * 1000);

// ===== STATUS API =====
router.get('/status', (req, res) => {
    const now = Date.now();
    const uptimeSec = Math.floor((now - serverStartTime) / 1000);
    const connected = global.activeUsers.size;
    const remaining = MAX_CONNECTIONS - connected;

    res.json({
        server: "running",
        status: "active",
        uptime: uptimeSec,
        uptimeFormatted: formatUptime(now - serverStartTime),
        totalActive: connected,
        limit: MAX_CONNECTIONS,
        available: remaining,
        connections: Array.from(global.activeUsers.entries()).map(([num, data]) => ({
            number: num,
            connectedSince: new Date(data.timestamp).toISOString(),
            uptime: Math.floor((now - data.timestamp) / 1000)
        })),
        timestamp: new Date().toISOString()
    });
});

router.get('/pair', (req, res) => {
    res.sendFile(path.join(__dirname, 'pair.html'));
});

// ===== PAIR CODE ENDPOINT =====
router.post('/pair', async (req, res) => {
    try {
        let { number } = req.body;
        
        if (!number) {
            return res.status(400).json({ 
                success: false, 
                error: "Number is required" 
            });
        }

        // Clean number
        number = number.replace(/[^0-9]/g, '');
        
        if (number.length < 10) {
            return res.status(400).json({ 
                success: false, 
                error: "Invalid number format" 
            });
        }

        // FIX: Server limit check with better message
        if (global.activeUsers.size >= MAX_CONNECTIONS) {
            return res.json({
                success: false,
                error: "SERVER_FULL",
                message: "Server is currently full. Please try again in a few minutes.",
                urduMessage: "سرور فل ہے۔ براہ کرم چند منٹ بعد کوشش کریں۔",
                activeConnections: global.activeUsers.size,
                maxConnections: MAX_CONNECTIONS
            });
        }

        // Check if already connecting
        if (global.connectionLocks.has(number)) {
            return res.json({
                success: false,
                error: "IN_PROGRESS",
                message: "Pairing already in progress for this number",
                urduMessage: "اس نمبر کے لیے پہلے سے جوڑائی جاری ہے"
            });
        }

        // Check if already connected
        if (global.activeUsers.has(number)) {
            const connectionData = global.activeUsers.get(number);
            return res.json({
                success: false,
                error: "ALREADY_CONNECTED",
                message: "Number is already connected",
                urduMessage: "نمبر پہلے سے منسلک ہے",
                connectedSince: new Date(connectionData.timestamp).toISOString()
            });
        }

        // Set lock
        global.connectionLocks.set(number, Date.now());

        // Start bot connection
        const result = await startBot(number);
        
        // Remove lock
        global.connectionLocks.delete(number);

        if (result.success) {
            res.json({
                success: true,
                code: result.code,
                message: "Pairing code generated successfully",
                urduMessage: "جوڑائی کا کوڈ کامیابی سے بن گیا"
            });
        } else {
            res.json({
                success: false,
                error: result.error,
                message: result.message || "Failed to generate pairing code"
            });
        }

    } catch (error) {
        console.error("Pair endpoint error:", error);
        res.status(500).json({
            success: false,
            error: "SERVER_ERROR",
            message: "Internal server error"
        });
    }
});

// ==============================================================================
// 1. INITIALIZATION & DATABASE
// ==============================================================================

connectdb();

// Stockage en mémoire
const activeSockets = new Map();
const socketCreationTime = new Map();

// Fonctions utilitaires
const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

const getGroupAdmins = (participants) => {
    let admins = [];
    for (let i of participants) {
        if (i.admin == null) continue;
        admins.push(i.id);
    }
    return admins;
}

// Vérification connexion existante
function isNumberAlreadyConnected(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    return activeSockets.has(sanitizedNumber);
}

function getConnectionStatus(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const isConnected = activeSockets.has(sanitizedNumber);
    const connectionTime = socketCreationTime.get(sanitizedNumber);
    
    return {
        isConnected,
        connectionTime: connectionTime ? new Date(connectionTime).toLocaleString() : null,
        uptime: connectionTime ? Math.floor((Date.now() - connectionTime) / 1000) : 0
    };
}

// Load Plugins
const pluginsDir = path.join(__dirname, 'plugins');
if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
}

const files = fs.readdirSync(pluginsDir).filter(file => file.endsWith('.js'));
console.log(`📦 Loading ${files.length} plugins...`);
for (const file of files) {
    try {
        require(path.join(pluginsDir, file));
    } catch (e) {
        console.error(`❌ Failed to load plugin ${file}:`, e);
    }
}

// ==============================================================================
// 2. HANDLERS SPÉCIFIQUES
// ==============================================================================

async function setupMessageHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        // Charger config utilisateur depuis MongoDB
        const userConfig = await getUserConfigFromMongoDB(number);
        
        // Auto-typing basé sur config
        if (userConfig.AUTO_TYPING === 'true') {
            try {
                await socket.sendPresenceUpdate('composing', msg.key.remoteJid);
            } catch (error) {
                console.error(`Failed to set typing presence:`, error);
            }
        }
        
        // Auto-recording basé sur config
        if (userConfig.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
            } catch (error) {
                console.error(`Failed to set recording presence:`, error);
            }
        }
    });
}

async function setupCallHandlers(socket, number) {
    socket.ev.on('call', async (calls) => {
        try {
            // Charger config utilisateur depuis MongoDB
            const userConfig = await getUserConfigFromMongoDB(number);
            if (userConfig.ANTI_CALL !== 'true') return;

            for (const call of calls) {
                if (call.status !== 'offer') continue;
                const id = call.id;
                const from = call.from;

                await socket.rejectCall(id, from);
                await socket.sendMessage(from, {
                    text: userConfig.REJECT_MSG || '*CALL NAHI KARE PLEASE ☺️*'
                });
                console.log(`CALL REJECT HO GAI ${number} from ${from}`);
            }
        } catch (err) {
            console.error(`Anti-call error for ${number}:`, err);
        }
    });
}

function setupAutoRestart(socket, number) {
    let restartAttempts = 0;
    const maxRestartAttempts = 3;
    
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        console.log(`Connection update for ${number}:`, { connection, lastDisconnect });
        
        if (connection === 'close') {
            const safeNumber = number.replace(/[^0-9]/g, '');
            global.activeUsers.delete(safeNumber);
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message;
            
            console.log(`Connection closed for ${number}:`, {
                statusCode,
                errorMessage,
                isManualUnlink: statusCode === 401
            });
            
            // Manual unlink detection
            if (statusCode === 401 || errorMessage?.includes('401')) {
                console.log(`🔐 Manual unlink detected for ${number}, cleaning up...`);
                const sanitizedNumber = number.replace(/[^0-9]/g, '');
                
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
                await deleteSessionFromMongoDB(sanitizedNumber);
                await removeNumberFromMongoDB(sanitizedNumber);
                
                socket.ev.removeAllListeners();
                return;
            }
            
            // Skip restart for normal/expected errors
            const isNormalError =
    statusCode === 408 ||
    statusCode === 515 ||
    errorMessage?.includes('QR refs attempts ended') ||
    errorMessage?.includes('Stream Errored');
            
            if (isNormalError) {
                console.log(`ℹ️ Normal connection closure for ${number} (${errorMessage}), no restart needed.`);
                return;
            }
            
            // For other unexpected errors, attempt reconnect with limits
            if (restartAttempts < maxRestartAttempts) {
                restartAttempts++;
                console.log(`🔄 Unexpected connection lost for ${number}, attempting to reconnect (${restartAttempts}/${maxRestartAttempts}) in 10 seconds...`);
                
                const sanitizedNumber = number.replace(/[^0-9]/g, '');
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
                
                socket.ev.removeAllListeners();

                await delay(10000);
                
                try {
                    await startBot(number);
                    console.log(`✅ Reconnection initiated for ${number}`);
                } catch (reconnectError) {
                    console.error(`❌ Reconnection failed for ${number}:`, reconnectError);
                }
            } else {
                console.log(`❌ Max restart attempts reached for ${number}. Manual intervention required.`);
            }
        }
        
        // Reset counter on successful connection
        if (connection === 'open') {
            console.log(`✅ Connection established for ${number}`);
            restartAttempts = 0;

            const safeNumber = number.replace(/[^0-9]/g, '');
            global.activeUsers.set(safeNumber, {
                timestamp: Date.now(),
                socket: socket
            });
        }
    });
}

// ==============================================================================
// 3. FONCTION PRINCIPALE STARTBOT
// ==============================================================================

async function startBot(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    try {
        const sessionDir = path.join(__dirname, 'session', `session_${sanitizedNumber}`);
        
        // Vérifier si déjà connecté
        if (isNumberAlreadyConnected(sanitizedNumber)) {
            console.log(`⏩ ${sanitizedNumber} is already connected, skipping...`);
            return {
                success: false,
                error: "ALREADY_CONNECTED",
                message: "Number is already connected"
            };
        }
        
        // 1. Vérifier session MongoDB
        const existingSession = await getSessionFromMongoDB(sanitizedNumber);
        
        if (!existingSession) {
            console.log(`🧹 No MongoDB session found for ${sanitizedNumber} - requiring NEW pairing`);
            
            if (fs.existsSync(sessionDir)) {
                await fs.remove(sessionDir);
                console.log(`🗑️ Cleaned leftover local session for ${sanitizedNumber}`);
            }
        } else {
            fs.ensureDirSync(sessionDir);
            fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(existingSession, null, 2));
            console.log(`🔄 Restored existing session from MongoDB for ${sanitizedNumber}`);
        }
        
        // 2. Initialiser socket
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        const conn = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            printQRInTerminal: false,
            usePairingCode: !existingSession,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS('Safari'),
            syncFullHistory: false,
            getMessage: async () => {
    return { conversation: 'Hello' };
}
        });
        
        // 3. Enregistrer connexion
        socketCreationTime.set(sanitizedNumber, Date.now());
        activeSockets.set(sanitizedNumber, conn);
        
        // 4. Setup handlers
        setupMessageHandlers(conn, number);
        setupCallHandlers(conn, number);
        setupAutoRestart(conn, number);
        
        // 5. UTILS ATTACHED TO CONN
        conn.decodeJid = jid => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                let decode = jidDecode(jid) || {};
                return (decode.user && decode.server && decode.user + '@' + decode.server) || jid;
            } else return jid;
        };
        
        conn.downloadAndSaveMediaMessage = async(message, filename, attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            let trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        };
        
        // 6. PAIRING CODE GENERATION
        if (!existingSession) {
            // Generate pairing code
            await delay(1500);
            const code = await conn.requestPairingCode(sanitizedNumber);
            console.log(`🔑 Pairing Code for ${sanitizedNumber}: ${code}`);
            
            return {
                success: true,
                code: code,
                message: "Pairing code generated"
            };
        } else {
            return {
                success: true,
                code: null,
                message: "Reconnecting with existing session"
            };
        }
        
        // 7. Sauvegarde session dans MongoDB
        conn.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = fs.readFileSync(path.join(sessionDir, 'creds.json'), 'utf8');
            const creds = JSON.parse(fileContent);
            
            await saveSessionToMongoDB(sanitizedNumber, creds);
            console.log(`💾 Session updated in MongoDB for ${sanitizedNumber}`);
        });
        
        // 8. GESTION CONNEXION
        conn.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(`✅ Connected: ${sanitizedNumber}`);
                const userJid = jidNormalizedUser(conn.user.id);
                
                await addNumberToMongoDB(sanitizedNumber);
                
                global.activeUsers.set(sanitizedNumber, {
                    timestamp: Date.now(),
                    jid: userJid
                });
                
                if (!existingSession) {
                    const connectText = `
╔════════════════╗
║ 🤖 CONNECTED
╠════════════════╣
║ 🔑 PREFIX  : ${config.PREFIX}
║ 👨‍💻 DEV     : MUZAMMIL-MD
║ 📞 DEV NO : 923052206465
╚════════════════╝
                    `;
                    
                    await conn.sendMessage(userJid, {
                        image: { url: config.IMAGE_PATH },
                        caption: connectText
                    });
                }
                
                console.log(`🎉 ${sanitizedNumber} successfully connected!`);
            }
        });
        
    } catch (error) {
        console.error(`❌ Error in startBot for ${sanitizedNumber}:`, error);
        return {
            success: false,
            error: "CONNECTION_ERROR",
            message: error.message
        };
    }
}
// ==============================================================================
// 4. ROUTES API (non modifié)
// ==============================================================================

router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'pair.html')));

router.get('/code', async (req, res) => {
    const number = req.query.number;

    if (!number) {
        return res.json({
            error: 'Number required'
        });
    }

    const result = await startBot(number);

    return res.json(result);
});

// Route pour vérifier statut
router.get('/status', async (req, res) => {
    const { number } = req.query;
    
    if (!number) {
        // Retourner toutes les connexions actives
        const activeConnections = Array.from(activeSockets.keys()).map(num => {
            const status = getConnectionStatus(num);
            return {
                number: num,
                status: 'connected',
                connectionTime: status.connectionTime,
                uptime: `${status.uptime} seconds`
            };
        });
        
        return res.json({
            totalActive: activeSockets.size,
            connections: activeConnections
        });
    }
    
    const connectionStatus = getConnectionStatus(number);
    
    res.json({
        number: number,
        isConnected: connectionStatus.isConnected,
        connectionTime: connectionStatus.connectionTime,
        uptime: `${connectionStatus.uptime} seconds`,
        message: connectionStatus.isConnected 
            ? 'Number is actively connected' 
            : 'Number is not connected'
    });
});

// Route pour déconnecter
router.get('/disconnect', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).json({ error: 'Number parameter is required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    if (!activeSockets.has(sanitizedNumber)) {
        return res.status(404).json({ 
            error: 'Number not found in active connections' 
        });
    }

    try {
        const socket = activeSockets.get(sanitizedNumber);
        
        // Fermer connexion
        await socket.ws.close();
        socket.ev.removeAllListeners();
        
        // Supprimer du tracking et de la base de données
        activeSockets.delete(sanitizedNumber);
        socketCreationTime.delete(sanitizedNumber);
        await removeNumberFromMongoDB(sanitizedNumber);
        await deleteSessionFromMongoDB(sanitizedNumber); // S'assurer que la session MongoDB est supprimée aussi
        
        console.log(`✅ Manually disconnected ${sanitizedNumber}`);
        
        res.json({ 
            status: 'success', 
            message: 'Number disconnected successfully' 
        });
        
    } catch (error) {
        console.error(`Error disconnecting ${sanitizedNumber}:`, error);
        res.status(500).json({ 
            error: 'Failed to disconnect number' 
        });
    }
});

// Route pour voir numéros actifs
router.get('/active', (req, res) => {
    res.json({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

// Route ping
router.get('/ping', (req, res) => {
    res.json({
        status: 'active',
        message: 'black pather is running',
        activeSessions: activeSockets.size,
        database: 'MongoDB Integrated'
    });
});

// Route pour reconnecter tous
router.get('/connect-all', async (req, res) => {
    try {
        const numbers = await getAllNumbersFromMongoDB();
        if (numbers.length === 0) {
            return res.status(404).json({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { 
                headersSent: false, 
                json: () => {}, 
                status: () => mockRes 
            };
            await startBot(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
            await delay(1000);
        }

        res.json({
            status: 'success',
            total: numbers.length,
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).json({ error: 'Failed to connect all bots' });
    }
});

// Route pour reconfigurer
router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).json({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).json({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).json({ error: 'No active session found for this number' });
    }

    // Générer OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Sauvegarder OTP dans MongoDB
    await saveOTPToMongoDB(sanitizedNumber, otp, newConfig);

    try {
        // Envoyer OTP
        const userJid = jidNormalizedUser(socket.user.id);
        await socket.sendMessage(userJid, {
            text: `*🔐 CONFIGURATION UPDATE*\n\nYour OTP: *${otp}*\nValid for 5 minutes\n\nUse: /verify-otp ${otp}`
        });
        
        res.json({ 
            status: 'otp_sent', 
            message: 'OTP sent to your number' 
        });
    } catch (error) {
        console.error('Failed to send OTP:', error);
        res.status(500).json({ error: 'Failed to send OTP' });
    }
});

// Route pour vérifier OTP
router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).json({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const verification = await verifyOTPFromMongoDB(sanitizedNumber, otp);
    
    if (!verification.valid) {
        return res.status(400).json({ error: verification.error });
    }

    try {
        await updateUserConfigInMongoDB(sanitizedNumber, verification.config);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                text: `*✅ CONFIG UPDATED*\n\nYour configuration has been successfully updated!\n\nChanges saved in MongoDB.`
            });
        }
        res.json({ 
            status: 'success', 
            message: 'Config updated successfully in MongoDB' 
        });
    } catch (error) {
        console.error('Failed to update config in MongoDB:', error);
        res.status(500).json({ error: 'Failed to update config' });
    }
});

// Route pour statistiques
router.get('/stats', async (req, res) => {
    const { number } = req.query;
    
    if (!number) {
        return res.status(400).json({ error: 'Number is required' });
    }
    
    try {
        const stats = await getStatsForNumber(number);
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const connectionStatus = getConnectionStatus(sanitizedNumber);
        
        res.json({
            number: sanitizedNumber,
            connectionStatus: connectionStatus.isConnected ? 'Connected' : 'Disconnected',
            uptime: connectionStatus.uptime,
            stats: stats
        });
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ error: 'Failed to get statistics' });
    }
});

// ==============================================================================
// 5. RECONNEXION AUTOMATIQUE AU DÉMARRAGE (non modifié)
// ==============================================================================

async function autoReconnectFromMongoDB() {
    try {
        console.log('🔁 Attempting auto-reconnect from MongoDB...');
        const numbers = await getAllNumbersFromMongoDB();
        
        if (numbers.length === 0) {
            console.log('ℹ️ No numbers found in MongoDB for auto-reconnect');
            return;
        }
        
        console.log(`📊 Found ${numbers.length} numbers in MongoDB`);
        
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                console.log(`🔁 Reconnecting: ${number}`);
                const mockRes = { 
                    headersSent: false, 
                    json: () => {}, 
                    status: () => mockRes 
                };
                await startBot(number, mockRes);
                await delay(2000); // Attendre entre chaque reconnexion
            } else {
                console.log(`✅ Already connected: ${number}`);
            }
        }
        
        console.log('✅ Auto-reconnect completed');
    } catch (error) {
        console.error('❌ autoReconnectFromMongoDB error:', error.message);
    }
}

// Démarrer reconnexion automatique après 3 secondes
setTimeout(() => {
    autoReconnectFromMongoDB();
}, 3000);

// ==============================================================================
// 6. CLEANUP ON EXIT (non modifié)
// ==============================================================================

process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    
    // Nettoyer sessions locales
    const sessionDir = path.join(__dirname, 'session');
    if (fs.existsSync(sessionDir)) {
        fs.emptyDirSync(sessionDir);
    }
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    // Redémarrer avec PM2 si configuré
    if (process.env.PM2_NAME) {
        const { exec } = require('child_process');
        exec(`pm2 restart ${process.env.PM2_NAME}`);
    }
});

module.exports = router;
