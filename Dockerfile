FROM node:18-alpine

# Устанавливаем PHP и Apache
RUN apk add --no-cache \
    apache2 \
    apache2-proxy \
    apache2-ssl \
    php82 \
    php82-apache2 \
    php82-mysqli \
    php82-pdo_mysql \
    php82-mbstring \
    php82-json \
    php82-session \
    mysql-client \
    curl \
    bash

# Копируем все файлы проекта
COPY . /var/www/html/

# Копируем конфиг Apache
RUN cp /var/www/html/.htaccess /etc/apache2/conf.d/ 2>/dev/null || true

# Настраиваем Apache для прокси WebSocket
RUN echo 'ProxyPass /ws ws://localhost:8080/ws\n\
ProxyPassReverse /ws ws://localhost:8080/ws' >> /etc/apache2/conf.d/websocket.conf

# Устанавливаем Node.js зависимости
WORKDIR /var/www/html
RUN npm install

# Создаем скрипт запуска
RUN echo '#!/bin/bash\n\
httpd -k start\n\
node server.js' > /start.sh && chmod +x /start.sh

EXPOSE 80 8080

CMD ["/start.sh"]
