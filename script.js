// script.js - Полностью исправленная версия Harmony Chat для Railway

// Глобальные переменные
let ws = null;
let currentRoom = null;
let currentRoomType = null;
let mediaStream = null;
let audioContext = null;
let audioProcessor = null;
let isMuted = false;
let reconnectAttempts = 0;
let heartbeatInterval = null;
let userStaticId = null;
let roomMembers = new Map();
let isAdmin = false;

// Переменные для проверки микрофона
let isTestingMic = false;
let testStream = null;
let testContext = null;
let testProcessor = null;
let testAnimationId = null;

// DOM элементы
const globalOnlineSpan = document.getElementById('global-online');
const roomsListDiv = document.getElementById('rooms-list');
const messagesDiv = document.getElementById('messages');
const currentRoomInfo = document.getElementById('current-room-info');
const voiceControls = document.getElementById('voice-controls');
const textInputDiv = document.getElementById('text-input');
const muteBtn = document.getElementById('mute-btn');
const leaveRoomBtn = document.getElementById('leave-room');
const textMsgInput = document.getElementById('text-msg');

// ============================================
// УВЕДОМЛЕНИЯ (вместо alert)
// ============================================
function showNotification(message, type = 'error') {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'error' ? '#f44336' : type === 'success' ? '#4CAF50' : '#FF9800'};
        color: white;
        padding: 15px 20px;
        border-radius: 12px;
        z-index: 10001;
        animation: slideIn 0.3s ease;
        box-shadow: 0 4px 15px rgba(0,0,0,0.2);
        max-width: 350px;
        font-family: 'Segoe UI', sans-serif;
        font-size: 14px;
    `;
    notification.innerHTML = `
        <strong>🎙️ Harmony Chat</strong><br>
        ${message}
    `;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'fadeOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Добавляем стили для анимаций
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    @keyframes fadeOut {
        from {
            opacity: 1;
        }
        to {
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

// ============================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM загружен, инициализация...');
    
    // Получаем данные пользователя
    const userDataDiv = document.getElementById('user-data');
    if (userDataDiv && userDataDiv.dataset.staticId) {
        userStaticId = userDataDiv.dataset.staticId;
        console.log('User Static ID:', userStaticId);
    }
    
    // Проверяем, админ ли пользователь (есть ли кнопка админки)
    const adminCheck = document.querySelector('.admin-btn');
    if (adminCheck) {
        isAdmin = true;
        console.log('Режим: администратор');
    }
    
    // Загружаем тему
    loadTheme();
    addThemeButton();
    
    // Подключаем WebSocket
    connectWebSocket();
    
    // Загружаем комнаты каждые 5 секунд
    setInterval(() => {
        if (document.visibilityState === 'visible' && !currentRoom) {
            loadRooms();
        }
    }, 5000);
    
    // Обработчики кнопок
    if (muteBtn) muteBtn.addEventListener('click', toggleMute);
    if (leaveRoomBtn) leaveRoomBtn.addEventListener('click', leaveRoom);
    if (textMsgInput) {
        textMsgInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendTextMessage();
        });
    }
    
    // Обработка закрытия страницы
    window.addEventListener('beforeunload', () => {
        if (currentRoom) leaveRoomSync();
    });
});

// ============================================
// ТЕМНАЯ ТЕМА
// ============================================
function loadTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
}

function addThemeButton() {
    const themeBtn = document.createElement('button');
    themeBtn.id = 'theme-toggle';
    themeBtn.className = 'theme-toggle';
    themeBtn.onclick = toggleTheme;
    const currentTheme = document.documentElement.getAttribute('data-theme');
    themeBtn.textContent = currentTheme === 'dark' ? '☀️' : '🌙';
    document.body.appendChild(themeBtn);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    const themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) themeBtn.textContent = newTheme === 'dark' ? '☀️' : '🌙';
}

// ============================================
// WEBSOCKET ДЛЯ RAILWAY
// ============================================
function connectWebSocket() {
    let wsUrl;
    
    // Определяем URL для WebSocket в зависимости от окружения
    if (window.location.protocol === 'https:') {
        wsUrl = `wss://${window.location.host}/ws`;
    } else {
        wsUrl = `ws://${window.location.hostname}:8080`;
        // Если это не Railway (локальная разработка)
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            wsUrl = `ws://localhost:8080`;
        }
    }
    
    console.log('Подключение к WebSocket:', wsUrl);
    
    try {
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            console.log('WebSocket подключен');
            reconnectAttempts = 0;
            
            if (userStaticId) {
                ws.send(JSON.stringify({
                    type: 'auth',
                    staticId: userStaticId
                }));
            }
            
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000);
            
            loadRooms();
            showNotification('Подключено к серверу', 'success');
        };
        
        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleWebSocketMessage(data);
            } catch (e) {
                console.error('Ошибка парсинга:', e);
            }
        };
        
        ws.onerror = (error) => {
            console.error('WebSocket ошибка:', error);
            addSystemMessage('⚠️ Ошибка соединения с сервером');
        };
        
        ws.onclose = () => {
            console.log('WebSocket отключен');
            addSystemMessage('🔌 Соединение потеряно. Переподключение...');
            
            setTimeout(() => {
                if (reconnectAttempts < 10) {
                    reconnectAttempts++;
                    connectWebSocket();
                } else {
                    addSystemMessage('❌ Не удалось переподключиться. Обновите страницу.');
                    showNotification('Соединение потеряно. Обновите страницу.', 'error');
                }
            }, 3000);
        };
    } catch (e) {
        console.error('Ошибка подключения:', e);
        setTimeout(connectWebSocket, 5000);
    }
}

