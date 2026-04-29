const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mysql = require('mysql2');
const crypto = require('crypto');

// Создаем Express приложение
const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Логирование запросов
app.use((req, res, next) => {
    console.log(`📝 ${req.method} ${req.url}`);
    next();
});

// ============================================
// API МАРШРУТЫ (ПРЯМАЯ РАБОТА С БД)
// ============================================

// Регистрация
app.post('/register.php', async (req, res) => {
    console.log('📝 Регистрация:', req.body);
    
    try {
        const { age, password } = req.body;
        
        if (!age || !password || age < 11 || age > 18) {
            return res.json({ success: false, error: 'Некорректный возраст (11-18 лет)' });
        }
        
        // Генерируем числовой Static ID
        let static_id;
        let isUnique = false;
        
        while (!isUnique) {
            static_id = '#' + Math.floor(Math.random() * 900000 + 100000).toString();
            const [existing] = await db.promise().query("SELECT id FROM users WHERE static_id = ?", [static_id]);
            if (existing.length === 0) isUnique = true;
        }
        
        // Хешируем пароль
        const password_hash = crypto.createHash('sha256').update(password).digest('hex');
        
        // Сохраняем пользователя
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
app.post('/login.php', async (req, res) => {
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
        
        // Сохраняем в сессию (используем глобальный объект)
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

// API для комнат
app.post('/api.php', async (req, res) => {
    console.log('📝 API POST:', req.body);
    
    try {
        const { action, name, max, type, room_id } = req.body;
        
        if (action === 'createRoom') {
            const [result] = await db.promise().query(
                "INSERT INTO rooms (name, max_people, type, created_by) VALUES (?, ?, ?, ?)",
                [name, max || 10, type || 'voice', 'system']
            );
            res.json({ success: true, room_id: result.insertId, room_name: name });
            
        } else if (action === 'joinRoom') {
            const [room] = await db.promise().query(
                "SELECT * FROM rooms WHERE id = ?",
                [room_id]
            );
            if (room.length === 0) {
                res.json({ success: false, error: 'Комната не найдена' });
            } else {
                res.json({ success: true, room_name: room[0].name });
            }
            
        } else if (action === 'leaveRoom') {
            res.json({ success: true });
            
        } else {
            res.json({ success: false, error: 'Неизвестное действие' });
        }
        
    } catch (error) {
        console.error('API error:', error);
        res.json({ success: false, error: error.message });
    }
});

app.get('/api.php', async (req, res) => {
    const { action } = req.query;
    console.log('📝 API GET:', action);
    
    try {
        if (action === 'getRooms') {
            const [rows] = await db.promise().query(`
                SELECT r.*, 
                (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) as current_members 
                FROM rooms r 
                WHERE r.is_active = 1 
                ORDER BY r.created_at DESC
            `);
            res.json(rows);
            
        } else if (action === 'getRoomMembers') {
            const room_id = req.query.room_id;
            const [rows] = await db.promise().query(
                "SELECT user_static_id FROM room_members WHERE room_id = ?",
                [room_id]
            );
            res.json({ members: rows.map(r => r.user_static_id) });
            
        } else if (action === 'getOnlineCount') {
            const [rows] = await db.promise().query(
                "SELECT COUNT(DISTINCT user_static_id) as count FROM room_members"
            );
            res.json({ count: rows[0].count });
            
        } else {
            res.json([]);
        }
        
    } catch (error) {
        console.error('API GET error:', error);
        res.json([]);
    }
});

// ============================================
// СТАТИЧЕСКИЕ ФАЙЛЫ
// ============================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dashboard.php', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.php'));
});

app.get('/admin.php', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.php'));
});

app.get('/style.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'style.css'));
});

app.get('/script.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'script.js'));
});

app.get('/logout.php', (req, res) => {
    res.sendFile(path.join(__dirname, 'logout.php'));
});

// Все остальные GET запросы
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================
// БАЗА ДАННЫХ
// ============================================
const dbConfig = {
    host: process.env.MYSQLHOST || 'localhost',
    port: parseInt(process.env.MYSQLPORT) || 3306,
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || '',
    database: process.env.MYSQLDATABASE || 'harmony_chat',
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
};

const db = mysql.createPool(dbConfig);

// Глобальные хранилища
const userSessions = new Map();
const clients = new Map();

// Инициализация базы данных
async function initDatabase() {
    try {
        const conn = await db.promise().getConnection();
        
        // Создаем таблицу пользователей
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
        
        // Создаем таблицу комнат
        await conn.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(50) NOT NULL,
                type VARCHAR(10) DEFAULT 'voice',
                max_people INT DEFAULT 10,
                created_by VARCHAR(10),
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Создаем таблицу участников комнат
        await conn.query(`
            CREATE TABLE IF NOT EXISTS room_members (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                user_static_id VARCHAR(10),
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
            )
        `);
        
        // Создаем таблицу логов
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

// Проверка подключения
db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Ошибка подключения к MySQL:', err.message);
    } else {
        console.log('✅ Подключение к MySQL успешно!');
        connection.release();
        initDatabase();
    }
});

