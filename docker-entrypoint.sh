#!/bin/sh
# Extract DNS resolver from the container's resolv.conf (needed for Railway internal networking)
export RESOLVER=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)
# Fallback to Google DNS if no resolver found
: "${RESOLVER:=8.8.8.8}"

# Substitute only our env vars, leaving nginx variables ($uri, $host, etc.) intact
envsubst '$PORT $SERVER_HOST $SERVER_PORT $RESOLVER' < /etc/nginx/nginx-template.conf > /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