function handleWebSocketMessage(data) {
    switch(data.type) {
        case 'online_count':
            if (globalOnlineSpan) globalOnlineSpan.textContent = data.count;
            break;
            
        case 'auth_success':
            console.log('Аутентификация успешна');
            break;
            
        case 'voice_data':
            if (!isMuted && currentRoomType === 'voice') playAudio(data.audio);
            break;
            
        case 'text_message':
            if (currentRoomType === 'text') addMessage(`👤 ${data.from}: ${data.message}`);
            break;
            
        case 'user_joined':
            addSystemMessage(`👋 ${data.userId} присоединился`);
            updateMembersList(data.userId, true);
            break;
            
        case 'user_left':
            addSystemMessage(`👋 ${data.userId} покинул`);
            updateMembersList(data.userId, false);
            break;
            
        case 'members_list':
            if (data.members && Array.isArray(data.members)) updateMembersList(data.members);
            break;
            
        case 'speaking':
            showSpeakingIndicator(data.userId);
            break;
            
        case 'room_deleted':
        case 'room_closed':
            handleRoomDeleted(data.roomId);
            break;
            
        case 'volume_result':
            if (data.isWorking) {
                addSystemMessage(`🎤 Проверка: ${data.message} (${(data.volume * 100).toFixed(1)}%)`);
            } else {
                addSystemMessage(`🎤 Проверка: ${data.message}`);
            }
            break;
            
        case 'pong':
            // Heartbeat ответ
            break;
            
        case 'error':
            showNotification(data.message, 'error');
            break;
            
        default:
            console.log('Неизвестный тип:', data.type);
    }
}

// ============================================
// КОМНАТЫ
// ============================================
async function loadRooms() {
    try {
        const response = await fetch('api.php?action=getRooms');
        if (!response.ok) throw new Error('Failed to load rooms');
        const rooms = await response.json();
        displayRooms(rooms);
    } catch (error) {
        console.error('Error loading rooms:', error);
        if (roomsListDiv) roomsListDiv.innerHTML = '<div class="error">❌ Ошибка загрузки комнат</div>';
    }
}

