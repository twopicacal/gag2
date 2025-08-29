const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();

// Environment variables
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Import authentication routes
const authRoutes = require('./auth');
app.use('/api/auth', authRoutes);

// Admin routes
const adminModule = require('./admin');
app.use('/api/admin', adminModule.router);

// Database setup
const db = new sqlite3.Database('./garden_game.db');

// Initialize database tables
db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME,
        last_login_ip TEXT,
        registration_ip TEXT,
        device_fingerprint TEXT,
        is_online BOOLEAN DEFAULT 0,
        is_banned BOOLEAN DEFAULT 0,
        ban_reason TEXT,
        is_admin BOOLEAN DEFAULT 0
    )`);

    // Banned IPs table
    db.run(`CREATE TABLE IF NOT EXISTS banned_ips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_address TEXT UNIQUE NOT NULL,
        reason TEXT,
        banned_by_admin_id TEXT,
        banned_by_admin_username TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (banned_by_admin_id) REFERENCES users (id)
    )`);

    // Banned devices table
    db.run(`CREATE TABLE IF NOT EXISTS banned_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_fingerprint TEXT UNIQUE NOT NULL,
        reason TEXT,
        banned_by_admin_id TEXT,
        banned_by_admin_username TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (banned_by_admin_id) REFERENCES users (id)
    )`);

    // Admin logs table
    db.run(`CREATE TABLE IF NOT EXISTS admin_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id TEXT NOT NULL,
        admin_username TEXT NOT NULL,
        action TEXT NOT NULL,
        target_user_id TEXT,
        target_username TEXT,
        details TEXT,
        ip_address TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (admin_id) REFERENCES users (id),
        FOREIGN KEY (target_user_id) REFERENCES users (id)
    )`, function(err) {
        if (err) {
            console.error('❌ Error creating admin_logs table:', err);
        } else {
            console.log('✅ Admin logs table ready');
        }
    });

    // User mutes table
    db.run(`CREATE TABLE IF NOT EXISTS user_mutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        muted_until DATETIME,
        mute_reason TEXT,
        muted_by_admin_id TEXT,
        muted_by_admin_username TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id),
        FOREIGN KEY (muted_by_admin_id) REFERENCES users (id)
    )`, function(err) {
        if (err) {
            console.error('❌ Error creating user_mutes table:', err);
        } else {
            console.log('✅ User mutes table ready');
        }
    });

    // Security logs table (legacy - will be migrated to admin_logs)
    db.run(`CREATE TABLE IF NOT EXISTS security_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        username TEXT,
        action TEXT NOT NULL,
        ip_address TEXT,
        device_fingerprint TEXT,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`, function(err) {
        if (err) {
            console.error('❌ Error creating security_logs table:', err);
        } else {
            console.log('✅ Security logs table ready (legacy)');
        }
    });

    // Gardens table
    db.run(`CREATE TABLE IF NOT EXISTS gardens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        slot_number INTEGER NOT NULL,
        garden_data TEXT NOT NULL,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_public BOOLEAN DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users (id)
    )`, function(err) {
        if (err) {
            console.error('❌ Error creating gardens table:', err);
        } else {
            console.log('✅ Gardens table ready');
            
            // Migration: Add slot_number column if it doesn't exist
            db.all(`PRAGMA table_info(gardens)`, (err, columns) => {
                if (err) {
                    console.error('❌ Error checking gardens table schema:', err);
                    return;
                }
                
                if (columns && columns.length > 0) {
                    const hasSlotNumber = columns.some(col => col.name === 'slot_number');
                    if (!hasSlotNumber) {
                        console.log('🔄 Adding slot_number column to gardens table...');
                        db.run(`ALTER TABLE gardens ADD COLUMN slot_number INTEGER DEFAULT 1`, (err) => {
                            if (err) {
                                console.error('❌ Error adding slot_number column:', err);
                            } else {
                                console.log('✅ slot_number column added to gardens table');
                            }
                        });
                    } else {
                        console.log('✅ slot_number column already exists in gardens table');
                    }
                } else {
                    console.log('⚠️ No columns found in gardens table');
                }
            });
            
            // Migration: Handle existing gardens without slot information
            db.run(`UPDATE gardens SET slot_number = 1 WHERE slot_number IS NULL`, function(err) {
                if (err) {
                    console.error('❌ Error migrating gardens:', err);
                } else {
                    console.log('✅ Gardens migration completed');
                }
            });
        }
    });

    // Friends table
    db.run(`CREATE TABLE IF NOT EXISTS friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        friend_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id),
        FOREIGN KEY (friend_id) REFERENCES users (id),
        UNIQUE(user_id, friend_id)
    )`);

    // Chat messages table
    db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id TEXT NOT NULL,
        receiver_id TEXT,
        message TEXT NOT NULL,
        message_type TEXT DEFAULT 'text',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_id) REFERENCES users (id),
        FOREIGN KEY (receiver_id) REFERENCES users (id)
    )`, function(err) {
        if (err) {
            console.error('❌ Error creating chat_messages table:', err);
        } else {
            console.log('✅ Chat messages table ready');
        }
    });

    // Announcements table
    db.run(`CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id TEXT NOT NULL,
        admin_username TEXT NOT NULL,
        message TEXT NOT NULL,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (admin_id) REFERENCES users (id)
    )`, function(err) {
        if (err) {
            console.error('❌ Error creating announcements table:', err);
        } else {
            console.log('✅ Announcements table ready');
        }
    });

    // Chat filter words table
    db.run(`CREATE TABLE IF NOT EXISTS chat_filter_words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        word TEXT UNIQUE NOT NULL,
        added_by_admin_id TEXT NOT NULL,
        added_by_admin_username TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (added_by_admin_id) REFERENCES users (id)
    )`, function(err) {
        if (err) {
            console.error('❌ Error creating chat_filter_words table:', err);
        } else {
            console.log('✅ Chat filter words table ready');
            
            // Add default filter words if table is empty
            db.get('SELECT COUNT(*) as count FROM chat_filter_words', (err, result) => {
                if (!err && result.count === 0) {
                    const defaultWords = ['hack', 'cheat', 'exploit', 'scam', 'spam'];
                    defaultWords.forEach(word => {
                        db.run('INSERT INTO chat_filter_words (word, added_by_admin_id, added_by_admin_username) VALUES (?, ?, ?)', 
                            [word, 'system', 'System']);
                    });
                    console.log('✅ Default chat filter words added');
                }
            });
        }
    });
}); // Close db.serialize block

