    CREATE DATABASE harmony_chat;
USE harmony_chat;

-- Пользователи
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    static_id VARCHAR(10) UNIQUE NOT NULL,
    age INT CHECK (age BETWEEN 11 AND 18),
    password_hash VARCHAR(255) NOT NULL,
    is_admin BOOLEAN DEFAULT FALSE,
    is_banned BOOLEAN DEFAULT FALSE,
    ban_reason TEXT,
    ban_date DATETIME,
    unban_date DATETIME,
    banned_by VARCHAR(10),
    is_muted BOOLEAN DEFAULT FALSE,
    mute_until DATETIME,
    warning_count INT DEFAULT 0,
    warning_expires DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Комнаты (голосовые и текстовые)
CREATE TABLE rooms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    type ENUM('voice', 'text') DEFAULT 'voice',
    max_people INT DEFAULT 10,
    created_by VARCHAR(10),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    FOREIGN KEY (created_by) REFERENCES users(static_id)
);

-- Участники комнат (онлайн)
CREATE TABLE room_members (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT,
    user_static_id VARCHAR(10),
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (user_static_id) REFERENCES users(static_id),
    UNIQUE KEY unique_member (room_id, user_static_id)
);

-- Бан-лист
CREATE TABLE ban_list (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_static_id VARCHAR(10),
    banned_by VARCHAR(10),
    reason TEXT,
    ban_date DATETIME,
    unban_date DATETIME,
    FOREIGN KEY (user_static_id) REFERENCES users(static_id),
    FOREIGN KEY (banned_by) REFERENCES users(static_id)
);

-- Логи действий
CREATE TABLE logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    action VARCHAR(255),
    user_static_id VARCHAR(10),
    target_static_id VARCHAR(10),
    details TEXT,
    room_id INT NULL,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Репорты (жалобы)
CREATE TABLE reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    reporter_static_id VARCHAR(10),
    reported_static_id VARCHAR(10),
    reason TEXT,
    status ENUM('pending', 'accepted', 'cancelled') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    FOREIGN KEY (reporter_static_id) REFERENCES users(static_id),
    FOREIGN KEY (reported_static_id) REFERENCES users(static_id)
);
