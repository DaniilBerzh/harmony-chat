const WebSocket = require('ws');
const mysql = require('mysql2');

// Определяем порт (Railway дает PORT или используем 8080)
const port = process.env.PORT || 8080;

// Настройки базы данных из переменных окружения Railway
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

// Создаем пул соединений
const db = mysql.createPool(dbConfig);

// Проверка подключения к БД
db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Ошибка подключения к MySQL:', err.message);
        console.log('📝 Переменные окружения Railway должны автоматически подставить параметры MySQL');
    } else {
        console.log('✅ Подключение к MySQL успешно!');
        connection.release();
    }
});

let clients = new Map(); // static_id -> { ws, roomId, lastActivity }

// Настройки для голоса
const VOICE_CONFIG = {
    minVolume: 0.05,
    sampleRate: 44100,
    frameSize: 4096,
    activityTimeout: 300000
};

console.log('🎙️ Запуск WebSocket сервера Harmony Chat...');
console.log(`📡 Порт: ${port}`);
console.log(`🖥️ Режим: ${process.env.RAILWAY_ENVIRONMENT ? 'Railway Cloud' : 'Local Development'}`);

// Создаем WebSocket сервер на ВСЕХ интерфейсах (важно для Railway)
const wss = new WebSocket.Server({ 
    port: port,
    host: '0.0.0.0'  // Принимаем соединения со всех интерфейсов
});

// Функция отправки сообщения всем в комнате
function notifyRoomMembers(roomId, event, userId, extraData = null) {
    const message = { type: event, userId: userId };
    if (extraData) {
        Object.assign(message, extraData);
    }
    
    let sentCount = 0;
    for (let [id, client] of clients.entries()) {
        if (client.roomId === roomId) {
            try {
                if (client.ws && client.ws.readyState === WebSocket.OPEN) {
                    client.ws.send(JSON.stringify(message));
                    sentCount++;
                }
            } catch (error) {
                console.error(`Ошибка отправки ${id}:`, error.message);
            }
        }
    }
    return sentCount;
}

// Функция трансляции голоса
function broadcastVoice(roomId, fromUserId, audioData, volume) {
    let sentCount = 0;
    for (let [id, client] of clients.entries()) {
        if (id !== fromUserId && client.roomId === roomId) {
            try {
                if (client.ws && client.ws.readyState === WebSocket.OPEN) {
                    client.ws.send(JSON.stringify({
                        type: 'voice_data',
                        from: fromUserId,
                        audio: audioData,
                        volume: volume,
                        timestamp: Date.now()
                    }));
                    sentCount++;
                }
            } catch (error) {
                console.error(`Ошибка отправки голоса:`, error.message);
            }
        }
    }
    return sentCount;
}

// Функция обновления онлайн-счетчика
function broadcastOnlineCount() {
    const onlineCount = clients.size;
    for (let [id, client] of clients.entries()) {
        try {
            if (client.ws && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify({ type: 'online_count', count: onlineCount }));
            }
        } catch (error) {
            console.error(`Ошибка отправки счетчика:`, error.message);
        }
    }
    console.log(`📊 Онлайн: ${onlineCount} пользователей`);
}

// Очистка неактивных соединений
setInterval(() => {
    const now = Date.now();
    let inactiveCount = 0;
    
    for (let [id, client] of clients.entries()) {
        if (now - client.lastActivity > VOICE_CONFIG.activityTimeout) {
            console.log(`⏰ Отключение неактивного: ${id}`);
            if (client.ws && client.ws.readyState === WebSocket.OPEN) {
                client.ws.close();
            }
            clients.delete(id);
            inactiveCount++;
        }
    }
    
    if (inactiveCount > 0) {
        broadcastOnlineCount();
    }
}, 60000);