function displayRooms(rooms) {
    if (!roomsListDiv) return;
    
    if (rooms.length === 0) {
        roomsListDiv.innerHTML = '<div class="info">📭 Нет активных комнат. Создайте первую!</div>';
        return;
    }
    
    roomsListDiv.innerHTML = '';
    rooms.forEach(room => {
        const roomDiv = document.createElement('div');
        roomDiv.className = 'room-item';
        
        const typeIcon = room.type === 'voice' ? '🎤' : '💬';
        const isFull = room.current_members >= room.max_people;
        const canDelete = (room.created_by === userStaticId) || isAdmin;
        
        roomDiv.innerHTML = `
            <div class="room-info">
                <span class="room-name">${escapeHtml(room.name)}</span>
                <span class="room-type">${typeIcon} ${room.type === 'voice' ? 'Голосовая' : 'Текстовая'}</span>
                <span class="room-members">👥 ${room.current_members}/${room.max_people}</span>
                ${room.created_by ? `<div style="font-size: 10px; color: var(--text-muted, #888); margin-top: 3px;">👑 Создатель: ${escapeHtml(room.created_by)}</div>` : ''}
            </div>
            <div class="room-actions">
                <button onclick="joinRoom(${room.id}, '${room.type}')" class="join-btn" ${isFull ? 'disabled' : ''}>
                    ${isFull ? '🚫 Полна' : '🎧 Войти'}
                </button>
                ${canDelete ? `<button onclick="deleteRoom(${room.id})" class="delete-room-btn" style="background:#f44336;padding:5px 10px;font-size:12px;width:auto;margin-left:5px;">🗑️ Удалить</button>` : ''}
            </div>
        `;
        roomsListDiv.appendChild(roomDiv);
    });
}

async function deleteRoom(roomId) {
    const confirmed = confirm('Удалить комнату? Все участники будут вынуждены покинуть её.');
    if (!confirmed) return;
    
    try {
        const response = await fetch('api.php?action=deleteRoom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ room_id: roomId })
        });
        const data = await response.json();
        
        if (data.success) {
            showNotification('Комната удалена', 'success');
            if (currentRoom === roomId) await leaveRoom();
            await loadRooms();
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'room_deleted', roomId: roomId }));
            }
        } else {
            showNotification(data.error || 'Ошибка удаления', 'error');
        }
    } catch (error) {
        console.error('Error deleting room:', error);
        showNotification('Ошибка удаления комнаты', 'error');
    }
}

function handleRoomDeleted(roomId) {
    if (currentRoom === roomId) {
        addSystemMessage('⚠️ Комната была удалена');
        leaveRoom();
    }
    loadRooms();
}

