const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ============================================
// ПЕРЕМЕННЫЕ БАЗЫ ДАННЫХ
// ============================================

let dbHost = process.env.MYSQLHOST || 'mysql.railway.internal';
let dbPort = parseInt(process.env.MYSQLPORT) || 3306;
let dbUser = process.env.MYSQLUSER || 'root';
let dbPassword = process.env.MYSQLPASSWORD || 'EfZwXgXXTMgSYxACiVlZtSenliMOymaC';
let dbDatabase = process.env.MYSQLDATABASE || 'railway';

console.log('========== ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ==========');
console.log('Используем хост:', dbHost);
console.log('Используем порт:', dbPort);
console.log('Используем пользователя:', dbUser);
console.log('==========================================');

const dbConfig = {
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: dbDatabase,
    waitForConnections: true,
    connectionLimit: 10
};

const db = mysql.createPool(dbConfig);
const userSessions = new Map();
const clients = new Map();

// Функция для отправки HTML файлов
function sendHtml(res, filename) {
    const filePath = path.join(__dirname, filename);
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            res.status(500).send('Error loading page');
            return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', 'inline');
        res.send(data);
    });
}

// ============================================
// ИНИЦИАЛИЗАЦИЯ БД
// ============================================

async function initDatabase() {
    try {
        const conn = await db.promise().getConnection();
        
        await conn.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                static_id VARCHAR(10) UNIQUE NOT NULL,
                age INT,
                password_hash VARCHAR(255) NOT NULL,
                is_admin BOOLEAN DEFAULT FALSE,
                is_banned BOOLEAN DEFAULT FALSE,
                ban_reason TEXT,
                unban_date DATETIME,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await conn.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(50) NOT NULL,
                type VARCHAR(10) DEFAULT 'voice',
                max_people INT DEFAULT 10,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await conn.query(`
            CREATE TABLE IF NOT EXISTS room_members (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                user_static_id VARCHAR(10),
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
            )
        `);
        
        await conn.query(`
            CREATE TABLE IF NOT EXISTS logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                action VARCHAR(255),
                user_static_id VARCHAR(10),
                target_static_id VARCHAR(10),
                details TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        console.log('✅ База данных инициализирована');
        conn.release();
    } catch (error) {
        console.error('❌ Ошибка инициализации БД:', error.message);
    }
}

db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Ошибка MySQL:', err.message);
    } else {
        console.log('✅ MySQL подключен!');
        connection.release();
        initDatabase();
    }
});

// ============================================
// ФУНКЦИИ WEBSOCKET
// ============================================

function broadcastToRoom(roomId, message) {
    for (let [id, client] of clients.entries()) {
        if (client.roomId === roomId && client.ws?.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    }
}

async function broadcastOnlineCount() {
    try {
        const [rows] = await db.promise().query(
            "SELECT COUNT(DISTINCT user_static_id) as count FROM room_members"
        );
        const totalOnline = rows[0].count;
        
        for (let [id, client] of clients.entries()) {
            if (client.ws?.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify({ type: 'online_count', count: totalOnline }));
            }
        }
    } catch(e) {}
}

// ============================================
// API МАРШРУТЫ
// ============================================

// Регистрация
app.post('/api/register', async (req, res) => {
    console.log('📝 Регистрация:', req.body);
    
    try {
        const { age, password } = req.body;
        
        if (!age || !password || age < 11 || age > 18) {
            return res.json({ success: false, error: 'Некорректный возраст (11-18 лет)' });
        }
        
        let static_id;
        let isUnique = false;
        
        while (!isUnique) {
            static_id = '#' + Math.floor(Math.random() * 900000 + 100000).toString();
            try {
                const [existing] = await db.promise().query("SELECT id FROM users WHERE static_id = ?", [static_id]);
                if (existing.length === 0) isUnique = true;
            } catch (err) {
                isUnique = true;
            }
        }
        
        const password_hash = crypto.createHash('sha256').update(password).digest('hex');
        
        await db.promise().query(
            "INSERT INTO users (static_id, age, password_hash) VALUES (?, ?, ?)",
            [static_id, age, password_hash]
        );
        
        console.log(`✅ Зарегистрирован: ${static_id}`);
        res.json({ success: true, static_id: static_id });
        
    } catch (error) {
        console.error('Register error:', error);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

// Авторизация
app.post('/api/login', async (req, res) => {
    console.log('📝 Авторизация:', req.body);
    
    try {
        const { static_id, password } = req.body;
        
        if (!static_id || !password) {
            return res.json({ success: false, error: 'Введите Static ID и пароль' });
        }
        
        const [rows] = await db.promise().query(
            "SELECT * FROM users WHERE static_id = ?",
            [static_id]
        );
        
        if (rows.length === 0) {
            return res.json({ success: false, error: 'Пользователь не найден' });
        }
        
        const user = rows[0];
        const password_hash = crypto.createHash('sha256').update(password).digest('hex');
        
        if (user.password_hash !== password_hash) {
            return res.json({ success: false, error: 'Неверный пароль' });
        }
        
        userSessions.set(static_id, {
            id: user.id,
            static_id: user.static_id,
            is_admin: user.is_admin === 1
        });
        
        console.log(`✅ Авторизован: ${static_id}`);
        res.json({ success: true });
        
    } catch (error) {
        console.error('Login error:', error);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

// Получить список комнат
app.get('/api/rooms', async (req, res) => {
    try {
        const [rows] = await db.promise().query(`
            SELECT r.*, 
            (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) as current_members 
            FROM rooms r 
            WHERE r.is_active = 1 
            ORDER BY r.created_at DESC
        `);
        res.json(rows);
    } catch (error) {
        console.error('Get rooms error:', error);
        res.json([]);
    }
});

// Получить онлайн счетчик
app.get('/api/online', async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            "SELECT COUNT(DISTINCT user_static_id) as count FROM room_members"
        );
        res.json({ count: rows[0].count });
    } catch (error) {
        res.json({ count: 0 });
    }
});

// Создать комнату (БЕЗ created_by)
app.post('/api/rooms', async (req, res) => {
    console.log('📝 Создание комнаты:', req.body);
    
    try {
        const { name, max_people, type } = req.body;
        
        if (!name) {
            return res.json({ success: false, error: 'Название комнаты обязательно' });
        }
        
        const [result] = await db.promise().query(
            "INSERT INTO rooms (name, max_people, type) VALUES (?, ?, ?)",
            [name, max_people || 10, type || 'voice']
        );
        
        res.json({ success: true, room_id: result.insertId, room_name: name });
    } catch (error) {
        console.error('Create room error:', error);
        res.json({ success: false, error: error.message });
    }
});

// Войти в комнату
app.post('/api/rooms/:id/join', async (req, res) => {
    console.log('📝 Вход в комнату:', req.params.id);
    
    try {
        const roomId = req.params.id;
        const { user_static_id } = req.body;
        
        const [room] = await db.promise().query(
            "SELECT * FROM rooms WHERE id = ? AND is_active = 1",
            [roomId]
        );
        
        if (room.length === 0) {
            return res.json({ success: false, error: 'Комната не найдена' });
        }
        
        const [count] = await db.promise().query(
            "SELECT COUNT(*) as cnt FROM room_members WHERE room_id = ?",
            [roomId]
        );
        
        if (count[0].cnt >= room[0].max_people) {
            return res.json({ success: false, error: 'Комната заполнена' });
        }
        
        await db.promise().query(
            "INSERT IGNORE INTO room_members (room_id, user_static_id) VALUES (?, ?)",
            [roomId, user_static_id]
        );
        
        broadcastToRoom(parseInt(roomId), {
            type: 'user_joined',
            userId: user_static_id
        });
        
        res.json({ success: true, room_name: room[0].name });
    } catch (error) {
        console.error('Join room error:', error);
        res.json({ success: false, error: error.message });
    }
});

// Выйти из комнаты
app.post('/api/rooms/:id/leave', async (req, res) => {
    console.log('📝 Выход из комнаты:', req.params.id);
    
    try {
        const roomId = req.params.id;
        const { user_static_id } = req.body;
        
        await db.promise().query(
            "DELETE FROM room_members WHERE room_id = ? AND user_static_id = ?",
            [roomId, user_static_id]
        );
        
        broadcastToRoom(parseInt(roomId), {
            type: 'user_left',
            userId: user_static_id
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Leave room error:', error);
        res.json({ success: false, error: error.message });
    }
});

// Удалить комнату
app.delete('/api/rooms/:id', async (req, res) => {
    console.log('📝 Удаление комнаты:', req.params.id);
    
    try {
        const roomId = req.params.id;
        
        await db.promise().query("DELETE FROM room_members WHERE room_id = ?", [roomId]);
        await db.promise().query("DELETE FROM rooms WHERE id = ?", [roomId]);
        
        broadcastToRoom(parseInt(roomId), {
            type: 'room_deleted',
            roomId: roomId
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Delete room error:', error);
        res.json({ success: false, error: error.message });
    }
});

// Проверка админа
app.get('/api/checkAdmin', async (req, res) => {
    const { static_id } = req.query;
    
    try {
        const [rows] = await db.promise().query(
            "SELECT is_admin FROM users WHERE static_id = ?",
            [static_id]
        );
        res.json({ is_admin: rows.length > 0 ? rows[0].is_admin === 1 : false });
    } catch (error) {
        res.json({ is_admin: false });
    }
});

// Получить участников комнаты
app.get('/api/rooms/:id/members', async (req, res) => {
    try {
        const roomId = req.params.id;
        const [rows] = await db.promise().query(
            "SELECT user_static_id FROM room_members WHERE room_id = ?",
            [roomId]
        );
        res.json({ members: rows.map(r => r.user_static_id) });
    } catch (error) {
        res.json({ members: [] });
    }
});

// ============================================
// СТАТИЧЕСКИЕ ФАЙЛЫ
// ============================================
app.get('/', (req, res) => { sendHtml(res, 'index.html'); });
app.get('/dashboard.html', (req, res) => { sendHtml(res, 'dashboard.html'); });
app.get('/admin.html', (req, res) => { sendHtml(res, 'admin.html'); });
app.get('/room.html', (req, res) => { sendHtml(res, 'room.html'); });
app.get('/logout.html', (req, res) => { sendHtml(res, 'logout.html'); });
app.get('/style.css', (req, res) => { res.sendFile(path.join(__dirname, 'style.css')); });
app.get('/script.js', (req, res) => { res.sendFile(path.join(__dirname, 'script.js')); });

// ============================================
// WEBSOCKET
// ============================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    let userStaticId = null;
    let currentRoom = null;
    
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            
            if (msg.type === 'auth') {
                userStaticId = msg.staticId;
                clients.set(userStaticId, { ws, roomId: null });
                ws.send(JSON.stringify({ type: 'auth_success' }));
                console.log(`✅ Auth: ${userStaticId}`);
                broadcastOnlineCount();
            }
            else if (msg.type === 'join_room') {
                currentRoom = msg.roomId;
                if (clients.has(userStaticId)) {
                    clients.get(userStaticId).roomId = currentRoom;
                }
                
                const [members] = await db.promise().query(
                    "SELECT user_static_id FROM room_members WHERE room_id = ?",
                    [currentRoom]
                );
                const memberList = members.map(m => m.user_static_id);
                
                ws.send(JSON.stringify({
                    type: 'members_list',
                    members: memberList
                }));
                
                broadcastToRoom(currentRoom, {
                    type: 'user_joined',
                    userId: userStaticId
                });
                
                console.log(`🎤 ${userStaticId} joined room ${currentRoom}`);
            }
            else if (msg.type === 'voice_data') {
                if (!currentRoom) return;
                
                for (let [id, client] of clients.entries()) {
                    if (client.roomId === currentRoom && id !== userStaticId) {
                        if (client.ws?.readyState === WebSocket.OPEN) {
                            client.ws.send(JSON.stringify({
                                type: 'voice_data',
                                from: userStaticId,
                                audio: msg.audio
                            }));
                        }
                    }
                }
            }
            else if (msg.type === 'text_message') {
                if (!currentRoom) return;
                
                broadcastToRoom(currentRoom, {
                    type: 'text_message',
                    from: userStaticId,
                    message: msg.message
                });
                
                console.log(`💬 ${userStaticId}: ${msg.message.substring(0, 50)}`);
            }
            else if (msg.type === 'leave_room') {
                if (currentRoom) {
                    broadcastToRoom(currentRoom, {
                        type: 'user_left',
                        userId: userStaticId
                    });
                    
                    if (clients.has(userStaticId)) {
                        clients.get(userStaticId).roomId = null;
                    }
                    currentRoom = null;
                }
            }
            else if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
        } catch (error) {
            console.error('WebSocket error:', error);
        }
    });
    
    ws.on('close', () => {
        if (userStaticId) {
            console.log(`❌ ${userStaticId} disconnected`);
            clients.delete(userStaticId);
            broadcastOnlineCount();
        }
    });
});

server.listen(port, '0.0.0.0', () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Harmony Chat сервер запущен!');
    console.log(`🌐 URL: https://harmonychat.up.railway.app`);
    console.log(`🔌 Порт: ${port}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