// JWT secret (in production, use environment variable)
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// Store online users
const onlineUsers = new Map();
const userSockets = new Map();

// Set WebSocket maps in admin module
adminModule.setWebSocketMaps(userSockets, onlineUsers);

// Authentication middleware for Socket.IO
const authenticateSocketToken = (socket, next) => {
    try {
        const token = socket.handshake.auth.token;
        
        if (!token) {
            return next(new Error('Authentication token required'));
        }
        
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Check if user is banned or muted
        db.get(`
            SELECT u.is_banned, u.ban_reason, u.is_admin,
                   um.muted_until, um.mute_reason
            FROM users u
            LEFT JOIN user_mutes um ON u.id = um.user_id 
                AND (um.muted_until IS NULL OR um.muted_until > datetime('now'))
            WHERE u.id = ?
        `, [decoded.id], (err, user) => {
            if (err) {
                return next(new Error('Database error'));
            }
            
            if (!user) {
                return next(new Error('User not found'));
            }
            
            if (user.is_banned) {
                return next(new Error(`Account banned: ${user.ban_reason || 'No reason provided'}`));
            }
            
            // Check if user is permanently muted (only permanent mutes should block connections)
            // REMOVED: Permanent mutes should not block connections, only prevent chat
            // if (user.muted_until === null && user.mute_reason !== null) {
            //     // Permanent mute - prevent connection entirely
            //     const muteMessage = `Account permanently muted: ${user.mute_reason || 'No reason provided'}`;
            //     console.log(`🚫 Blocking connection for permanently muted user: ${decoded.username} - ${muteMessage}`);
            //     return next(new Error(muteMessage));
            // }
            
            socket.userId = decoded.id;
            socket.username = decoded.username;
            socket.isAdmin = !!user.is_admin;
            next();
        });
    } catch (error) {
        return next(new Error('Invalid token'));
    }
};

