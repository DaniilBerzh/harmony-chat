FROM ubuntu:22.04

# Устанавливаем необходимые пакеты
RUN apt-get update && apt-get install -y \
    apache2 \
    php8.1 \
    php8.1-mysql \
    php8.1-mbstring \
    php8.1-json \
    nodejs \
    npm \
    mysql-client \
    && apt-get clean

# Копируем все файлы проекта
COPY . /var/www/html/

# Копируем конфиг Apache для WebSocket прокси
RUN echo 'ProxyPass /ws ws://localhost:8080/ws\n\
ProxyPassReverse /ws ws://localhost:8080/ws' > /etc/apache2/conf-available/websocket.conf && \
    a2enconf websocket && \
    a2enmod proxy proxy_http proxy_wstunnel

# Устанавливаем Node.js зависимости
WORKDIR /var/www/html
RUN npm install

# Создаем скрипт запуска
RUN echo '#!/bin/bash\n\
service apache2 start\n\
node server.js' > /start.sh && chmod +x /start.sh

# Открываем порты
EXPOSE 80 8080

CMD ["/start.sh"]