async function createRoom() {
    const roomName = document.getElementById('room-name')?.value.trim();
    const roomMax = document.getElementById('room-max')?.value;
    const roomType = document.getElementById('room-type')?.value;
    
    if (!roomName) {
        showNotification('Введите название комнаты', 'error');
        return;
    }
    
    if (roomName.length > 50) {
        showNotification('Название комнаты не должно превышать 50 символов', 'error');
        return;
    }
    
    try {
        const response = await fetch('api.php?action=createRoom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: roomName, max: parseInt(roomMax) || 10, type: roomType })
        });
        const data = await response.json();
        
        if (data.success) {
            showNotification(`Комната "${roomName}" создана!`, 'success');
            const roomNameInput = document.getElementById('room-name');
            if (roomNameInput) roomNameInput.value = '';
            await loadRooms();
            setTimeout(async () => {
                if (data.room_id) {
                    await joinRoom(data.room_id, roomType);
                } else {
                    const roomsResponse = await fetch('api.php?action=getRooms');
                    const rooms = await roomsResponse.json();
                    const newRoom = rooms.find(r => r.name === roomName);
                    if (newRoom) await joinRoom(newRoom.id, newRoom.type);
                }
            }, 1000);
        } else {
            showNotification(data.error || 'Ошибка создания комнаты', 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showNotification('Ошибка создания комнаты', 'error');
    }
}

async function joinRoom(roomId, roomType) {
    console.log('Вход в комнату:', roomId, roomType);
    if (currentRoom) await leaveRoom();
    
    try {
        const response = await fetch('api.php?action=joinRoom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ room_id: roomId })
        });
        const data = await response.json();
        
        if (data.success) {
            currentRoom = roomId;
            currentRoomType = roomType;
            
            if (currentRoomInfo) {
                currentRoomInfo.innerHTML = `
                    <div class="current-room-header">
                        <h3>📢 ${escapeHtml(data.room_name)}</h3>
                        <div id="room-members-list" class="members-list">
                            <h4>👥 Участники (<span id="members-count">1</span>)</h4>
                            <div id="members-container">
                                <div class="member-item">
                                    <span class="member-name">${escapeHtml(userStaticId)} (Вы)</span>
                                    <span class="member-status">🎤</span>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }
            
            if (roomType === 'voice') {
                if (voiceControls) voiceControls.style.display = 'flex';
                if (textInputDiv) textInputDiv.style.display = 'none';
                if (messagesDiv) {
                    messagesDiv.innerHTML = '';
                    addSystemMessage('🎤 Вы вошли в голосовую комнату. Нажмите "Включить микрофон" чтобы начать говорить.');
                }
            } else {
                if (voiceControls) voiceControls.style.display = 'none';
                if (textInputDiv) textInputDiv.style.display = 'flex';
                if (messagesDiv) {
                    messagesDiv.innerHTML = '';
                    addSystemMessage('💬 Добро пожаловать в текстовый чат!');
                }
            }
            
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'join_room', roomId: roomId }));
            }
            await loadRoomMembers(roomId);
        } else {
            showNotification(data.error || 'Ошибка входа в комнату', 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showNotification('Ошибка входа в комнату', 'error');
    }
}

async function loadRoomMembers(roomId) {
    try {
        const response = await fetch(`api.php?action=getRoomMembers&room_id=${roomId}`);
        const data = await response.json();
        
        if (data.members && data.members.length > 0) {
            const container = document.getElementById('members-container');
            const countSpan = document.getElementById('members-count');
            if (container && countSpan) {
                container.innerHTML = '';
                data.members.forEach(member => {
                    const isCurrentUser = member === userStaticId;
                    const memberDiv = document.createElement('div');
                    memberDiv.className = 'member-item';
                    memberDiv.innerHTML = `
                        <span class="member-name">${escapeHtml(member)} ${isCurrentUser ? '(Вы)' : ''}</span>
                        <span class="member-status">${isCurrentUser ? '🎤' : '🟢'}</span>
                    `;
                    container.appendChild(memberDiv);
                });
                countSpan.textContent = data.members.length;
            }
        }
    } catch (error) {
        console.error('Error loading members:', error);
    }
}

function updateMembersList(members, add = true) {
    const container = document.getElementById('members-container');
    const countSpan = document.getElementById('members-count');
    if (!container) return;
    
    if (Array.isArray(members)) {
        roomMembers.clear();
        container.innerHTML = '';
        members.forEach(member => {
            roomMembers.set(member, true);
            const isCurrentUser = member === userStaticId;
            const memberDiv = document.createElement('div');
            memberDiv.className = 'member-item';
            memberDiv.innerHTML = `
                <span class="member-name">${escapeHtml(member)} ${isCurrentUser ? '(Вы)' : ''}</span>
                <span class="member-status">${isCurrentUser ? '🎤' : '🟢'}</span>
            `;
            container.appendChild(memberDiv);
        });
        if (countSpan) countSpan.textContent = container.children.length;
    } else if (add) {
        if (!roomMembers.has(members) && members !== userStaticId) {
            roomMembers.set(members, true);
            const memberDiv = document.createElement('div');
            memberDiv.className = 'member-item';
            memberDiv.innerHTML = `
                <span class="member-name">${escapeHtml(members)}</span>
                <span class="member-status">🟢</span>
            `;
            container.appendChild(memberDiv);
            if (countSpan) countSpan.textContent = container.children.length;
        }
    } else {
        const items = container.querySelectorAll('.member-item');
        for (let item of items) {
            const nameSpan = item.querySelector('.member-name');
            if (nameSpan && nameSpan.textContent.replace(' (Вы)', '') === members) {
                item.remove();
                roomMembers.delete(members);
                break;
            }
        }
        if (countSpan) countSpan.textContent = container.children.length;
    }
}

function showSpeakingIndicator(userId) {
    const container = document.getElementById('members-container');
    if (!container) return;
    const items = container.querySelectorAll('.member-item');
    for (let item of items) {
        const nameSpan = item.querySelector('.member-name');
        if (nameSpan && nameSpan.textContent.replace(' (Вы)', '') === userId) {
            const statusSpan = item.querySelector('.member-status');
            if (statusSpan) {
                statusSpan.innerHTML = '🔊';
                statusSpan.classList.add('speaking');
                setTimeout(() => {
                    if (statusSpan) {
                        statusSpan.innerHTML = '🟢';
                        statusSpan.classList.remove('speaking');
                    }
                }, 500);
            }
            break;
        }
    }
}

async function leaveRoom() {
    if (!currentRoom) return;
    
    try {
        await fetch('api.php?action=leaveRoom', { method: 'POST' });
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'leave_room' }));
        }
        if (mediaStream) stopMicrophone();
        
        currentRoom = null;
        currentRoomType = null;
        if (currentRoomInfo) currentRoomInfo.innerHTML = '';
        if (voiceControls) voiceControls.style.display = 'none';
        if (textInputDiv) textInputDiv.style.display = 'none';
        if (messagesDiv) {
            messagesDiv.innerHTML = '';
            addSystemMessage('🚪 Вы покинули комнату');
        }
        roomMembers.clear();
        await loadRooms();
    } catch (error) {
        console.error('Error leaving room:', error);
    }
}

function leaveRoomSync() {
    if (currentRoom) navigator.sendBeacon('api.php?action=leaveRoom');
}

// ============================================
// МИКРОФОН И ПРОВЕРКА
// ============================================
async function testMicrophone() {
    if (isTestingMic) {
        stopMicTest();
        return;
    }
    
    addSystemMessage('🎤 Проверка микрофона... Разрешите доступ');
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        testStream = stream;
        
        testContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = testContext.createMediaStreamSource(stream);
        
        // Обратная связь - слышим свой голос
        const gainNode = testContext.createGain();
        gainNode.gain.value = 0.7;
        
        const analyser = testContext.createAnalyser();
        analyser.fftSize = 256;
        
        source.connect(analyser);
        source.connect(gainNode);
        gainNode.connect(testContext.destination);
        
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        isTestingMic = true;
        
        const wasMuted = isMuted;
        if (wasMuted) isMuted = false;
        
        const indicator = document.createElement('div');
        indicator.id = 'mic-test-indicator';
        indicator.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: var(--bg-secondary, #2d2d2d);
            padding: 25px;
            border-radius: 20px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            z-index: 10000;
            text-align: center;
            min-width: 350px;
            border: 2px solid #4CAF50;
        `;
        indicator.innerHTML = `
            <h3>🎤 Проверка микрофона</h3>
            <div style="margin: 20px 0;">
                <div style="width: 100%; height: 40px; background: #ddd; border-radius: 20px; overflow: hidden;">
                    <div id="volume-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #4CAF50, #2196F3); transition: width 0.05s linear;"></div>
                </div>
                <p id="volume-text" style="margin-top: 15px;">🎤 Говорите... Вы слышите свой голос!</p>
            </div>
            <div id="mic-status" style="margin: 10px 0; padding: 10px; border-radius: 10px;"></div>
            <div style="display: flex; gap: 10px;">
                <button id="feedback-toggle" style="background: #2196F3; flex: 1;">🔊 Выключить обратную связь</button>
                <button onclick="stopMicTest()" style="background: #f44336; flex: 1;">Закрыть</button>
            </div>
        `;
        document.body.appendChild(indicator);
        
        let feedbackEnabled = true;
        const feedbackToggle = document.getElementById('feedback-toggle');
        if (feedbackToggle) {
            feedbackToggle.onclick = () => {
                feedbackEnabled = !feedbackEnabled;
                gainNode.gain.value = feedbackEnabled ? 0.7 : 0;
                feedbackToggle.textContent = feedbackEnabled ? '🔊 Выключить обратную связь' : '🔇 Включить обратную связь';
                feedbackToggle.style.background = feedbackEnabled ? '#f44336' : '#4CAF50';
            };
        }
        
        function checkVolume() {
            if (!isTestingMic) return;
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
            let percent = (sum / dataArray.length / 255) * 100;
            
            const volumeBar = document.getElementById('volume-bar');
            const volumeText = document.getElementById('volume-text');
            const micStatus = document.getElementById('mic-status');
            
            if (volumeBar) volumeBar.style.width = percent + '%';
            
            if (percent > 20) {
                if (volumeText) volumeText.innerHTML = '🔊 Отлично! Микрофон работает!';
                if (micStatus) {
                    micStatus.innerHTML = '✅ Микрофон работает корректно';
                    micStatus.style.background = 'rgba(76, 175, 80, 0.2)';
                    micStatus.style.color = '#4CAF50';
                }
            } else if (percent > 5) {
                if (volumeText) volumeText.innerHTML = '🎤 Слышно, но тихо. Говорите громче.';
                if (micStatus) {
                    micStatus.innerHTML = '⚠️ Низкая громкость';
                    micStatus.style.background = 'rgba(255, 152, 0, 0.2)';
                    micStatus.style.color = '#FF9800';
                }
            } else {
                if (volumeText) volumeText.innerHTML = '🔇 Ничего не слышно. Проверьте микрофон.';
                if (micStatus) {
                    micStatus.innerHTML = '❌ Микрофон не работает!';
                    micStatus.style.background = 'rgba(244, 67, 54, 0.2)';
                    micStatus.style.color = '#f44336';
                }
            }
            testAnimationId = requestAnimationFrame(checkVolume);
        }
        
        checkVolume();
        
        const testProcessorNode = testContext.createScriptProcessor(4096, 1, 1);
        source.connect(testProcessorNode);
        testProcessorNode.onaudioprocess = (e) => {
            if (!isTestingMic) return;
            const inputData = e.inputBuffer.getChannelData(0);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'volume_test', audio: Array.from(inputData) }));
            }
        };
        
        window.restoreMuteAfterTest = () => { if (wasMuted) isMuted = wasMuted; };
        
    } catch (error) {
        console.error('Mic test error:', error);
        showNotification('Не удалось получить доступ к микрофону', 'error');
    }
}

