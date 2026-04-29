<?php
require_once 'config.php';

$data = json_decode(file_get_contents('php://input'), true);
$static_id = $data['static_id'] ?? '';
$password = $data['password'] ?? '';

$stmt = $pdo->prepare("SELECT * FROM users WHERE static_id = ?");
$stmt->execute([$static_id]);
$user = $stmt->fetch();

if ($user && password_verify($password, $user['password_hash'])) {
    if ($user['is_banned'] && ($user['unban_date'] > date('Y-m-d H:i:s'))) {
        echo json_encode(['success' => false, 'error' => 'Вы забанены до ' . $user['unban_date']]);
        exit;
    }
    $_SESSION['user_id'] = $user['id'];
    $_SESSION['static_id'] = $user['static_id'];
    $_SESSION['is_admin'] = $user['is_admin'];
    logAction($pdo, 'login', $static_id);
    echo json_encode(['success' => true]);
} else {
    echo json_encode(['success' => false, 'error' => 'Неверный Static ID или пароль']);
}
?>