// Socket.IO connection handling
io.use(authenticateSocketToken);

io.on('connection', (socket) => {
    try {
        console.log(`🟢 User ONLINE: ${socket.username} (ID: ${socket.userId})`);
        
        // Add user to online list
        onlineUsers.set(socket.userId, {
            id: socket.userId,
            username: socket.username,
            socketId: socket.id,
            lastSeen: Date.now()
        });
        userSockets.set(socket.userId, socket);

        // Update user online status in database
        db.run('UPDATE users SET is_online = 1, last_login = CURRENT_TIMESTAMP WHERE id = ?', [socket.userId]);

        // Join user to their personal room
        socket.join(`user_${socket.userId}`);

        // Notify friends that user is online
        db.all('SELECT friend_id FROM friends WHERE user_id = ? AND status = "accepted"', [socket.userId], (err, friends) => {
            if (!err && friends) {
                friends.forEach(friend => {
                    const friendSocket = userSockets.get(friend.friend_id);
                    if (friendSocket) {
                        friendSocket.emit('friend_online', {
                            userId: socket.userId,
                            username: socket.username
                        });
                    }
                });
            }
        });

        // Handle garden updates
        socket.on('garden_update', (gardenData) => {
            try {
                // Save garden data to database with slot information
                const gardenJson = JSON.stringify(gardenData);
                const slot = gardenData.saveSlot || 1;
                const gardenId = `garden_${socket.userId}_slot_${slot}`;
                
                // Try to save with slot_number first, fallback to old format if needed
                db.run(
                    'INSERT OR REPLACE INTO gardens (id, user_id, slot_number, garden_data, last_updated) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
                    [gardenId, socket.userId, slot, gardenJson],
                    function(err) {
                        if (err) {
                            console.error('❌ Error saving garden update with slot_number:', err);
                            // Fallback to old format without slot_number
                            db.run(
                                'INSERT OR REPLACE INTO gardens (id, user_id, garden_data, last_updated) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
                                [gardenId, socket.userId, gardenJson],
                                function(fallbackErr) {
                                    if (fallbackErr) {
                                        console.error('❌ Fallback save also failed:', fallbackErr);
                                    }
                                }
                            );
                            return;
                        }
                    }
                );

                // Broadcast to friends if garden is public (simplified query)
                db.get('SELECT is_public FROM gardens WHERE user_id = ?', [socket.userId], (err, row) => {
                    if (err) {
                        console.error('❌ Error checking garden public status:', err);
                        return;
                    }
                    
                    if (row && row.is_public) {
                        // Get friends list
                        db.all('SELECT friend_id FROM friends WHERE user_id = ? AND status = "accepted"', [socket.userId], (err, friends) => {
                            if (err) {
                                console.error('❌ Error getting friends list:', err);
                                return;
                            }
                            
                            if (friends) {
                                friends.forEach(friend => {
                                    const friendSocket = userSockets.get(friend.friend_id);
                                    if (friendSocket) {
                                        friendSocket.emit('friend_garden_update', {
                                            userId: socket.userId,
                                            username: socket.username,
                                            gardenData: gardenData,
                                            slot: slot
                                        });
                                    }
                                });
                            }
                        });
                    }
                });
            } catch (error) {
                console.error('❌ Error handling garden update:', error);
            }
        });

        // Handle garden visit requests
        socket.on('visit_garden', (targetUserId) => {
            // Check if target user is online
            const targetSocket = userSockets.get(targetUserId);
            if (targetSocket) {
                targetSocket.emit('garden_visit_request', {
                    visitorId: socket.userId,
                    visitorName: socket.username
                });
            }
        });

        // Handle garden visit responses
        socket.on('garden_visit_response', (data) => {
            const visitorSocket = userSockets.get(data.visitorId);
            if (visitorSocket) {
                visitorSocket.emit('garden_visit_result', {
                    allowed: data.allowed,
                    gardenData: data.gardenData,
                    ownerName: socket.username
                });
            }
        });

        // Handle chat messages
        socket.on('send_message', (data) => {
            try {
                // Validate input
                if (!data || !data.message) {
                    socket.emit('message_sent', { 
                        success: false, 
                        error: 'Invalid message data' 
                    });
                    return;
                }

                // Check if user is muted
                db.get(`
                    SELECT muted_until, mute_reason 
                    FROM user_mutes 
                    WHERE user_id = ? AND (muted_until IS NULL OR muted_until > datetime('now', 'localtime'))
                `, [socket.userId], (err, muteData) => {
                    if (err) {
                        console.error('Error checking mute status:', err);
                        socket.emit('message_sent', { 
                            success: false, 
                            error: 'Server error checking mute status' 
                        });
                        return;
                    }

                    if (muteData) {
                        if (muteData.muted_until === null) {
                            // Permanent mute
                            const muteMessage = `You are permanently muted: ${muteData.mute_reason || 'No reason provided'}`;
                            console.log(`🚫 MESSAGE BLOCKED - Permanently muted user ${socket.username}: ${muteData.mute_reason || 'No reason'}`);
                            socket.emit('message_sent', { 
                                success: false, 
                                error: muteMessage 
                            });
                            return;
                        } else {
                            // Temporary mute - check if still active
                            const now = new Date();
                            const muteUntil = new Date(muteData.muted_until);
                            if (muteUntil > now) {
                                const muteUntilDate = new Date(muteData.muted_until);
                                const muteMessage = `You are muted until ${muteUntilDate.toLocaleString()}: ${muteData.mute_reason || 'No reason provided'}`;
                                console.log(`🚫 MESSAGE BLOCKED - Temporarily muted user ${socket.username} until ${muteUntilDate.toLocaleString()}: ${muteData.mute_reason || 'No reason'}`);
                                socket.emit('message_sent', { 
                                    success: false, 
                                    error: muteMessage 
                                });
                                return;
                            }
                        }
                    }

                    // Check chat filter
                    db.all('SELECT word FROM chat_filter_words', (err, filterWords) => {
                        if (err) {
                            console.error('Error checking chat filter:', err);
                            // Continue without filter if there's an error
                        }

                        let filteredMessage = data.message;
                        let messageBlocked = false;
                        let blockedWords = [];

                        if (filterWords && filterWords.length > 0) {
                            const messageLower = data.message.toLowerCase();
                            filterWords.forEach(filterWord => {
                                if (messageLower.includes(filterWord.word.toLowerCase())) {
                                    messageBlocked = true;
                                    blockedWords.push(filterWord.word);
                                }
                            });

                            if (messageBlocked && !socket.isAdmin) {
                                console.log(`🚫 MESSAGE BLOCKED - Filtered content from ${socket.username}: ${blockedWords.join(', ')}`);
                                socket.emit('message_sent', { 
                                    success: false, 
                                    error: `Message blocked due to inappropriate content: ${blockedWords.join(', ')}` 
                                });
                                return;
                            } else if (messageBlocked && socket.isAdmin) {
                                console.log(`✅ Admin ${socket.username} bypassed filter for words: ${blockedWords.join(', ')}`);
                            }
                        }

                        const messageData = {
                            senderId: socket.userId,
                            senderName: socket.username,
                            receiverId: data.receiverId || 'global',
                            message: filteredMessage,
                            timestamp: Date.now()
                        };

                        // Save to database with error handling (let SQLite auto-generate the id)
                        db.run(
                            'INSERT INTO chat_messages (sender_id, receiver_id, message) VALUES (?, ?, ?)',
                            [socket.userId, data.receiverId || 'global', filteredMessage],
                            function(err) {
                                if (err) {
                                    console.error('❌ Database error saving message:', err);
                                    socket.emit('message_sent', { 
                                        success: false, 
                                        error: 'Failed to save message' 
                                    });
                                    return;
                                }

                                // Add the auto-generated ID to the message data
                                const savedMessageData = {
                                    ...messageData,
                                    id: this.lastID
                                };

                                // Send to receiver if online (for private messages)
                                if (data.receiverId) {
                                    const receiverSocket = userSockets.get(data.receiverId);
                                    if (receiverSocket) {
                                        receiverSocket.emit('new_message', savedMessageData);
                                    }
                                } else {
                                    // Broadcast to all online users for global chat
                                    userSockets.forEach((userSocket) => {
                                        if (userSocket.id !== socket.id) {
                                            userSocket.emit('new_message', savedMessageData);
                                        }
                                    });
                                }

                                // Send confirmation to sender
                                socket.emit('message_sent', { 
                                    success: true, 
                                    message: savedMessageData 
                                });
                            }
                        );
                    });
                });
            } catch (error) {
                console.error('Error handling chat message:', error);
                socket.emit('message_sent', { 
                    success: false, 
                    error: 'Server error processing message' 
                });
            }
        });

        // Handle friend requests
        socket.on('send_friend_request', (targetUsername) => {
            // Use case-insensitive search for username
            db.get('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)', [targetUsername], (err, targetUser) => {
                if (err || !targetUser) {
                    socket.emit('friend_request_result', { success: false, message: 'User not found' });
                    return;
                }

                if (targetUser.id === socket.userId) {
                    socket.emit('friend_request_result', { success: false, message: 'Cannot add yourself as friend' });
                    return;
                }

                // Check if already friends or request pending (only check for active relationships)
                db.get('SELECT * FROM friends WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)) AND status IN ("pending", "accepted")', 
                    [socket.userId, targetUser.id, targetUser.id, socket.userId], (err, existing) => {
                    if (err) {
                        console.error('❌ Database error checking friendship:', err);
                        socket.emit('friend_request_result', { success: false, message: 'Database error' });
                        return;
                    }

                    if (existing) {
                        const status = existing.status === 'accepted' ? 'already friends' : 'request pending';
                        socket.emit('friend_request_result', { success: false, message: `Already ${status}` });
                        return;
                    }

                    // Send friend request
                    db.run('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, "pending")', 
                        [socket.userId, targetUser.id], function(err) {
                        if (err) {
                            socket.emit('friend_request_result', { success: false, message: 'Failed to send request' });
                            return;
                        }

                        console.log(`👥 FRIEND REQUEST: ${socket.username} → ${targetUser.username}`);
                        socket.emit('friend_request_result', { success: true, message: 'Friend request sent!' });

                        // Notify target user if online
                        const targetSocket = userSockets.get(targetUser.id);
                        if (targetSocket) {
                            targetSocket.emit('friend_request_received', {
                                fromId: socket.userId,
                                fromName: socket.username
                            });
                        }
                    });
                });
            });
        });

        // Handle friend request responses
        socket.on('respond_friend_request', (data) => {
            if (data.accepted) {
                // Accept the friend request - use INSERT OR REPLACE to avoid duplicates
                // First, update the existing request to accepted
                db.run('UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ?', 
                    ['accepted', data.fromId, socket.userId], function(err) {
                    if (err) {
                        console.error('❌ Error updating friend request:', err);
                        socket.emit('friend_response_result', { success: false, message: 'Database error' });
                        return;
                    }

                    // Add reverse friendship using INSERT OR REPLACE to avoid constraint violations
                    db.run('INSERT OR REPLACE INTO friends (user_id, friend_id, status) VALUES (?, ?, "accepted")', 
                        [socket.userId, data.fromId], function(err) {
                        if (err) {
                            console.error('❌ Error creating reverse friendship:', err);
                            socket.emit('friend_response_result', { success: false, message: 'Database error' });
                            return;
                        }

                        console.log(`✅ FRIENDSHIP ACCEPTED: ${socket.username} ↔ ${data.fromName || 'Unknown'}`);
                        socket.emit('friend_response_result', { 
                            success: true, 
                            message: 'Friend request accepted!' 
                        });

                        // Notify requester if online
                        const requesterSocket = userSockets.get(data.fromId);
                        if (requesterSocket) {
                            requesterSocket.emit('friend_request_responded', {
                                byId: socket.userId,
                                byName: socket.username,
                                accepted: true
                            });
                        }
                    });
                });
            } else {
                // Reject the friend request - DELETE it completely
                db.run('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', 
                    [data.fromId, socket.userId, socket.userId, data.fromId], function(err) {
                    if (err) {
                        console.error('❌ Error deleting friend request:', err);
                        socket.emit('friend_response_result', { success: false, message: 'Database error' });
                        return;
                    }

                    console.log(`❌ FRIEND REQUEST REJECTED: ${socket.username} → ${data.fromName || 'Unknown'}`);
                    socket.emit('friend_response_result', { 
                        success: true, 
                        message: 'Friend request rejected' 
                    });

                    // Notify requester if online
                    const requesterSocket = userSockets.get(data.fromId);
                    if (requesterSocket) {
                        requesterSocket.emit('friend_request_responded', {
                            byId: socket.userId,
                            byName: socket.username,
                            accepted: false
                        });
                    }
                });
            }
        });

        // Handle unfriend requests
        socket.on('unfriend_user', (data) => {
            try {
                const { friendId } = data;
                
                // Remove friendship from both sides
                db.run(
                    'DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
                    [socket.userId, friendId, friendId, socket.userId],
                    function(err) {
                        if (err) {
                            console.error('Database error unfriending user:', err);
                            socket.emit('unfriend_result', { success: false, message: 'Failed to unfriend user' });
                            return;
                        }
                        
                        if (this.changes > 0) {
                            console.log(`👥 UNFRIENDED: ${socket.username} removed friendship`);
                            
                            // Notify the other user
                            const targetSocket = userSockets.get(friendId);
                            if (targetSocket) {
                                targetSocket.emit('user_unfriended', {
                                    byId: socket.userId,
                                    byName: socket.username
                                });
                            }
                            
                            socket.emit('unfriend_result', { 
                                success: true, 
                                message: 'User unfriended successfully' 
                            });
                        } else {
                            socket.emit('unfriend_result', { success: false, message: 'Friendship not found' });
                        }
                    }
                );
            } catch (error) {
                console.error('Error handling unfriend request:', error);
                socket.emit('unfriend_result', { success: false, message: 'Server error' });
            }
        });

        // Handle disconnection
        socket.on('disconnect', () => {
            console.log(`🔴 User OFFLINE: ${socket.username} (ID: ${socket.userId})`);
            
            // Remove from online users
            onlineUsers.delete(socket.userId);
            userSockets.delete(socket.userId);

            // Update database
            db.run('UPDATE users SET is_online = 0 WHERE id = ?', [socket.userId]);

            // Notify friends
            db.all('SELECT friend_id FROM friends WHERE user_id = ? AND status = "accepted"', [socket.userId], (err, friends) => {
                if (!err && friends) {
                    friends.forEach(friend => {
                        const friendSocket = userSockets.get(friend.friend_id);
                        if (friendSocket) {
                            friendSocket.emit('friend_offline', {
                                userId: socket.userId,
                                username: socket.username
                            });
                        }
                    });
                }
            });
        });
    } catch (error) {
        console.error('Socket connection error:', error);
        socket.disconnect();
    }
});

