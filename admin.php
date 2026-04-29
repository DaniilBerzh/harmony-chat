<?php
require_once 'config.php';
if (!isset($_SESSION['user_id']) || !$_SESSION['is_admin']) {
    header('Location: index.html');
    exit;
}

$adminStatic = $_SESSION['static_id'];

// Обработка команд консоли
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['console_cmd'])) {
    $cmd = $_POST['console_cmd'];
    $output = [];
    if (preg_match('/^\/ban (\S+) (\d+) (.+)$/', $cmd, $matches)) {
        $target = $matches[1];
        $days = $matches[2];
        $reason = $matches[3];
        $unban = date('Y-m-d H:i:s', strtotime("+$days days"));
        $stmt = $pdo->prepare("UPDATE users SET is_banned=1, ban_reason=?, unban_date=?, banned_by=? WHERE static_id=?");
        $stmt->execute([$reason, $unban, $adminStatic, $target]);
        $stmt2 = $pdo->prepare("INSERT INTO ban_list (user_static_id, banned_by, reason, ban_date, unban_date) VALUES (?,?,?,NOW(),?)");
        $stmt2->execute([$target, $adminStatic, $reason, $unban]);
        logAction($pdo, 'ban', $adminStatic, $target, $reason);
        $output[] = "✅ Пользователь $target забанен на $days дней. Причина: $reason";
    }
    elseif (preg_match('/^\/mute (\S+) (\d+) (\d+) (\d+)$/', $cmd, $matches)) {
        $target = $matches[1];
        $hours = $matches[2];
        $minutes = $matches[3];
        $seconds = $matches[4];
        $until = date('Y-m-d H:i:s', strtotime("+$hours hours $minutes minutes $seconds seconds"));
        $stmt = $pdo->prepare("UPDATE users SET is_muted=1, mute_until=? WHERE static_id=?");
        $stmt->execute([$until, $target]);
        logAction($pdo, 'mute', $adminStatic, $target, "до $until");
        $output[] = "🔇 $target заглушен до $until";
    }
    elseif (preg_match('/^\/warn (\S+) (\d+)$/', $cmd, $matches)) {
        $target = $matches[1];
        $days = $matches[2];
        $expires = date('Y-m-d H:i:s', strtotime("+$days days"));
        $stmt = $pdo->prepare("UPDATE users SET warning_count=warning_count+1, warning_expires=? WHERE static_id=?");
        $stmt->execute([$expires, $target]);
        logAction($pdo, 'warn', $adminStatic, $target, "срок $days дней");
        $output[] = "⚠️ $target получил предупреждение на $days дней";
    }
    elseif ($cmd === '/reportlist') {
        $reports = $pdo->query("SELECT * FROM reports WHERE status='pending'")->fetchAll();
        foreach($reports as $r) {
            $output[] = "📋 Репорт #{$r['id']}: от {$r['reporter_static_id']} на {$r['reported_static_id']} | Причина: {$r['reason']}";
        }
        if(empty($output)) $output[] = "Нет активных репортов.";
    }
    elseif (preg_match('/^\/reportaccept (\d+)$/', $cmd, $matches)) {
        $repId = $matches[1];
        $stmt = $pdo->prepare("UPDATE reports SET status='accepted', resolved_at=NOW() WHERE id=?");
        $stmt->execute([$repId]);
        $output[] = "✅ Репорт #$repId принят.";
    }
    elseif (preg_match('/^\/reportcancel (\d+) (.+)$/', $cmd, $matches)) {
        $repId = $matches[1];
        $reason = $matches[2];
        $stmt = $pdo->prepare("UPDATE reports SET status='cancelled', resolved_at=NOW() WHERE id=?");
        $stmt->execute([$repId]);
        $output[] = "❌ Репорт #$repId отклонён. Причина: $reason";
    }
    else {
        $output[] = "❌ Неизвестная команда. Доступно: /ban, /mute, /warn, /reportlist, /reportaccept, /reportcancel";
    }
}
?>
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Админ-панель Harmony Chat</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <div class="admin-container">
        <h1>🔧 Админ-панель Harmony Chat</h1>
        <div class="admin-tabs">
            <button onclick="showTab('logs')">📜 Логи сайта</button>
            <button onclick="showTab('users')">👥 Все пользователи</button>
            <button onclick="showTab('bans')">⛔ Бан-лист</button>
            <button onclick="showTab('console')">💻 Консоль</button>
            <button onclick="showTab('reports')">📋 Репорты</button>
            <button onclick="showTab('permissions')">🔐 Права админов</button>
        </div>
        
        <!-- Логи -->
        <div id="logs-tab" class="tab-content">
            <h3>Логи действий</h3>
            <table border="1">
                <tr><th>Время</th><th>Действие</th><th>Пользователь</th><th>Цель</th><th>Детали</th></tr>
                <?php
                $logs = $pdo->query("SELECT * FROM logs ORDER BY created_at DESC LIMIT 100")->fetchAll();
                foreach($logs as $log): ?>
                <tr>
                    <td><?= $log['created_at'] ?></td>
                    <td><?= $log['action'] ?></td>
                    <td><?= $log['user_static_id'] ?></td>
                    <td><?= $log['target_static_id'] ?></td>
                    <td><?= $log['details'] ?></td>
                </tr>
                <?php endforeach; ?>
            </table>
        </div>
        
        <!-- Все пользователи -->
        <div id="users-tab" class="tab-content" style="display:none">
            <h3>Список пользователей</h3>
            <input type="text" id="searchUser" placeholder="Поиск по Static ID" onkeyup="searchUsers()">
            <table border="1" id="users-table">
                <tr><th>Static ID</th><th>Возраст</th><th>Статус</th><th>Комнат создано</th><th>Онлайн</th></tr>
                <?php
                $users = $pdo->query("SELECT u.*, 
                    (SELECT COUNT(*) FROM rooms WHERE created_by=u.static_id) as rooms_created,
                    (SELECT COUNT(*) FROM room_members WHERE user_static_id=u.static_id) as is_online
                    FROM users u")->fetchAll();
                foreach($users as $u): ?>
                <tr>
                    <td><?= $u['static_id'] ?></td>
                    <td><?= $u['age'] ?></td>
                    <td><?= $u['is_banned'] ? '🔴 Забанен' : ($u['is_muted'] ? '🔇 Заглушен' : '✅ Активен') ?></td>
                    <td><?= $u['rooms_created'] ?></td>
                    <td><?= $u['is_online'] ? '🟢 Онлайн' : '⚫ Оффлайн' ?></td>
                </tr>
                <?php endforeach; ?>
            </table>
        </div>
        
        <!-- Бан-лист -->
        <div id="bans-tab" class="tab-content" style="display:none">
            <h3>Бан-лист</h3>
            <table border="1">
                <tr><th>Пользователь</th><th>Кто забанил</th><th>Причина</th><th>Дата бана</th><th>Дата разбана</th></tr>
                <?php
                $bans = $pdo->query("SELECT * FROM ban_list ORDER BY ban_date DESC")->fetchAll();
                foreach($bans as $ban): ?>
                <tr>
                    <td><?= $ban['user_static_id'] ?></td>
                    <td><?= $ban['banned_by'] ?></td>
                    <td><?= $ban['reason'] ?></td>
                    <td><?= $ban['ban_date'] ?></td>
                    <td><?= $ban['unban_date'] ?></td>
                </tr>
                <?php endforeach; ?>
            </table>
        </div>
        
        <!-- Консоль -->
        <div id="console-tab" class="tab-content" style="display:none">
            <h3>Консоль команд</h3>
            <form method="post">
                <input type="text" name="console_cmd" style="width:80%" placeholder="/ban ID_статик дни причина  |  /mute ID_статик часы минуты секунды  |  /warn ID_статик дни  |  /reportlist  |  /reportaccept номер  |  /reportcancel номер причина">
                <button type="submit">Выполнить</button>
            </form>
            <?php if(isset($output)): ?>
                <div class="console-output">
                    <?php foreach($output as $line): ?>
                        <div><?= $line ?></div>
                    <?php endforeach; ?>
                </div>
            <?php endif; ?>
        </div>
        
        <!-- Репорты -->
        <div id="reports-tab" class="tab-content" style="display:none">
            <h3>Жалобы пользователей</h3>
            <table border="1">
                <tr><th>#</th><th>От кого</th><th>На кого</th><th>Причина</th><th>Статус</th></tr>
                <?php
                $reports = $pdo->query("SELECT * FROM reports ORDER BY created_at DESC")->fetchAll();
                foreach($reports as $r): ?>
                <tr>
                    <td><?= $r['id'] ?></td>
                    <td><?= $r['reporter_static_id'] ?></td>
                    <td><?= $r['reported_static_id'] ?></td>
                    <td><?= $r['reason'] ?></td>
                    <td><?= $r['status'] ?></td>
                </tr>
                <?php endforeach; ?>
            </table>
        </div>
        
        <!-- Права админов -->
        <div id="permissions-tab" class="tab-content" style="display:none">
            <h3>Назначение прав другим админам</h3>
            <form method="post">
                <input type="text" name="give_admin" placeholder="Static ID пользователя">
                <button type="submit" name="make_admin">Сделать админом</button>
            </form>
            <?php
            if(isset($_POST['make_admin']) && $_POST['give_admin']) {
                $stmt = $pdo->prepare("UPDATE users SET is_admin=1 WHERE static_id=?");
                $stmt->execute([$_POST['give_admin']]);
                echo "<div class='success'>✅ Права админа выданы!</div>";
            }
            ?>
        </div>
    </div>
    
    <script>
        function showTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
            document.getElementById(tabName + '-tab').style.display = 'block';
        }
        
        function searchUsers() {
            let input = document.getElementById('searchUser').value.toLowerCase();
            let rows = document.querySelectorAll('#users-table tr');
            rows.forEach((row, index) => {
                if(index === 0) return;
                let text = row.cells[0].textContent.toLowerCase();
                row.style.display = text.includes(input) ? '' : 'none';
            });
        }
    </script>
</body>
</html>
