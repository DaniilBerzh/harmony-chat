<?php
session_start();
date_default_timezone_set('Europe/Moscow');

// Railway дает переменные окружения
$host = getenv('MYSQLHOST') ?: 'localhost';
$dbname = getenv('MYSQLDATABASE') ?: 'harmony_chat';
$username = getenv('MYSQLUSER') ?: 'root';
$password = getenv('MYSQLPASSWORD') ?: '';

try {
    $pdo = new PDO("mysql:host=$host;dbname=$dbname;charset=utf8", $username, $password);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch(PDOException $e) {
    die("Connection failed: " . $e->getMessage());
}

function logAction($pdo, $action, $userStaticId, $targetStaticId = null, $details = null, $roomId = null) {
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $stmt = $pdo->prepare("INSERT INTO logs (action, user_static_id, target_static_id, details, room_id, ip_address) 
                           VALUES (?, ?, ?, ?, ?, ?)");
    $stmt->execute([$action, $userStaticId, $targetStaticId, $details, $roomId, $ip]);
}
?>