// REST API endpoints
app.get('/api/users/online', (req, res) => {
    const onlineList = Array.from(onlineUsers.values()).map(user => ({
        id: user.id,
        username: user.username,
        lastSeen: user.lastSeen
    }));
    res.json(onlineList);
});

app.get('/api/users/:userId/garden', (req, res) => {
    const userId = req.params.userId;
    db.get('SELECT garden_data FROM gardens WHERE user_id = ?', [userId], (err, row) => {
        if (err) {
            res.status(500).json({ error: 'Database error' });
            return;
        }
        if (!row) {
            res.status(404).json({ error: 'Garden not found' });
            return;
        }
        res.json(JSON.parse(row.garden_data));
    });
});

app.get('/api/users/:userId/friends', (req, res) => {
    const userId = req.params.userId;
    db.all(`
        SELECT u.id, u.username, u.is_online, f.status, f.created_at, 'sent' as request_type
        FROM friends f
        JOIN users u ON (f.friend_id = u.id)
        WHERE f.user_id = ? AND f.status = 'pending'
        UNION
        SELECT u.id, u.username, u.is_online, f.status, f.created_at, 'received' as request_type
        FROM friends f
        JOIN users u ON (f.user_id = u.id)
        WHERE f.friend_id = ? AND f.status = 'pending'
        UNION
        SELECT u.id, u.username, u.is_online, f.status, f.created_at, 'accepted' as request_type
        FROM friends f
        JOIN users u ON (f.friend_id = u.id)
        WHERE f.user_id = ? AND f.status = 'accepted'
        UNION
        SELECT u.id, u.username, u.is_online, f.status, f.created_at, 'accepted' as request_type
        FROM friends f
        JOIN users u ON (f.user_id = u.id)
        WHERE f.friend_id = ? AND f.status = 'accepted'
    `, [userId, userId, userId, userId], (err, friends) => {
        if (err) {
            res.status(500).json({ error: 'Database error' });
            return;
        }
        
        // Add real-time online status from onlineUsers Map
        const friendsWithRealTimeStatus = friends.map(friend => {
            const isOnlineRealTime = onlineUsers.has(friend.id);
            return {
                ...friend,
                online: isOnlineRealTime,
                isOnline: isOnlineRealTime
            };
        });
        
        res.json(friendsWithRealTimeStatus);
    });
});

