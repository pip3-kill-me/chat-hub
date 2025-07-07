// backend/server.js
const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const { WebSocketServer } = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

// --- Create HTTP and WebSocket Servers ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- CORS Configuration ---
// List of domains that are allowed to make requests to this server
const whitelist = [
    'http://localhost:3000',          // For local React development
    'http://localhost:8281',          // For accessing the Docker container locally
    'https://chathub.plets.win'       // Your deployed production site
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    if (whitelist.indexOf(origin) !== -1) {
      // If the origin is in our whitelist, allow it
      callback(null, true);
    } else {
      // Otherwise, block it
      callback(new Error('Not allowed by CORS'));
    }
  }
};

// Use the new flexible CORS options
app.use(cors(corsOptions));


app.use(express.json());

// --- JWT Secret ---
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';

// --- WebSocket Signaling Logic ---
const clients = new Map();

wss.on('connection', (ws) => {
    const clientId = `user_${Date.now()}`;
    clients.set(clientId, { ws });
    console.log(`Client ${clientId} connected, waiting for auth`);

    const authTimeout = setTimeout(() => {
        if (!clients.get(clientId)?.userInfo) {
            console.log(`Client ${clientId} failed to auth in time, disconnecting.`);
            ws.close();
        }
    }, 5000);

    ws.on('message', (message) => {
        const parsedMessage = JSON.parse(message);
        const { type, payload } = parsedMessage;
        const clientData = clients.get(clientId);

        if (type === 'auth' && !clientData.userInfo) {
            try {
                const decoded = jwt.verify(payload.token, JWT_SECRET);
                clientData.userInfo = {
                    userId: decoded.userId,
                    userName: decoded.userName,
                    profilePhotoUrl: decoded.profilePhotoUrl,
                };
                clearTimeout(authTimeout);
                console.log(`Client ${clientId} authenticated as ${decoded.userName}`);

                const existingPeers = Array.from(clients.values())
                    .filter(c => c.userInfo && c.userInfo.userId !== decoded.userId)
                    .map(c => ({ clientId: c.clientId, ...c.userInfo }));

                ws.send(JSON.stringify({
                    type: 'connection-success',
                    payload: { clientId, existingPeers }
                }));

                const newPeerPayload = { clientId, ...clientData.userInfo };
                for (const [id, c] of clients) {
                    if (id !== clientId && c.userInfo) {
                        c.ws.send(JSON.stringify({ type: 'new-peer', payload: newPeerPayload }));
                    }
                }
                return;
            } catch (err) {
                console.log(`Client ${clientId} auth failed`, err.message);
                ws.close();
                return;
            }
        }
        
        if (!clientData.userInfo) return;

        const { targetClientId } = payload;
        const targetClient = clients.get(targetClientId);

        if (targetClient && targetClient.userInfo) {
            const relayMessage = JSON.stringify({
                type,
                payload: { ...payload, sourceClientId: clientId }
            });
            targetClient.ws.send(relayMessage);
        }
    });

    ws.on('close', () => {
        clearTimeout(authTimeout);
        const clientData = clients.get(clientId);
        if (clientData && clientData.userInfo) {
            console.log(`Client ${clientId} (${clientData.userInfo.userName}) disconnected`);
            const peerLeftMessage = JSON.stringify({ type: 'peer-left', payload: { clientId } });
            for (const [id, c] of clients) {
                if (id !== clientId && c.userInfo) {
                    c.ws.send(peerLeftMessage);
                }
            }
        } else {
            console.log(`Unauthenticated client ${clientId} disconnected`);
        }
        clients.delete(clientId);
    });
});


