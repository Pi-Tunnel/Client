# PiTunnel Client

PiTunnel client makes your local services accessible over the internet.

## Features

- **Cross-Platform**: Windows, macOS and Linux support
- **Web Tunnel**: Route HTTP/HTTPS traffic through tunnel
- **TCP Tunnel**: SSH, RDP, MySQL, PostgreSQL and other protocols
- **Custom Domain**: Use your own domain instead of auto-generated subdomain
- **WebSocket Support**: Full bidirectional WebSocket proxy (including HMR)
- **Auto Reconnect**: Automatic reconnection when internet connection drops
- **System Service**: Auto-start on system boot
- **Interactive CLI**: Easy-to-use command line interface

## Installation

```bash
# Install globally from npm
npm install -g pi-tunnel-client
```

## Quick Start

```bash
# First login to server
piclient login

# Start a tunnel
piclient start

# Check status
piclient status

# Stop tunnel
piclient stop

# Logout from server
piclient logout
```

## Commands

| Command | Description |
|---------|-------------|
| `piclient login` | Login to PiTunnel server |
| `piclient logout` | Logout from server (stops all tunnels) |
| `piclient start` | Start new tunnel (interactive) |
| `piclient start -b` | Start in background |
| `piclient stop` | Stop tunnel (interactive) |
| `piclient stop -n <name>` | Stop specific tunnel |
| `piclient stop --all` | Stop all tunnels |
| `piclient status` | Status and statistics |
| `piclient list` | List saved connections |
| `piclient delete` | Delete connection |
| `piclient config --show` | Show configuration |
| `piclient install` | Auto-start on system boot |
| `piclient uninstall` | Remove auto-start |
| `piclient update` | Update to latest version |
| `piclient update --check` | Check for updates without installing |

## Auto-Start on System Boot

```bash
# Install
piclient install

# Uninstall
piclient uninstall
```

### Platform Support

| Platform | Method | Location |
|----------|--------|----------|
| Windows | Task Scheduler | Starts on login |
| macOS | LaunchAgent | `~/Library/LaunchAgents/` |
| Linux | systemd user service | `~/.config/systemd/user/` |

## Configuration

Configuration file location:
- **Windows:** `%APPDATA%\PiTunnel\config.json`
- **macOS/Linux:** `~/.pitunnel/config.json`

```json
{
  "server": "ws://your-server:8081",
  "token": "your-auth-token",
  "domain": "tunnel.example.com"
}
```

### Configuration Options

| Parameter | Description |
|-----------|-------------|
| `server` | Server WebSocket URL |
| `token` | Authentication token |
| `domain` | Domain info received from server |

## WebSocket and HMR Support

PiTunnel fully supports WebSocket connections. Hot Module Replacement (HMR) for frameworks like React, Vite, and Next.js works automatically.

**How it works:**
1. Client starts tunnel with target `127.0.0.1:3000`
2. Server automatically starts listening on port 3000 as well
3. Browser requests `ws://tunnel-name.domain.com:3000/ws`
4. Server forwards the request to client
5. Client connects to local application

**No additional configuration required!** Everything works automatically thanks to the server's dynamic port system.

## Internet Connection Check

Client automatically waits when internet connection drops and reconnects when connection is restored:

```
❌ Disconnected from server
📡 Waiting for internet connection...
✅ Internet connection restored
🔄 Reconnecting in 3 seconds...
```

## Usage Examples

### Web Application (React, Vite, Next.js, etc.)

```bash
# React app running locally (port 3000)
npm start

# Start tunnel in another terminal
piclient start
# Type: Web (HTTP/HTTPS)
# Target: 127.0.0.1:3000

# Now accessible at http://your-tunnel.domain.com
# HMR (Hot Module Replacement) works automatically!
```

### SSH Access

```bash
piclient start
# Type: TCP
# Protocol: SSH
# Target: 127.0.0.1:22

# Connect remotely:
ssh user@your-tunnel.tcp.domain.com
```

### Database

```bash
piclient start
# Type: TCP
# Protocol: MySQL
# Target: 127.0.0.1:3306

# Connect remotely:
mysql -h your-tunnel.tcp.domain.com -u user -p
```

### API Server

```bash
# Express/Flask/Django running locally (port 8080)
piclient start
# Target: 127.0.0.1:8080
# Type: Web

# Now API accessible at http://your-tunnel.domain.com
```

### Custom Domain

You can use your own domain instead of the auto-generated subdomain:

```bash
piclient start
# Type: Web (HTTP/HTTPS)
# Target: 127.0.0.1:3000
# Domain Type: Custom domain
# Custom domain: myapp.example.com

# Now accessible at http://myapp.example.com
```

**DNS Setup:**
1. Point your domain to the tunnel server IP (A record or CNAME)
2. Wait for DNS propagation
3. Start tunnel with custom domain option

**Example DNS Configuration:**
```
myapp.example.com    A    YOUR_TUNNEL_SERVER_IP
```

You can also use the `--custom-domain` flag directly:

```bash
piclient connect -n myapp -s ws://server:8081 -t localhost:3000 --custom-domain myapp.example.com
```

### Remote Desktop (RDP)

```bash
piclient start
# Type: TCP
# Protocol: RDP
# Target: 127.0.0.1:3389

# Connect remotely (Windows):
mstsc /v:your-tunnel.tcp.domain.com
```

## Server Commands

Server can send commands to client via API:

| Command | Description |
|---------|-------------|
| `stop` | Stop the tunnel |
| `restart` | Restart the tunnel |

```bash
# Stop tunnel via server API
curl -X DELETE -H "X-Auth-Token: token" http://server:8082/tunnels/my-tunnel

# Client output:
# ⚠️  Stop command received: API request
```

## Troubleshooting

### "Connection timeout" error

1. Check your internet connection
2. Make sure server address is correct
3. Check firewall settings

### "Authentication failed" error

Check your token:
```bash
piclient config --show
```

To reset:
```bash
piclient config --token YOUR_NEW_TOKEN
```

### Tunnel connected but page won't load

1. Make sure local service is running
2. Make sure you specified the correct port
3. Check tunnel status with `piclient status`

### WebSocket connection error

PiTunnel automatically supports WebSockets. If you're having issues:

1. Make sure server opened the dynamic port (check server logs)
2. Make sure the port is open in firewall
3. Restart the server

## Platform Requirements

- **Node.js:** 18.0.0 or higher
- **Windows:** Windows 10/11
- **macOS:** macOS 10.15 (Catalina) or higher
- **Linux:** Distributions with systemd support (Ubuntu, Debian, Fedora, CentOS, etc.)

## License

MIT
