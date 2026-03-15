#!/bin/sh
# Substitute only our env vars, leaving nginx variables ($uri, $host, etc.) intact
envsubst '$PORT $SERVER_HOST $SERVER_PORT' < /etc/nginx/nginx-template.conf > /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