// WebSocket соединение
wss.on('connection', (ws, req) => {
    let userStaticId = null;
    let currentRoom = null;
    let lastVoiceActivity = Date.now();
    let voiceFrames = 0;
    
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`🔌 Новое соединение от ${clientIp}`);

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            
            // Аутентификация
            if (msg.type === 'auth') {
                userStaticId = msg.staticId;
                
                if (!userStaticId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Не указан Static ID' }));
                    ws.close();
                    return;
                }
                
                // Проверяем пользователя в БД
                const conn = await db.promise().getConnection();
                try {
                    const [rows] = await conn.query("SELECT * FROM users WHERE static_id = ?", [userStaticId]);
                    if (rows.length === 0) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Пользователь не найден' }));
                        ws.close();
                        return;
                    }
                    
                    // Проверяем бан
                    if (rows[0].is_banned && rows[0].unban_date && new Date(rows[0].unban_date) > new Date()) {
                        ws.send(JSON.stringify({ 
                            type: 'error', 
                            message: `Вы забанены до ${rows[0].unban_date}`
                        }));
                        ws.close();
                        return;
                    }
                    
                    // Обновляем last_seen
                    await conn.query("UPDATE users SET last_seen = NOW() WHERE static_id = ?", [userStaticId]);
                    
                } finally {
                    conn.release();
                }
                
                // Сохраняем клиента
                clients.set(userStaticId, { 
                    ws, 
                    roomId: null, 
                    lastActivity: Date.now(),
                    ip: clientIp
                });
                
                broadcastOnlineCount();
                console.log(`✅ Авторизован: ${userStaticId}`);
                ws.send(JSON.stringify({ type: 'auth_success', staticId: userStaticId }));
            }
            
            // Присоединение к комнате
            else if (msg.type === 'join_room') {
                if (!userStaticId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Не авторизован' }));
                    return;
                }
                
                currentRoom = msg.roomId;
                const client = clients.get(userStaticId);
                if (client) {
                    client.roomId = currentRoom;
                    client.lastActivity = Date.now();
                }
                
                // Отправляем список участников
                const members = [];
                for (let [id, clientInfo] of clients.entries()) {
                    if (clientInfo.roomId === currentRoom && id !== userStaticId) {
                        members.push(id);
                    }
                }
                
                ws.send(JSON.stringify({
                    type: 'members_list',
                    members: members
                }));
                
                // Уведомляем всех в комнате
                const sentCount = notifyRoomMembers(currentRoom, 'user_joined', userStaticId);
                console.log(`🎤 ${userStaticId} присоединился к комнате ${currentRoom}`);
            }
            
            // Голосовые данные
            else if (msg.type === 'voice_data') {
                if (!userStaticId || !currentRoom) return;
                
                const client = clients.get(userStaticId);
                if (client) {
                    client.lastActivity = Date.now();
                }
                
                const audioData = msg.audio;
                let volume = 0;
                if (audioData && audioData.length > 0) {
                    for (let i = 0; i < audioData.length; i++) {
                        volume += Math.abs(audioData[i]);
                    }
                    volume /= audioData.length;
                } else if (msg.volume) {
                    volume = msg.volume / 100;
                }
                
                if (volume > VOICE_CONFIG.minVolume) {
                    lastVoiceActivity = Date.now();
                    voiceFrames++;
                    
                    if (voiceFrames % 5 === 0) {
                        notifyRoomMembers(currentRoom, 'speaking', userStaticId, { volume: volume });
                    }
                    
                    const sentCount = broadcastVoice(currentRoom, userStaticId, audioData, volume);
                    
                    if (voiceFrames % 100 === 0) {
                        console.log(`🎙️ ${userStaticId}: отправлено ${voiceFrames} фреймов`);
                    }
                }
            }
            
            // Текстовые сообщения
            else if (msg.type === 'text_message') {
                if (!userStaticId || !currentRoom) return;
                
                const client = clients.get(userStaticId);
                if (client) {
                    client.lastActivity = Date.now();
                }
                
                const textMessage = {
                    type: 'text_message',
                    from: userStaticId,
                    message: msg.message.substring(0, 500),
                    timestamp: Date.now()
                };
                
                let sentCount = 0;
                for (let [id, clientInfo] of clients.entries()) {
                    if (clientInfo.roomId === currentRoom) {
                        try {
                            if (clientInfo.ws && clientInfo.ws.readyState === WebSocket.OPEN) {
                                clientInfo.ws.send(JSON.stringify(textMessage));
                                sentCount++;
                            }
                        } catch (error) {
                            console.error(`Ошибка отправки сообщения:`, error.message);
                        }
                    }
                }
                
                console.log(`💬 ${userStaticId}: "${msg.message.substring(0, 50)}"`);
            }
            
            // Выход из комнаты
            else if (msg.type === 'leave_room') {
                if (!userStaticId) return;
                
                if (currentRoom) {
                    const sentCount = notifyRoomMembers(currentRoom, 'user_left', userStaticId);
                    console.log(`🚪 ${userStaticId} покинул комнату ${currentRoom}`);
                    
                    const client = clients.get(userStaticId);
                    if (client) {
                        client.roomId = null;
                    }
                    currentRoom = null;
                }
            }
            
            // Ping/Pong
            else if (msg.type === 'ping') {
                if (userStaticId) {
                    const client = clients.get(userStaticId);
                    if (client) {
                        client.lastActivity = Date.now();
                    }
                }
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            }
            
            // Тест микрофона
            else if (msg.type === 'volume_test') {
                if (!userStaticId) return;
                
                const audioData = msg.audio;
                let volume = 0;
                if (audioData && audioData.length > 0) {
                    for (let i = 0; i < audioData.length; i++) {
                        volume += Math.abs(audioData[i]);
                    }
                    volume /= audioData.length;
                }
                
                ws.send(JSON.stringify({
                    type: 'volume_result',
                    volume: volume,
                    isWorking: volume > VOICE_CONFIG.minVolume,
                    message: volume > VOICE_CONFIG.minVolume ? 'Микрофон работает' : 'Громкость низкая'
                }));
            }
            
            // Получение списка участников
            else if (msg.type === 'get_members') {
                if (!userStaticId || !currentRoom) return;
                
                const members = [];
                for (let [id, clientInfo] of clients.entries()) {
                    if (clientInfo.roomId === currentRoom) {
                        members.push(id);
                    }
                }
                
                ws.send(JSON.stringify({
                    type: 'members_list',
                    members: members
                }));
            }
            
            // Удаление комнаты
            else if (msg.type === 'room_deleted') {
                // Оповещаем всех в комнате
                if (currentRoom === msg.roomId) {
                    ws.send(JSON.stringify({ type: 'room_closed', message: 'Комната удалена' }));
                    currentRoom = null;
                    if (clients.has(userStaticId)) {
                        clients.get(userStaticId).roomId = null;
                    }
                }
            }
            
        } catch (error) {
            console.error('Ошибка обработки:', error.message);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error', message: 'Ошибка сервера' }));
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error(`WebSocket ошибка для ${userStaticId || 'unknown'}:`, error.message);
    });
    
    ws.on('close', (code, reason) => {
        if (userStaticId) {
            console.log(`❌ Отключение ${userStaticId}, код: ${code}`);
            
            if (clients.has(userStaticId)) {
                const roomId = clients.get(userStaticId).roomId;
                if (roomId) {
                    notifyRoomMembers(roomId, 'user_left', userStaticId);
                }
                clients.delete(userStaticId);
            }
            
            broadcastOnlineCount();
        }
    });
});

// Запуск сервера
wss.on('listening', () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ WebSocket сервер Harmony Chat запущен!');
    console.log(`📡 Адрес: ws://0.0.0.0:${port}`);
    console.log(`🔄 WebSocket готов к подключениям`);
    if (process.env.RAILWAY_ENVIRONMENT) {
        console.log(`☁️ Режим: Railway Cloud`);
        console.log(`🔗 URL будет доступен по домену Railway`);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

wss.on('error', (error) => {
    console.error('❌ Серверная ошибка:', error.message);
});

console.log('🚀 Запуск WebSocket сервера...');

// Обработка завершения процесса (для Railway)
process.on('SIGTERM', () => {
    console.log('🛑 Получен SIGTERM, закрываем соединения...');
    for (let [id, client] of clients.entries()) {
        if (client.ws && client.ws.readyState === WebSocket.OPEN) {
            client.ws.close();
        }
    }
    clients.clear();
    process.exit(0);
});
