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

Because it runs as your user, the Claude CLI login in your keychain is available. The Codex backend is temporarily disabled; select `claude-cli` or `openrouter` for reviews and chat before upgrading.

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

`docker compose up -d` (OpenRouter backend only; Claude CLI needs a logged-in `claude` on the host).

The server requires a non-placeholder `REPOLENS_API_TOKEN`. Host installs bind to `127.0.0.1` by default. Compose publishes `127.0.0.1:3000`, while setting `REPOLENS_HOST=0.0.0.0` inside the container. Use a reverse proxy with HTTPS for remote access.

API request bodies are limited to 1 MiB and webhook deliveries to 5 MiB. Each job kind accepts at most 100 running or queued jobs; API submissions beyond that limit return HTTP 429. PR chat accepts GitHub owners, members, and collaborators only.