// Authentication middleware for protected routes
const authenticateToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(401).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
};

// Token verification endpoint
app.get('/api/auth/verify', authenticateToken, (req, res) => {
    res.json({ valid: true, user: req.user });
});

// Serve login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// Serve admin panel page
app.get('/admin-panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-panel.html'));
});

// Serve admin setup page
app.get('/setup-admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'setup-admin.html'));
});

// Serve connection test page
app.get('/test-connection', (req, res) => {
    res.sendFile(path.join(__dirname, 'test-connection.html'));
});

// Serve database fix page
app.get('/fix-database', (req, res) => {
    res.sendFile(path.join(__dirname, 'fix-database.html'));
});

// Health check endpoint for keep-alive
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        onlineUsers: onlineUsers.size
    });
});

// Get current IP address (for testing ban system safely)
app.get('/api/my-ip', (req, res) => {
    const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket?.remoteAddress;
    res.json({ 
        ip: clientIP,
        forwardedFor: req.headers['x-forwarded-for'],
        realIP: req.headers['x-real-ip'],
        userAgent: req.headers['user-agent']
    });
});

// Fix database endpoint
app.get('/api/fix-database', (req, res) => {
    console.log('🔧 Fixing database...');
    
    db.serialize(() => {
        // Add test data to admin_logs for security tab
        db.run(`INSERT OR IGNORE INTO admin_logs (admin_id, admin_username, action, target_user_id, target_username, details, ip_address)
                VALUES ('test-admin', 'admin', 'TEST_LOGIN', 'test-user', 'testuser', 'Test security log entry', '192.168.1.100')`, (err) => {
            if (err) console.error('Error adding test log:', err);
            else console.log('✅ Test security log added');
        });

        setTimeout(() => {
            res.json({ 
                message: 'Database fixed successfully!',
                status: 'success'
            });
        }, 1000);
    });
});

