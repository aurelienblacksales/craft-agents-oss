#!/bin/sh
# Extract DNS resolver from the container's resolv.conf (needed for Railway internal networking)
RESOLVER=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)
# Fallback to Google DNS if no resolver found
RESOLVER="${RESOLVER:-8.8.8.8}"
export RESOLVER

# Substitute only our env vars, leaving nginx variables ($uri, $host, etc.) intact
envsubst '$PORT $SERVER_HOST $SERVER_PORT $RESOLVER' < /etc/nginx/nginx-template.conf > /etc/nginx/conf.d/default.conf

# Log the generated config for debugging
echo "=== Generated nginx config ==="
cat /etc/nginx/conf.d/default.conf
echo "=== End nginx config ==="

# Test nginx config before starting
nginx -t 2>&1 || { echo "NGINX CONFIG ERROR"; exit 1; }

exec nginx -g 'daemon off;'