function stopMicTest() {
    isTestingMic = false;
    if (testAnimationId) cancelAnimationFrame(testAnimationId);
    if (testStream) testStream.getTracks().forEach(track => track.stop());
    if (testContext) testContext.close();
    const indicator = document.getElementById('mic-test-indicator');
    if (indicator) indicator.remove();
    if (window.restoreMuteAfterTest) window.restoreMuteAfterTest();
    addSystemMessage('🔇 Проверка микрофона завершена');
}

async function startMicrophone() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        mediaStream = stream;
        
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        
        audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
        source.connect(audioProcessor);
        audioProcessor.connect(audioContext.destination);
        
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        let lastSendTime = 0;
        
        audioProcessor.onaudioprocess = (e) => {
            if (isMuted || !ws || ws.readyState !== WebSocket.OPEN || !currentRoom || currentRoomType !== 'voice') return;
            
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
            let volumePercent = (sum / dataArray.length / 255) * 100;
            
            const now = Date.now();
            if (now - lastSendTime < 50) return;
            
            if (volumePercent > 5) {
                lastSendTime = now;
                const inputData = e.inputBuffer.getChannelData(0);
                ws.send(JSON.stringify({ type: 'voice_data', audio: Array.from(inputData), volume: volumePercent }));
                showLocalSpeakingIndicator(volumePercent);
            }
        };
        
        addSystemMessage('🎙️ Микрофон активирован');
        if (muteBtn) {
            muteBtn.textContent = '🔇 Выключить микрофон';
            muteBtn.style.background = '#4CAF50';
        }
        isMuted = false;
        if (audioContext.state === 'suspended') await audioContext.resume();
        
    } catch (error) {
        console.error('Microphone error:', error);
        addSystemMessage('❌ Ошибка доступа к микрофону');
        showNotification('Разрешите доступ к микрофону в настройках браузера', 'error');
    }
}