// Test database status endpoint
app.get('/api/test-db', (req, res) => {
    console.log('🔍 Testing database status...');
    
    db.all('SELECT name FROM sqlite_master WHERE type="table"', (err, tables) => {
        if (err) {
            console.error('❌ Database error:', err.message);
            return res.json({ 
                error: 'Database error', 
                message: err.message,
                tables: []
            });
        }
        
        const tableNames = tables.map(t => t.name);
        console.log('📋 Tables found:', tableNames);
        
        // Check specific tables
        const requiredTables = ['banned_ips', 'banned_devices', 'admin_logs', 'user_mutes'];
        const missingTables = requiredTables.filter(table => !tableNames.includes(table));
        
        res.json({
            success: true,
            totalTables: tableNames.length,
            allTables: tableNames,
            requiredTables: requiredTables,
            missingTables: missingTables,
            hasAllRequired: missingTables.length === 0
        });
    });
});

// Test admin users endpoint
app.get('/api/test-admin', (req, res) => {
    db.get('SELECT COUNT(*) as count FROM users WHERE is_admin = 1', (err, result) => {
        if (err) {
            return res.json({ error: 'Database error', message: err.message });
        }
        
        res.json({
            success: true,
            adminCount: result.count,
            hasAdmins: result.count > 0
        });
    });
});

