# Running RepoLens continuously

## macOS (launchd)

`com.repolens.server.plist` was generated for this checkout (absolute paths inside). It starts
RepoLens at login, restarts it if it exits, and logs to `data/repolens.log`. Configuration
comes from `.env` in the project directory.

```bash
cp deploy/com.repolens.server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.repolens.server.plist
tail -f data/repolens.log
```

Stop and remove:

```bash
launchctl unload ~/Library/LaunchAgents/com.repolens.server.plist
rm ~/Library/LaunchAgents/com.repolens.server.plist
```

Because it runs as your user, the `claude` and `codex` CLI logins in your keychain are available.

## Linux (systemd user unit)

```ini
[Unit]
Description=RepoLens
After=network-online.target

[Service]
WorkingDirectory=/path/to/repolens
ExecStart=/usr/bin/npx tsx src/cli.ts serve
Restart=always
Environment=PATH=/home/you/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

Save as `~/.config/systemd/user/repolens.service`, then `systemctl --user enable --now repolens`.

## Docker

`docker compose up -d` (OpenRouter backend only; the CLI backends need a logged-in `claude`/`codex` on the host).