function stopMicrophone() {
    if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
    if (audioProcessor) audioProcessor.disconnect();
    if (audioContext) audioContext.close();
    mediaStream = null;
    audioProcessor = null;
    audioContext = null;
    addSystemMessage('🔇 Микрофон отключен');
    if (muteBtn) {
        muteBtn.textContent = '🎤 Включить микрофон';
        muteBtn.style.background = '#764ba2';
    }
}

function toggleMute() {
    if (!mediaStream) {
        startMicrophone();
        return;
    }
    isMuted = !isMuted;
    if (muteBtn) {
        muteBtn.textContent = isMuted ? '🎤 Включить микрофон' : '🔇 Выключить микрофон';
        muteBtn.style.background = isMuted ? '#f44336' : '#4CAF50';
    }
    addSystemMessage(isMuted ? '🔇 Микрофон выключен' : '🎙️ Микрофон включен');
}

let speakingIndicatorTimeout = null;
function showLocalSpeakingIndicator(volume) {
    const muteBtnLocal = document.getElementById('mute-btn');
    if (muteBtnLocal && !isMuted) {
        const intensity = Math.min(volume / 100, 1);
        const r = 76 + (255 - 76) * intensity;
        const g = 75 + (75 - 75) * intensity;
        const b = 162 + (0 - 162) * intensity;
        muteBtnLocal.style.background = `rgb(${r}, ${g}, ${b})`;
        if (speakingIndicatorTimeout) clearTimeout(speakingIndicatorTimeout);
        speakingIndicatorTimeout = setTimeout(() => {
            if (muteBtnLocal && !isMuted) muteBtnLocal.style.background = '#4CAF50';
        }, 200);
    }
}

