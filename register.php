<?php
require_once 'config.php';

$data = json_decode(file_get_contents('php://input'), true);
$age = $data['age'] ?? null;
$password = $data['password'] ?? null;

if (!$age || !$password || $age < 11 || $age > 18) {
    echo json_encode(['success' => false, 'error' => 'Некорректный возраст']);
    exit;
}

// Генерируем числовой Static ID (6 цифр)
do {
    $static_id = '#' . str_pad(mt_rand(0, 999999), 6, '0', STR_PAD_LEFT);
    $stmt = $pdo->prepare("SELECT id FROM users WHERE static_id = ?");
    $stmt->execute([$static_id]);
} while ($stmt->fetch());

$hashed = password_hash($password, PASSWORD_DEFAULT);

$stmt = $pdo->prepare("INSERT INTO users (static_id, age, password_hash) VALUES (?, ?, ?)");
if ($stmt->execute([$static_id, $age, $hashed])) {
    logAction($pdo, 'register', $static_id);
    echo json_encode(['success' => true, 'static_id' => $static_id]);
} else {
    echo json_encode(['success' => false, 'error' => 'Ошибка БД']);
}
?>