// ============================================
// WEBSOCKET СЕРВЕР
// ============================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Настройки голоса
const VOICE_CONFIG = {
    minVolume: 0.05,
    activityTimeout: 300000
};

// Функции WebSocket
function notifyRoomMembers(roomId, event, userId, extraData = null) {
    const message = { type: event, userId: userId };
    if (extraData) Object.assign(message, extraData);
    
    for (let [id, client] of clients.entries()) {
        if (client.roomId === roomId && client.ws?.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    }
}

function broadcastVoice(roomId, fromUserId, audioData, volume) {
    for (let [id, client] of clients.entries()) {
        if (id !== fromUserId && client.roomId === roomId && client.ws?.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({
                type: 'voice_data',
                from: fromUserId,
                audio: audioData,
                volume: volume
            }));
        }
    }
}

function broadcastOnlineCount() {
    const onlineCount = clients.size;
    for (let [id, client] of clients.entries()) {
        if (client.ws?.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: 'online_count', count: onlineCount }));
        }
    }
    console.log(`📊 Онлайн: ${onlineCount} пользователей`);
}

// WebSocket соединение
wss.on('connection', (ws, req) => {
    let userStaticId = null;
    let currentRoom = null;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`🔌 Новое соединение от ${clientIp}`);

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            
            if (msg.type === 'auth') {
                userStaticId = msg.staticId;
                
                if (!userStaticId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Не указан Static ID' }));
                    ws.close();
                    return;
                }
                
                // Проверяем пользователя
                const [rows] = await db.promise().query("SELECT * FROM users WHERE static_id = ?", [userStaticId]);
                if (rows.length === 0) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Пользователь не найден' }));
                    ws.close();
                    return;
                }
                
                clients.set(userStaticId, { ws, roomId: null, lastActivity: Date.now() });
                broadcastOnlineCount();
                console.log(`✅ Авторизован: ${userStaticId}`);
                ws.send(JSON.stringify({ type: 'auth_success', staticId: userStaticId }));
            }
            
            else if (msg.type === 'join_room') {
                if (!userStaticId) return;
                currentRoom = msg.roomId;
                const client = clients.get(userStaticId);
                if (client) {
                    client.roomId = currentRoom;
                    client.lastActivity = Date.now();
                }
                
                // Добавляем в БД
                await db.promise().query(
                    "INSERT IGNORE INTO room_members (room_id, user_static_id) VALUES (?, ?)",
                    [currentRoom, userStaticId]
                );
                
                ws.send(JSON.stringify({ type: 'joined', roomId: currentRoom }));
                notifyRoomMembers(currentRoom, 'user_joined', userStaticId);
                console.log(`🎤 ${userStaticId} присоединился к комнате ${currentRoom}`);
            }
            
            else if (msg.type === 'voice_data') {
                if (!userStaticId || !currentRoom) return;
                
                const client = clients.get(userStaticId);
                if (client) client.lastActivity = Date.now();
                
                let volume = 0;
                if (msg.audio) {
                    for (let i = 0; i < msg.audio.length; i++) volume += Math.abs(msg.audio[i]);
                    volume /= msg.audio.length;
                }
                
                if (volume > VOICE_CONFIG.minVolume) {
                    broadcastVoice(currentRoom, userStaticId, msg.audio, volume);
                }
            }
            
            else if (msg.type === 'text_message') {
                if (!userStaticId || !currentRoom) return;
                
                for (let [id, client] of clients.entries()) {
                    if (client.roomId === currentRoom && client.ws?.readyState === WebSocket.OPEN) {
                        client.ws.send(JSON.stringify({
                            type: 'text_message',
                            from: userStaticId,
                            message: msg.message
                        }));
                    }
                }
                console.log(`💬 ${userStaticId}: ${msg.message.substring(0, 50)}`);
            }
            
            else if (msg.type === 'leave_room') {
                if (!userStaticId) return;
                
                if (currentRoom) {
                    await db.promise().query(
                        "DELETE FROM room_members WHERE room_id = ? AND user_static_id = ?",
                        [currentRoom, userStaticId]
                    );
                    notifyRoomMembers(currentRoom, 'user_left', userStaticId);
                    console.log(`🚪 ${userStaticId} покинул комнату ${currentRoom}`);
                    
                    const client = clients.get(userStaticId);
                    if (client) client.roomId = null;
                    currentRoom = null;
                }
            }
            
            else if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
            
        } catch (error) {
            console.error('Ошибка:', error.message);
        }
    });
    
    ws.on('close', () => {
        if (userStaticId) {
            console.log(`❌ Отключение ${userStaticId}`);
            clients.delete(userStaticId);
            broadcastOnlineCount();
        }
    });
});

// ============================================
// ЗАПУСК СЕРВЕРА
// ============================================
server.listen(port, '0.0.0.0', () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Harmony Chat сервер запущен!');
    console.log(`🌐 URL: https://harmonychat.up.railway.app`);
    console.log(`🔌 Порт: ${port}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

process.on('SIGTERM', () => {
    console.log('🛑 Завершение работы...');
    for (let [id, client] of clients.entries()) {
        if (client.ws?.readyState === WebSocket.OPEN) client.ws.close();
    }
    clients.clear();
    process.exit(0);
});