// --- PostgreSQL Database Connection ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// --- Database Schema Initialization with Retry Logic ---
async function initializeDbSchemaWithRetry(retries = 10, delay = 5000) {
    for (let i = 0; i < retries; i++) {
        try {
            const client = await pool.connect();
            console.log('Database connected successfully.');

            await client.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    user_id VARCHAR(255) UNIQUE NOT NULL,
                    username VARCHAR(255) UNIQUE NOT NULL,
                    password_hash VARCHAR(255) NOT NULL,
                    is_admin BOOLEAN DEFAULT FALSE,
                    profile_photo_url VARCHAR(255) DEFAULT '/uploads/default-avatar.svg',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS channels (
                    id SERIAL PRIMARY KEY,
                    name VARCHAR(255) UNIQUE NOT NULL,
                    created_by_user_id VARCHAR(255) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id SERIAL PRIMARY KEY,
                    channel_id INTEGER NOT NULL,
                    user_id VARCHAR(255) NOT NULL,
                    username VARCHAR(255) NOT NULL,
                    text TEXT,
                    file_url VARCHAR(255),
                    file_name VARCHAR(255),
                    file_type VARCHAR(255),
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
                );
            `);
            const res = await client.query('SELECT COUNT(*) FROM channels');
            if (parseInt(res.rows[0].count) === 0) {
                await client.query(
                    'INSERT INTO channels (name, created_by_user_id) VALUES ($1, $2)',
                    ['General', 'system']
                );
            }
            client.release();
            console.log('Database schema initialized or already exists.');
            return;
        } catch (err) {
            console.error(`Error connecting to database or initializing schema:`, err.message);
            if (i < retries - 1) {
                await new Promise(res => setTimeout(res, delay));
            } else {
                console.error('Max retries reached. Could not connect to database or initialize schema.');
            }
        }
    }
}
initializeDbSchemaWithRetry();


// --- File Upload Setup (Multer) ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PROFILE_PHOTOS_DIR = path.join(UPLOADS_DIR, 'profile_photos');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(PROFILE_PHOTOS_DIR)) fs.mkdirSync(PROFILE_PHOTOS_DIR);

const defaultAvatarPath = path.join(UPLOADS_DIR, 'default-avatar.svg');
if (!fs.existsSync(defaultAvatarPath)) {
    const defaultAvatarSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.5">
  <path d="M12 12C14.2091 12 16 10.2091 16 8C16 5.79086 14.2091 4 12 4C9.79086 4 8 5.79086 8 8C8 10.2091 9.79086 12 12 12Z" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M20 21C20 16.5817 16.4183 13 12 13C7.58172 13 4 16.5817 4 21" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
    `;
    fs.writeFileSync(defaultAvatarPath, defaultAvatarSvg.trim());
    console.log('Default SVG avatar created.');
}

const messageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const uploadMessageFile = multer({ storage: messageStorage });

const profilePhotoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, PROFILE_PHOTOS_DIR),
    filename: (req, file, cb) => cb(null, `${req.user.userId}-${file.originalname}`)
});
const uploadProfilePhoto = multer({ storage: profilePhotoStorage });

app.use('/uploads', express.static(UPLOADS_DIR));


// --- Middleware ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

const authorizeAdmin = (req, res, next) => {
    if (!req.user || !req.user.isAdmin) {
        return res.status(403).json({ message: 'Access denied: Admin privileges required.' });
    }
    next();
};