function playAudio(audioArray) {
    if (!audioContext || audioContext.state === 'closed') {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') audioContext.resume();
    try {
        const buffer = audioContext.createBuffer(1, audioArray.length, audioContext.sampleRate);
        buffer.copyToChannel(new Float32Array(audioArray), 0);
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        source.start();
    } catch (error) {
        console.error('Error playing audio:', error);
    }
}

// ============================================
// ТЕКСТОВЫЕ СООБЩЕНИЯ
// ============================================
function sendTextMessage() {
    if (!textMsgInput) return;
    const message = textMsgInput.value.trim();
    if (!message) return;
    if (!currentRoom || currentRoomType !== 'text') {
        addSystemMessage('❌ Вы не в текстовой комнате');
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'text_message', message: message }));
        addMessage(`👤 Вы: ${message}`);
        textMsgInput.value = '';
    } else {
        addSystemMessage('❌ Нет соединения с сервером');
    }
}

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================
function addMessage(text) {
    if (!messagesDiv) return;
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';
    messageDiv.textContent = text;
    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    while (messagesDiv.children.length > 200) messagesDiv.removeChild(messagesDiv.firstChild);
}

function addSystemMessage(text) {
    if (!messagesDiv) return;
    const messageDiv = document.createElement('div');
    messageDiv.className = 'system-message';
    messageDiv.innerHTML = `🔔 ${escapeHtml(text)}`;
    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function reportUser() {
    const targetId = prompt('Введите Static ID пользователя:');
    if (!targetId) return;
    const reason = prompt('Причина жалобы:');
    if (!reason) return;
    if (targetId === userStaticId) {
        showNotification('Нельзя жаловаться на себя', 'error');
        return;
    }
    try {
        const response = await fetch('api.php?action=report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: targetId, reason: reason })
        });
        const data = await response.json();
        if (data.success) {
            showNotification(`Жалоба на ${targetId} отправлена`, 'success');
        } else {
            showNotification(data.error || 'Ошибка отправки', 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showNotification('Ошибка отправки жалобы', 'error');
    }
}

// Глобальные функции для доступа из HTML
window.createRoom = createRoom;
window.joinRoom = joinRoom;
window.leaveRoom = leaveRoom;
window.reportUser = reportUser;
window.sendTextMessage = sendTextMessage;
window.testMicrophone = testMicrophone;
window.stopMicTest = stopMicTest;
window.deleteRoom = deleteRoom;
