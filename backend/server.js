// backend/server.js
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

// --- CORS Configuration ---
app.use(cors({
    origin: '*', // For development, allow all origins. In production, specify your frontend URL.
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// --- PostgreSQL Database Connection ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// --- Database Schema Initialization with Retry Logic ---
async function initializeDbSchemaWithRetry(retries = 10, delay = 5000) { // Increased retries for robustness
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`Attempting to connect to database and initialize schema (Attempt ${i + 1}/${retries})...`);
            const client = await pool.connect();
            console.log('Database connected successfully.');

            await client.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    user_id VARCHAR(255) UNIQUE NOT NULL,
                    username VARCHAR(255) UNIQUE NOT NULL,
                    password_hash VARCHAR(255) NOT NULL,
                    is_admin BOOLEAN DEFAULT FALSE,
                    profile_photo_url VARCHAR(255) DEFAULT '/uploads/default-avatar.png', -- New: Default profile photo
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
                    channel_id INTEGER NOT NULL, -- New: Link to channel
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

            // Check and create a default channel if none exist
            const res = await client.query('SELECT COUNT(*) FROM channels');
            if (parseInt(res.rows[0].count) === 0) {
                console.log('No channels found. Creating a default "General" channel.');
                await client.query(
                    'INSERT INTO channels (name, created_by_user_id) VALUES ($1, $2)',
                    ['General', 'system'] // 'system' as a placeholder user_id for initial channel
                );
            }

            client.release(); // Release the client back to the pool
            console.log('Database schema initialized or already exists.');
            return; // Success, exit the retry loop
        } catch (err) {
            console.error(`Error connecting to database or initializing schema:`, err.message);
            if (i < retries - 1) {
                console.log(`Retrying in ${delay / 1000} seconds...`);
                await new Promise(res => setTimeout(res, delay));
            } else {
                console.error('Max retries reached. Could not connect to database or initialize schema.');
                // In a real application, you might want to exit the process here
                // process.exit(1);
            }
        }
    }
}

// Call the initialization function
initializeDbSchemaWithRetry();


// --- File Upload Setup (Multer) ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PROFILE_PHOTOS_DIR = path.join(UPLOADS_DIR, 'profile_photos');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR);
}
// Ensure profile photos directory exists
if (!fs.existsSync(PROFILE_PHOTOS_DIR)) {
    fs.mkdirSync(PROFILE_PHOTOS_DIR);
}

// Create a default avatar if it doesn't exist
const defaultAvatarPath = path.join(UPLOADS_DIR, 'default-avatar.png');
if (!fs.existsSync(defaultAvatarPath)) {
    // Create a simple placeholder image (1x1 transparent PNG)
    const defaultAvatarBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", 'base64');
    fs.writeFileSync(defaultAvatarPath, defaultAvatarBuffer);
    console.log('Default avatar created.');
}


const messageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR); // General uploads go here
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
const uploadMessageFile = multer({ storage: messageStorage });

const profilePhotoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, PROFILE_PHOTOS_DIR); // Profile photos go here
    },
    filename: (req, file, cb) => {
        // Use user ID to ensure unique profile photo per user
        cb(null, `${req.user.userId}-${file.originalname}`);
    }
});
const uploadProfilePhoto = multer({ storage: profilePhotoStorage });


// Serve uploaded files statically
app.use('/uploads', express.static(UPLOADS_DIR));

// --- JWT Secret ---
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';

// --- Middleware for JWT Authentication ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user; // Contains userId, userName, isAdmin, profilePhotoUrl
        next();
    });
};

// --- Middleware for Admin Authorization ---
const authorizeAdmin = (req, res, next) => {
    if (!req.user || !req.user.isAdmin) {
        return res.status(403).json({ message: 'Access denied: Admin privileges required.' });
    }
    next();
};

// --- Authentication Endpoints ---