// Create admin user endpoint (for first-time setup)
app.post('/api/create-admin', async (req, res) => {
    const { username, password, email } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    
    try {
        const bcrypt = require('bcryptjs');
        const { v4: uuidv4 } = require('uuid');
        const jwt = require('jsonwebtoken');
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const userId = uuidv4();
        const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
        
        db.run(
            'INSERT INTO users (id, username, email, password_hash, is_admin) VALUES (?, ?, ?, ?, 1)',
            [userId, username, email || null, hashedPassword],
            function(err) {
                if (err) {
                    console.error('Error creating admin:', err);
                    return res.status(500).json({ error: 'Database error', message: err.message });
                }
                
                const token = jwt.sign(
                    { id: userId, username, isAdmin: true },
                    JWT_SECRET,
                    { expiresIn: '24h' }
                );
                
                res.json({
                    message: 'Admin account created successfully',
                    token,
                    user: {
                        id: userId,
                        username,
                        isAdmin: true
                    }
                });
            }
        );
    } catch (error) {
        console.error('Error creating admin:', error);
        res.status(500).json({ error: 'Server error', message: error.message });
    }
});

// Serve the main game page (client-side handles authentication)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌱 Garden Game Server running on port ${PORT}`);
    console.log(`📡 WebSocket server ready for multiplayer connections`);
    console.log(`🌐 Game available at: http://localhost:${PORT}`);
    
    // Test database connection
    db.get('SELECT COUNT(*) as count FROM chat_messages', (err, row) => {
        if (err) {
            console.error('❌ Database test failed:', err);
        } else {
            console.log(`✅ Database test passed - ${row.count} chat messages in database`);
        }
    });
    
    // Basic keep-alive for Replit
    if (process.env.REPL_ID) {
        console.log('🔄 Basic keep-alive enabled for Replit');
        // Simple ping every 10 minutes
        setInterval(() => {
            console.log('🔄 Server alive - uptime:', Math.round(process.uptime()), 'seconds');
        }, 10 * 60 * 1000);
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    db.close();
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});