// --- API Endpoints ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Username and password are required.' });
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const userId = `user_${Date.now()}`;
        const result = await pool.query(
            'INSERT INTO users (user_id, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id, username, is_admin, profile_photo_url',
            [userId, username, hashedPassword]
        );
        const newUser = result.rows[0];
        const token = jwt.sign(
            { userId: newUser.user_id, userName: newUser.username, isAdmin: newUser.is_admin, profilePhotoUrl: newUser.profile_photo_url },
            JWT_SECRET,
            { expiresIn: '8h' }
        );
        res.status(201).json({ token, userId: newUser.user_id, userName: newUser.username, isAdmin: newUser.is_admin, profilePhotoUrl: newUser.profile_photo_url });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: 'Username already exists.' });
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Username and password are required.' });
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user || !await bcrypt.compare(password, user.password_hash)) {
            return res.status(401).json({ message: 'Invalid credentials.' });
        }
        await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE user_id = $1', [user.user_id]);
        
        const token = jwt.sign(
            {
                userId: user.user_id,
                userName: user.username,
                isAdmin: user.is_admin,
                profilePhotoUrl: user.profile_photo_url
            },
            JWT_SECRET,
            { expiresIn: '8h' }
        );
        
        const { password_hash, ...userPayload } = user;
        res.json({ token, ...userPayload });
    } catch (err) {
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.put('/api/profile', authenticateToken, async (req, res) => {
    const { userId } = req.user;
    const { userName } = req.body;
    if (!userName || userName.trim() === '') return res.status(400).json({ message: 'Display name cannot be empty.' });
    try {
        const result = await pool.query(
            'UPDATE users SET username = $1 WHERE user_id = $2 RETURNING user_id, username, is_admin, profile_photo_url',
            [userName, userId]
        );
        const updatedUser = result.rows[0];
        if (!updatedUser) return res.status(404).json({ message: 'User not found.' });
        
        const newToken = jwt.sign(
            { userId: updatedUser.user_id, userName: updatedUser.username, isAdmin: updatedUser.is_admin, profilePhotoUrl: updatedUser.profile_photo_url },
            JWT_SECRET,
            { expiresIn: '8h' }
        );
        res.json({ token: newToken, userId: updatedUser.user_id, userName: updatedUser.username, isAdmin: updatedUser.is_admin, profilePhotoUrl: updatedUser.profile_photo_url });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: 'This display name is already taken.' });
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.post('/api/profile/photo', authenticateToken, uploadProfilePhoto.single('profilePhoto'), async (req, res) => {
    const { userId } = req.user;
    if (!req.file) return res.status(400).json({ message: 'No profile photo uploaded.' });
    try {
        const photoUrl = `/uploads/profile_photos/${req.file.filename}`;
        const result = await pool.query(
            'UPDATE users SET profile_photo_url = $1 WHERE user_id = $2 RETURNING user_id, username, is_admin, profile_photo_url',
            [photoUrl, userId]
        );
        const updatedUser = result.rows[0];
        if (!updatedUser) return res.status(404).json({ message: 'User not found.' });
        
        const newToken = jwt.sign(
            { userId: updatedUser.user_id, userName: updatedUser.username, isAdmin: updatedUser.is_admin, profilePhotoUrl: updatedUser.profile_photo_url },
            JWT_SECRET,
            { expiresIn: '8h' }
        );
        res.json({ token: newToken, userId: updatedUser.user_id, userName: updatedUser.username, isAdmin: updatedUser.is_admin, profilePhotoUrl: updatedUser.profile_photo_url });
    } catch (err) {
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.get('/api/channels', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM channels ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.post('/api/channels', authenticateToken, async (req, res) => {
    const { name } = req.body;
    const { userId } = req.user;
    if (!name || name.trim() === '') {
        return res.status(400).json({ message: 'Channel name cannot be empty.' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO channels (name, created_by_user_id) VALUES ($1, $2) RETURNING *',
            [name, userId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'Channel with this name already exists.' });
        }
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.get('/api/messages/:channelId', authenticateToken, async (req, res) => {
    const { channelId } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    const beforeId = req.query.beforeId;
    const sinceId = req.query.sinceId;

    let queryText = `SELECT m.*, u.profile_photo_url FROM messages m JOIN users u ON m.user_id = u.user_id WHERE m.channel_id = $1`;
    const queryParams = [channelId];
    let orderByClause = 'ORDER BY m.id DESC';

    if (beforeId) {
        queryText += ` AND m.id < $${queryParams.length + 1}`;
        queryParams.push(beforeId);
    } else if (sinceId) {
        queryText += ` AND m.id > $${queryParams.length + 1}`;
        orderByClause = 'ORDER BY m.id ASC';
    }

    queryText += ` ${orderByClause} LIMIT $${queryParams.length + 1}`;
    queryParams.push(limit + 1);

    try {
        const result = await pool.query(queryText, queryParams);
        let messages = result.rows;
        const hasMore = messages.length > limit;
        if (hasMore) messages = messages.slice(0, limit);
        if (!sinceId) messages.reverse();
        res.json({ messages, hasMore });
    } catch (err) {
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.post('/api/messages/:channelId', authenticateToken, async (req, res) => {
    const { channelId } = req.params;
    const { text } = req.body;
    const { userId, userName } = req.user;
    if (!text || text.trim() === '') {
        return res.status(400).json({ message: 'Message text cannot be empty.' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO messages (channel_id, user_id, username, text) VALUES ($1, $2, $3, $4) RETURNING *',
            [channelId, userId, userName, text]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.post('/api/upload/:channelId', authenticateToken, uploadMessageFile.single('file'), async (req, res) => {
    const { channelId } = req.params;
    const { userId, userName } = req.user;
    if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
    try {
        const fileUrl = `/uploads/${req.file.filename}`;
        const result = await pool.query(
            'INSERT INTO messages (channel_id, user_id, username, file_url, file_name, file_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [channelId, userId, userName, fileUrl, req.file.originalname, req.file.mimetype]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.get('/api/admin/users', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT user_id, username, is_admin, created_at, last_login, profile_photo_url FROM users ORDER BY created_at ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.post('/api/admin/users/:userId/toggle-admin', authenticateToken, authorizeAdmin, async (req, res) => {
    const { userId: targetUserId } = req.params;
    const { userId: adminUserId } = req.user;
    if (adminUserId === targetUserId) {
        return res.status(400).json({ message: 'You cannot change your own admin status.' });
    }
    try {
        const result = await pool.query(
            'UPDATE users SET is_admin = $1 WHERE user_id = $2 RETURNING user_id, username, is_admin, profile_photo_url',
            [req.body.isAdmin, targetUserId]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'User not found.' });
        res.json({ message: 'Admin status updated successfully', user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.delete('/api/admin/messages/:messageId', authenticateToken, authorizeAdmin, async (req, res) => {
    const { messageId } = req.params;
    try {
        const result = await pool.query('DELETE FROM messages WHERE id = $1 RETURNING *', [messageId]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'Message not found.' });
        if (result.rows[0].file_url) {
            const filePath = path.join(__dirname, result.rows[0].file_url);
            fs.unlink(filePath, (err) => {
                if (err) console.error('Error deleting file from disk:', err);
            });
        }
        res.json({ message: 'Message deleted successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// Start the server
server.listen(port, () => {
    console.log(`Backend server listening on port ${port}`);
});