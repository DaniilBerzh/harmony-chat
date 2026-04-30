const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mysql = require('mysql2');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ============================================
// КРИТИЧНО: ПРЯМОЕ ЧТЕНИЕ ПЕРЕМЕННЫХ
// ============================================

// Пробуем разные варианты получения хоста
let dbHost = process.env.MYSQLHOST;
let dbPort = parseInt(process.env.MYSQLPORT) || 3306;
let dbUser = process.env.MYSQLUSER || 'root';
let dbPassword = process.env.MYSQLPASSWORD || '';
let dbDatabase = process.env.MYSQLDATABASE || 'railway';

// Если MYSQLHOST не задан, пробуем альтернативы
if (!dbHost || dbHost === 'localhost') {
    // Используем прямой адрес из Railway
    dbHost = 'mysql.railway.internal';
}

console.log('========== ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ==========');
console.log('MYSQLHOST из env:', process.env.MYSQLHOST);
console.log('MYSQLPORT из env:', process.env.MYSQLPORT);
console.log('MYSQLUSER из env:', process.env.MYSQLUSER);
console.log('MYSQLDATABASE из env:', process.env.MYSQLDATABASE);
console.log('==========================================');
console.log('Используем хост:', dbHost);
console.log('Используем порт:', dbPort);
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

// ============================================
// API МАРШРУТЫ
// ============================================

// Регистрация
app.post('/register.php', async (req, res) => {
    console.log('📝 Регистрация:', req.body);
    
    try {
        const { age, password } = req.body;
        
        if (!age || !password || age < 11 || age > 18) {
            return res.json({ success: false, error: 'Некорректный возраст (11-18 лет)' });
        }
        
        // Генерируем Static ID
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
        res.json({ success: false, error: 'Ошибка сервера: ' + error.message });
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
        
        userSessions.set(static_id, { id: user.id, static_id: user.static_id });
        console.log(`✅ Авторизован: ${static_id}`);
        res.json({ success: true });
        
    } catch (error) {
        console.error('Login error:', error);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

// API для комнат
app.post('/api.php', async (req, res) => {
    try {
        const { action, name, max, type } = req.body;
        
        if (action === 'createRoom') {
            const [result] = await db.promise().query(
                "INSERT INTO rooms (name, max_people, type) VALUES (?, ?, ?)",
                [name, max || 10, type || 'voice']
            );
            res.json({ success: true, room_id: result.insertId });
        } else {
            res.json({ success: false });
        }
    } catch (error) {
        res.json({ success: false });
    }
});

app.get('/api.php', async (req, res) => {
    try {
        const [rows] = await db.promise().query(`
            SELECT r.*, 
            (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) as current_members 
            FROM rooms r WHERE r.is_active = 1
        `);
        res.json(rows);
    } catch (error) {
        res.json([]);
    }
});

// Статические файлы
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard.php', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.php')));
app.get('/admin.php', (req, res) => res.sendFile(path.join(__dirname, 'admin.php')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));

// Инициализация БД
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
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        console.log('✅ База данных готова');
        conn.release();
    } catch (error) {
        console.error('DB init error:', error.message);
    }
}

// Проверка подключения
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
            }
            else if (msg.type === 'join_room') {
                currentRoom = msg.roomId;
                if (clients.has(userStaticId)) clients.get(userStaticId).roomId = currentRoom;
                ws.send(JSON.stringify({ type: 'joined' }));
            }
            else if (msg.type === 'voice_data') {
                for (let [id, client] of clients) {
                    if (client.roomId === currentRoom && id !== userStaticId) {
                        client.ws.send(JSON.stringify({ type: 'voice_data', from: userStaticId, audio: msg.audio }));
                    }
                }
            }
            else if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
        } catch(e) {}
    });
    
    ws.on('close', () => clients.delete(userStaticId));
});

server.listen(port, '0.0.0.0', () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Harmony Chat сервер запущен!');
    console.log(`🌐 URL: https://harmonychat.up.railway.app`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
