<?php
require_once 'config.php';
header('Content-Type: application/json');

if (!isset($_SESSION['user_id'])) {
    http_response_code(401);
    echo json_encode(['error' => 'Не авторизован']);
    exit;
}

$action = $_GET['action'] ?? '';
$userStatic = $_SESSION['static_id'];

// Получить список комнат
if ($action === 'getRooms') {
    $stmt = $pdo->query("
        SELECT r.*, 
        (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) as current_members 
        FROM rooms r 
        WHERE r.is_active = 1 
        ORDER BY r.created_at DESC
    ");
    $rooms = $stmt->fetchAll(PDO::FETCH_ASSOC);
    echo json_encode($rooms);
    exit;
}

// Создать комнату
elseif ($action === 'createRoom') {
    $data = json_decode(file_get_contents('php://input'), true);
    $name = trim($data['name'] ?? '');
    $max = intval($data['max'] ?? 10);
    $type = $data['type'] ?? 'voice';
    
    if (empty($name)) {
        echo json_encode(['success' => false, 'error' => 'Название комнаты не может быть пустым']);
        exit;
    }
    
    if ($max < 1 || $max > 50) {
        echo json_encode(['success' => false, 'error' => 'Максимум участников должен быть от 1 до 50']);
        exit;
    }
    
    $stmt = $pdo->prepare("INSERT INTO rooms (name, max_people, type, created_by) VALUES (?, ?, ?, ?)");
    if ($stmt->execute([$name, $max, $type, $userStatic])) {
        $roomId = $pdo->lastInsertId();
        logAction($pdo, 'create_room', $userStatic, null, $name, $roomId);
        echo json_encode(['success' => true, 'room_id' => $roomId, 'room_name' => $name]);
    } else {
        echo json_encode(['success' => false, 'error' => 'Ошибка создания комнаты']);
    }
    exit;
}

// УДАЛЕНИЕ КОМНАТЫ (НОВАЯ ФУНКЦИЯ)
elseif ($action === 'deleteRoom') {
    $data = json_decode(file_get_contents('php://input'), true);
    $roomId = intval($data['room_id'] ?? 0);
    
    if (!$roomId) {
        echo json_encode(['success' => false, 'error' => 'Неверный ID комнаты']);
        exit;
    }
    
    // Проверяем, существует ли комната и имеет ли пользователь право удалить
    $stmt = $pdo->prepare("SELECT * FROM rooms WHERE id = ? AND (created_by = ? OR ? IN (SELECT static_id FROM users WHERE is_admin = 1))");
    $isAdmin = $pdo->prepare("SELECT is_admin FROM users WHERE static_id = ?");
    $isAdmin->execute([$userStatic]);
    $adminCheck = $isAdmin->fetch();
    $isUserAdmin = $adminCheck && $adminCheck['is_admin'] == 1;
    
    $stmt = $pdo->prepare("SELECT * FROM rooms WHERE id = ?");
    $stmt->execute([$roomId]);
    $room = $stmt->fetch();
    
    if (!$room) {
        echo json_encode(['success' => false, 'error' => 'Комната не найдена']);
        exit;
    }
    
    // Проверяем права (создатель комнаты или админ)
    if ($room['created_by'] !== $userStatic && !$isUserAdmin) {
        echo json_encode(['success' => false, 'error' => 'У вас нет прав на удаление этой комнаты']);
        exit;
    }
    
    // Удаляем всех участников из комнаты
    $stmt = $pdo->prepare("DELETE FROM room_members WHERE room_id = ?");
    $stmt->execute([$roomId]);
    
    // Удаляем комнату
    $stmt = $pdo->prepare("DELETE FROM rooms WHERE id = ?");
    if ($stmt->execute([$roomId])) {
        logAction($pdo, 'delete_room', $userStatic, null, $room['name'], $roomId);
        echo json_encode(['success' => true, 'message' => 'Комната удалена']);
    } else {
        echo json_encode(['success' => false, 'error' => 'Ошибка удаления комнаты']);
    }
    exit;
}

// Войти в комнату
elseif ($action === 'joinRoom') {
    $data = json_decode(file_get_contents('php://input'), true);
    $roomId = intval($data['room_id'] ?? 0);
    
    if (!$roomId) {
        echo json_encode(['success' => false, 'error' => 'Неверный ID комнаты']);
        exit;
    }
    
    $stmt = $pdo->prepare("SELECT * FROM rooms WHERE id = ? AND is_active = 1");
    $stmt->execute([$roomId]);
    $room = $stmt->fetch(PDO::FETCH_ASSOC);
    
    if (!$room) {
        echo json_encode(['success' => false, 'error' => 'Комната не найдена']);
        exit;
    }
    
    $stmt = $pdo->prepare("SELECT COUNT(*) as count FROM room_members WHERE room_id = ?");
    $stmt->execute([$roomId]);
    $memberCount = $stmt->fetch(PDO::FETCH_ASSOC)['count'];
    
    if ($memberCount >= $room['max_people']) {
        echo json_encode(['success' => false, 'error' => 'Комната заполнена']);
        exit;
    }
    
    $stmt = $pdo->prepare("SELECT * FROM room_members WHERE room_id = ? AND user_static_id = ?");
    $stmt->execute([$roomId, $userStatic]);
    if ($stmt->fetch()) {
        echo json_encode(['success' => true, 'room_name' => $room['name'], 'already_in' => true]);
        exit;
    }
    
    $stmt = $pdo->prepare("INSERT INTO room_members (room_id, user_static_id) VALUES (?, ?)");
    if ($stmt->execute([$roomId, $userStatic])) {
        logAction($pdo, 'join_room', $userStatic, null, $room['name'], $roomId);
        echo json_encode(['success' => true, 'room_name' => $room['name']]);
    } else {
        echo json_encode(['success' => false, 'error' => 'Ошибка входа в комнату']);
    }
    exit;
}

// Выйти из комнаты
elseif ($action === 'leaveRoom') {
    $stmt = $pdo->prepare("DELETE FROM room_members WHERE user_static_id = ?");
    $stmt->execute([$userStatic]);
    echo json_encode(['success' => true]);
    exit;
}

// Получить онлайн
elseif ($action === 'getOnlineCount') {
    $stmt = $pdo->query("SELECT COUNT(DISTINCT user_static_id) as count FROM room_members");
    $count = $stmt->fetch(PDO::FETCH_ASSOC)['count'];
    echo json_encode(['count' => $count]);
    exit;
}

// Отправить жалобу
elseif ($action === 'report') {
    $data = json_decode(file_get_contents('php://input'), true);
    $target = trim($data['target'] ?? '');
    $reason = trim($data['reason'] ?? '');
    
    if (empty($target) || empty($reason)) {
        echo json_encode(['success' => false, 'error' => 'Укажите пользователя и причину']);
        exit;
    }
    
    if ($target === $userStatic) {
        echo json_encode(['success' => false, 'error' => 'Нельзя жаловаться на себя']);
        exit;
    }
    
    $stmt = $pdo->prepare("INSERT INTO reports (reporter_static_id, reported_static_id, reason) VALUES (?, ?, ?)");
    if ($stmt->execute([$userStatic, $target, $reason])) {
        logAction($pdo, 'report', $userStatic, $target, $reason);
        echo json_encode(['success' => true]);
    } else {
        echo json_encode(['success' => false, 'error' => 'Ошибка отправки жалобы']);
    }
    exit;
}

// Получить участников комнаты
elseif ($action === 'getRoomMembers') {
    $roomId = intval($_GET['room_id'] ?? 0);
    
    if (!$roomId) {
        echo json_encode(['members' => []]);
        exit;
    }
    
    $stmt = $pdo->prepare("SELECT user_static_id FROM room_members WHERE room_id = ?");
    $stmt->execute([$roomId]);
    $members = $stmt->fetchAll(PDO::FETCH_COLUMN);
    
    echo json_encode(['members' => $members]);
    exit;
}

// Проверить, в комнате ли пользователь
elseif ($action === 'checkRoom') {
    $stmt = $pdo->prepare("SELECT r.* FROM rooms r 
                           INNER JOIN room_members rm ON rm.room_id = r.id 
                           WHERE rm.user_static_id = ? AND r.is_active = 1");
    $stmt->execute([$userStatic]);
    $room = $stmt->fetch(PDO::FETCH_ASSOC);
    
    if ($room) {
        echo json_encode(['in_room' => true, 'room_id' => $room['id'], 'room_name' => $room['name']]);
    } else {
        echo json_encode(['in_room' => false]);
    }
    exit;
}

else {
    echo json_encode(['error' => 'Неизвестное действие']);
}
?>
