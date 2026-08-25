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
sudo touch kx-web-codebase.txt
sudo chmod 666 kx-web-codebase.txt
find html/kx-results \( -name "*.php" \) -print -exec sh -c 'echo "=== FILE: $1 ==="; cat "$1"; echo' _ {} \; > kx-web-codebase.txt
find kx-web-app \( -name "*.php" -o -name "*.sql" \) -print -exec sh -c 'echo "=== FILE: $1 ==="; cat "$1"; echo' _ {} \; >> kx-web-codebase.txt
```
**Running tests**

Test everything
```
npm test          # = node --test  (discovers test/*.test.js)
```

Test one file

```
node --test test/tt-continuous-clock.test.js
```


**Random commands**
Occtionally I ahve a need to find files that have been updated after the give date: 
```
find . -newermt "2026-08-02" 
```

