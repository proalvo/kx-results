# Development

¨kx-results` is 99.9% developed by AI, mainly with Claude.

How to pack codebase to AI friedly format:

**kx-server**
```
cd {your directory for the kx-server.js}
find .  \( -name "*.js" -o -name "*.json" -o -name "*.html" -o -name "*.sql" \) -print -exec sh -c 'echo "=== FILE: $1 ==="; cat "$1"; echo' _ {} \; > kx-server-codebase.txt
```

**kx-web**
```
cd {your directory for the kx-web e.g. /var/www}
sudo find kx-web-app \( -name "*.php" -o -name "*.sql" \) -print -exec sh -c 'echo "=== FILE: $1 ==="; cat "$1"; echo' _ {} \; > kx-web-codebase.txt
sudo find html/kx-results \( -name "*.html" \) -print -exec sh -c 'echo "=== FILE: $1 ==="; cat "$1"; echo' _ {} \; > kx-web-codebase.txt
```