// Register User
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const userId = `user_${Date.now()}`;

        const result = await pool.query(
            'INSERT INTO users (user_id, username, password_hash) VALUES ($1, $2, $3) RETURNING user_id, username, is_admin, profile_photo_url',
            [userId, username, hashedPassword]
        );
        const newUser = result.rows[0];

        const token = jwt.sign(
            {
                userId: newUser.user_id,
                userName: newUser.username,
                isAdmin: newUser.is_admin,
                profilePhotoUrl: newUser.profile_photo_url
            },
            JWT_SECRET,
            { expiresIn: '8h' } // Token valid for 8 hours
        );

        res.status(201).json({
            message: 'User registered successfully',
            token,
            userId: newUser.user_id,
            userName: newUser.username,
            isAdmin: newUser.is_admin,
            profilePhotoUrl: newUser.profile_photo_url
        });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'Username already exists.' });
        }
        console.error('Registration error:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// Login User
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required.' });
    }

    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];

        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials.' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) {
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
            { expiresIn: '8h' } // Token valid for 8 hours
        );

        res.json({
            message: 'Logged in successfully',
            token,
            userId: user.user_id,
            userName: user.username,
            isAdmin: user.is_admin,
            profilePhotoUrl: user.profile_photo_url
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// --- User Profile Endpoints ---
app.put('/api/profile', authenticateToken, async (req, res) => {
    const { userName } = req.body; // Only allow updating username for now
    const { userId } = req.user;

    if (!userName || userName.trim() === '') {
        return res.status(400).json({ message: 'Display name cannot be empty.' });
    }

    try {
        const result = await pool.query(
            'UPDATE users SET username = $1 WHERE user_id = $2 RETURNING user_id, username, is_admin, profile_photo_url',
            [userName, userId]
        );
        const updatedUser = result.rows[0];

        if (!updatedUser) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Generate a new token with updated user info
        const newToken = jwt.sign(
            {
                userId: updatedUser.user_id,
                userName: updatedUser.username,
                isAdmin: updatedUser.is_admin,
                profilePhotoUrl: updatedUser.profile_photo_url
            },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.json({
            message: 'Profile updated successfully',
            token: newToken, // Send new token
            userId: updatedUser.user_id,
            userName: updatedUser.username,
            isAdmin: updatedUser.is_admin,
            profilePhotoUrl: updatedUser.profile_photo_url
        });
    } catch (err) {
        if (err.code === '23505') { // Unique violation for username
            return res.status(409).json({ message: 'This display name is already taken.' });
        }
        console.error('Error updating profile:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.post('/api/profile/photo', authenticateToken, uploadProfilePhoto.single('profilePhoto'), async (req, res) => {
    const { userId } = req.user;
    const file = req.file;

    if (!file) {
        return res.status(400).json({ message: 'No profile photo uploaded.' });
    }

    try {
        const photoUrl = `/uploads/profile_photos/${file.filename}`;

        const result = await pool.query(
            'UPDATE users SET profile_photo_url = $1 WHERE user_id = $2 RETURNING user_id, username, is_admin, profile_photo_url',
            [photoUrl, userId]
        );
        const updatedUser = result.rows[0];

        if (!updatedUser) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Generate a new token with updated user info
        const newToken = jwt.sign(
            {
                userId: updatedUser.user_id,
                userName: updatedUser.username,
                isAdmin: updatedUser.is_admin,
                profilePhotoUrl: updatedUser.profile_photo_url
            },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.json({
            message: 'Profile photo updated successfully',
            token: newToken, // Send new token
            userId: updatedUser.user_id,
            userName: updatedUser.username,
            isAdmin: updatedUser.is_admin,
            profilePhotoUrl: updatedUser.profile_photo_url
        });
    } catch (err) {
        console.error('Error uploading profile photo:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});


// --- Channel Endpoints ---
app.get('/api/channels', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM channels ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching channels:', err);
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
        if (err.code === '23505') { // Unique violation for channel name
            return res.status(409).json({ message: 'Channel with this name already exists.' });
        }
        console.error('Error creating channel:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});


// --- Chat Endpoints (Modified for Channels and Pagination) ---

// Get Messages for a specific channel with pagination
app.get('/api/messages/:channelId', authenticateToken, async (req, res) => {
    const { channelId } = req.params;
    const limit = parseInt(req.query.limit) || 20; // Default limit to 20
    const beforeId = req.query.beforeId; // Cursor for older messages (load more)
    const sinceId = req.query.sinceId; // Cursor for newer messages (polling)

    let queryText = `
        SELECT m.*, u.profile_photo_url
        FROM messages m
        JOIN users u ON m.user_id = u.user_id
        WHERE m.channel_id = $1
    `;
    const queryParams = [channelId];
    let orderByClause = 'ORDER BY m.id DESC'; // Default order for fetching latest or older

    if (beforeId) {
        queryText += ` AND m.id < $${queryParams.length + 1}`;
        queryParams.push(beforeId);
    } else if (sinceId) {
        queryText += ` AND m.id > $${queryParams.length + 1}`;
        queryParams.push(sinceId);
        orderByClause = 'ORDER BY m.id ASC'; // For new messages, order ascending
    }

    queryText += ` ${orderByClause} LIMIT $${queryParams.length + 1}`;
    queryParams.push(limit + 1); // Fetch one more to check if there are more messages

    try {
        const result = await pool.query(queryText, queryParams);
        let fetchedMessages = result.rows;

        const hasMore = fetchedMessages.length > limit;
        const messagesToSend = hasMore ? fetchedMessages.slice(0, limit) : fetchedMessages;

        // If fetching new messages, they are already in chronological order (due to ASC order by ID)
        // If fetching older messages, they were fetched DESC and need to be reversed for chronological display
        if (!sinceId) { // Only reverse if not fetching new messages
            messagesToSend.reverse();
        }

        res.json({ messages: messagesToSend, hasMore });

    } catch (err) {
        console.error('Error fetching messages for channel:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// Send Message to a specific channel
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
        console.error('Error sending message:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// File Upload to a specific channel
app.post('/api/upload/:channelId', authenticateToken, uploadMessageFile.single('file'), async (req, res) => {
    const { channelId } = req.params;
    const { userId, userName } = req.user;
    const file = req.file;

    if (!file) {
        return res.status(400).json({ message: 'No file uploaded.' });
    }

    try {
        const fileUrl = `/uploads/${file.filename}`;
        const result = await pool.query(
            'INSERT INTO messages (channel_id, user_id, username, file_url, file_name, file_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [channelId, userId, userName, fileUrl, file.originalname, file.mimetype]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error uploading file:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// --- Admin Endpoints ---

// Get All Users (Admin Only)
app.get('/api/admin/users', authenticateToken, authorizeAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT user_id, username, is_admin, created_at, last_login, profile_photo_url FROM users ORDER BY created_at ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching users (admin):', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// Toggle Admin Status (Admin Only)
app.post('/api/admin/users/:userId/toggle-admin', authenticateToken, authorizeAdmin, async (req, res) => {
    const { userId } = req.params;
    const { isAdmin } = req.body;

    if (req.user.userId === userId) {
        return res.status(400).json({ message: 'You cannot change your own admin status.' });
    }

    try {
        const result = await pool.query(
            'UPDATE users SET is_admin = $1 WHERE user_id = $2 RETURNING user_id, username, is_admin, profile_photo_url',
            [isAdmin, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }
        res.json({ message: 'Admin status updated successfully', user: result.rows[0] });
    } catch (err) {
        console.error('Error toggling admin status:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// Delete Message (Admin Only)
app.delete('/api/admin/messages/:messageId', authenticateToken, authorizeAdmin, async (req, res) => {
    const { messageId } = req.params;
    try {
        const result = await pool.query('DELETE FROM messages WHERE id = $1 RETURNING *', [messageId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Message not found.' });
        }
        // Also delete the associated file if it exists
        if (result.rows[0].file_url && result.rows[0].file_url.startsWith('/uploads/')) {
            const filePath = path.join(UPLOADS_DIR, path.basename(result.rows[0].file_url));
            fs.unlink(filePath, (err) => {
                if (err) console.error('Error deleting file from disk:', err);
                else console.log('File deleted from disk:', filePath);
            });
        }
        res.json({ message: 'Message deleted successfully' });
    } catch (err) {
        console.error('Error deleting message:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});


// Start the server
app.listen(port, () => {
    console.log(`Backend server listening on port ${port}`);
});
