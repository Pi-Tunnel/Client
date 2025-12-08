#!/usr/bin/env node

import WebSocket from 'ws';
import net from 'net';
import http from 'http';
import https from 'https';
import { program } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir, platform, release, hostname, arch, userInfo } from 'os';
import { join } from 'path';
import { spawn, execSync } from 'child_process';
import { createInterface } from 'readline';

// Platform tespiti
const isWindows = platform() === 'win32';
const isMac = platform() === 'darwin';
const isLinux = platform() === 'linux';

// Cihaz bilgileri
function getDeviceInfo() {
  let username = 'unknown';
  try {
    username = userInfo().username;
  } catch (e) {
    // userInfo() bazı sistemlerde hata verebilir
  }

  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    nodeVersion: process.version,
    osVersion: release(),
    username: username,
    deviceType: getDeviceType(),
  };
}

// Cihaz tipini belirle
function getDeviceType() {
  const plt = platform();
  const architecture = arch();
  const host = hostname().toLowerCase();
  const osVer = release().toLowerCase();

  // Raspberry Pi kontrolü
  if (plt === 'linux') {
    try {
      // /proc/cpuinfo veya /sys/firmware/devicetree/base/model kontrol et
      if (existsSync('/sys/firmware/devicetree/base/model')) {
        const model = readFileSync('/sys/firmware/devicetree/base/model', 'utf8').toLowerCase();
        if (model.includes('raspberry')) {
          return 'Raspberry Pi';
        }
        if (model.includes('orange pi')) {
          return 'Orange Pi';
        }
        if (model.includes('banana pi')) {
          return 'Banana Pi';
        }
        if (model.includes('rock') || model.includes('radxa')) {
          return 'Rock Pi';
        }
      }
      // ARM Linux cihazı
      if (architecture === 'arm' || architecture === 'arm64') {
        if (host.includes('raspberry') || host.includes('raspberrypi') || host.includes('rpi')) {
          return 'Raspberry Pi';
        }
        return 'Linux (ARM)';
      }
      // Docker container kontrolü
      if (existsSync('/.dockerenv')) {
        return 'Docker Container';
      }
      return 'Linux';
    } catch (e) {
      if (architecture === 'arm' || architecture === 'arm64') {
        return 'Linux (ARM)';
      }
      return 'Linux';
    }
  }

  // macOS
  if (plt === 'darwin') {
    if (architecture === 'arm64') {
      return 'Mac (Apple Silicon)';
    }
    return 'Mac (Intel)';
  }

  // Windows
  if (plt === 'win32') {
    if (architecture === 'arm64') {
      return 'Windows (ARM)';
    }
    return 'Windows';
  }

  // FreeBSD, OpenBSD vb.
  if (plt === 'freebsd') return 'FreeBSD';
  if (plt === 'openbsd') return 'OpenBSD';
  if (plt === 'sunos') return 'SunOS';
  if (plt === 'aix') return 'AIX';

  return `${plt} (${architecture})`;
}


// Config dizini - platform bağımsız
const CONFIG_DIR = isWindows
  ? join(process.env.APPDATA || homedir(), 'PiTunnel')
  : join(homedir(), '.pitunnel');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const CONNECTIONS_FILE = join(CONFIG_DIR, 'connections.json');
const PID_FILE = join(CONFIG_DIR, 'pitunnel.pid');
const PID_DATA_FILE = join(CONFIG_DIR, 'pids.json');
const DEFAULT_SERVER = 'ws://165.227.130.187:8081';

// Config dizinini oluştur
if (!existsSync(CONFIG_DIR)) {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

// Renk kodları - Windows CMD desteği için kontrol
const supportsColor = (() => {
  // Force color with FORCE_COLOR env
  if (process.env.FORCE_COLOR !== undefined) {
    return process.env.FORCE_COLOR !== '0';
  }
  // Windows Terminal, VS Code terminal, ve modern terminaller destekler
  if (process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode') {
    return true;
  }
  // TTY kontrolü
  if (process.stdout.isTTY) {
    // Windows 10 build 14393+ ANSI destekler
    if (isWindows) {
      const osRelease = parseInt(release().split('.')[2]) || 0;
      return osRelease >= 14393;
    }
    return true;
  }
  return false;
})();

const colors = supportsColor ? {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bold: '\x1b[1m',
} : {
  reset: '',
  red: '',
  green: '',
  yellow: '',
  blue: '',
  cyan: '',
  white: '',
  bold: '',
};

function log(msg, color = 'white') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

// Cross-platform process kontrolü
function isProcessRunning(pid) {
  try {
    if (isWindows) {
      // Windows'ta tasklist komutu ile kontrol
      const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return result.includes(String(pid));
    } else {
      // Unix sistemlerde signal 0 ile kontrol
      process.kill(pid, 0);
      return true;
    }
  } catch (e) {
    return false;
  }
}

// Cross-platform process sonlandırma
function killProcess(pid) {
  try {
    if (isWindows) {
      // Windows'ta taskkill komutu kullan
      execSync(`taskkill /PID ${pid} /F`, { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      // Unix sistemlerde SIGTERM gönder
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch (e) {
    return false;
  }
}

// İnternet bağlantısı kontrolü
async function checkInternet() {
  const testHosts = [
    { host: '8.8.8.8', port: 53 },        // Google DNS
    { host: '1.1.1.1', port: 53 },        // Cloudflare DNS
    { host: '208.67.222.222', port: 53 }, // OpenDNS
  ];

  for (const { host, port } of testHosts) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection(port, host);
        socket.setTimeout(3000);
        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error('timeout'));
        });
        socket.on('error', reject);
      });
      return true;
    } catch (e) {
      continue;
    }
  }
  return false;
}

// İnternet bağlantısı bekle
async function waitForInternet() {
  let attempts = 0;
  while (true) {
    const hasInternet = await checkInternet();
    if (hasInternet) {
      if (attempts > 0) {
        log('✅ Internet connection restored', 'green');
      }
      return true;
    }
    attempts++;
    if (attempts === 1) {
      log('📡 Waiting for internet connection...', 'yellow');
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

// Random subdomain oluştur
function generateSubdomain() {
  const adjectives = ['swift', 'bright', 'calm', 'dark', 'easy', 'fast', 'good', 'happy', 'keen', 'light'];
  const nouns = ['cloud', 'star', 'moon', 'sun', 'wave', 'wind', 'fire', 'rock', 'tree', 'bird'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 1000);
  return `${adj}-${noun}-${num}`;
}

// Config yükle
function loadConfig() {
  if (existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

// Config kaydet
function saveConfig(config) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Bağlantıları yükle
function loadConnections() {
  if (existsSync(CONNECTIONS_FILE)) {
    try {
      return JSON.parse(readFileSync(CONNECTIONS_FILE, 'utf8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

// Bağlantıları kaydet
function saveConnections(connections) {
  writeFileSync(CONNECTIONS_FILE, JSON.stringify(connections, null, 2));
}

// Readline interface
function ask(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Sunucudan domain bilgisini al
function fetchServerInfo(serverUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(serverUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timeout'));
    }, 10000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'auth-success') {
          clearTimeout(timeout);
          ws.close();
          resolve({
            domain: msg.domain,
            wsPort: msg.wsPort,
          });
        } else if (msg.type === 'auth-failed') {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(msg.message || 'Authentication failed'));
        }
      } catch (e) {
        // ignore parse errors
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// Menü göster
function showMenu(title, options) {
  console.log('');
  log(`╔${'═'.repeat(50)}╗`, 'cyan');
  log(`║  ${title.padEnd(47)}║`, 'cyan');
  log(`╚${'═'.repeat(50)}╝`, 'cyan');
  console.log('');

  options.forEach((opt, i) => {
    log(`  [${i + 1}] ${opt.label}`, 'white');
  });
  console.log('');

  return options;
}

// Protokol portları
const protocolPorts = {
  http: 80,
  https: 443,
  ssh: 22,
  rdp: 3389,
  mysql: 3306,
  postgresql: 5432,
  ftp: 21,
  sip: 5060,
};

program
  .name('piclient')
  .description('PiTunnel Client - Secure tunnel to your local network')
  .version('1.0.0');

// Start komutu - interaktif
program
  .command('start')
  .description('Start a new tunnel connection')
  .option('-b, --background', 'Run in background')
  .action(startInteractive);

// Connect komutu - direkt bağlantı
program
  .command('connect')
  .description('Connect with specific parameters')
  .requiredOption('-n, --name <name>', 'Tunnel name')
  .requiredOption('-s, --server <url>', 'Server WebSocket URL')
  .requiredOption('-t, --target <host>', 'Target host:port')
  .option('-p, --ports <ports>', 'TCP ports to expose')
  .option('--type <type>', 'Tunnel type: web or tcp', 'web')
  .option('--protocol <protocol>', 'Protocol: http, ssh, rdp, mysql, postgresql, ftp, sip', 'http')
  .option('--token <token>', 'Auth token')
  .option('--custom-domain <domain>', 'Custom domain for the tunnel')
  .option('--background', 'Run in background')
  .action(connectDirect);

// Status komutu
program
  .command('status')
  .description('Show tunnel status and statistics')
  .action(showStatus);

// Stop komutu
program
  .command('stop')
  .description('Stop running tunnel')
  .option('-n, --name <name>', 'Tunnel name to stop')
  .option('--all', 'Stop all tunnels')
  .action(stopTunnel);

// List komutu
program
  .command('list')
  .description('List saved connections and running tunnels')
  .action(listConnections);

// Delete komutu
program
  .command('delete')
  .description('Delete a saved connection')
  .option('-n, --name <name>', 'Connection name to delete')
  .option('--all', 'Delete all saved connections')
  .action(deleteConnection);

// Config komutu
program
  .command('config')
  .description('Configure PiTunnel client')
  .option('--server <url>', 'Set default server URL')
  .option('--token <token>', 'Set auth token')
  .option('--show', 'Show current config')
  .action(configureClient);

// Login komutu
program
  .command('login')
  .description('Login to PiTunnel server')
  .action(loginToServer);

// Logout komutu
program
  .command('logout')
  .description('Logout from PiTunnel server')
  .action(logoutFromServer);

// Install komutu - sistem başlangıcında otomatik çalışma
program
  .command('install')
  .description('Install PiTunnel to run on system startup')
  .action(installService);

// Uninstall komutu
program
  .command('uninstall')
  .description('Remove PiTunnel from system startup')
  .action(uninstallService);

// Service komutu - arka plan servisi olarak çalıştır
program
  .command('service')
  .description('Run as background service (used by system startup)')
  .action(runAsService);

program.parse();

// ==================== Start Interactive ====================
async function startInteractive(options) {
  const config = loadConfig();
  const connections = loadConnections();
  const runInBackground = options?.background || false;

  // Login kontrolü - server ve token yoksa login'e yönlendir
  if (!config.server || !config.token) {
    log('\n🔐 You need to login first', 'yellow');
    log('   Run: piclient login', 'cyan');
    console.log('');
    process.exit(1);
  }

  // Kayıtlı bağlantı var mı?
  if (connections.length > 0) {
    const options = showMenu('PiTunnel - Start Tunnel', [
      { label: 'New connection', value: 'new' },
      { label: 'Saved connections', value: 'saved' },
    ]);

    const choice = await ask('Select [1-2]: ');

    if (choice === '2') {
      await selectSavedConnection(connections, config, runInBackground);
      return;
    }
  }

  // Yeni bağlantı
  await createNewConnection(config, runInBackground);
}

// ==================== Saved Connection ====================
async function selectSavedConnection(connections, config, runInBackground = false) {
  console.log('');
  log('📁 Saved Connections:', 'cyan');
  console.log('');

  connections.forEach((conn, i) => {
    const typeIcon = conn.type === 'web' ? '🌐' : '🔌';
    const domainInfo = conn.customDomain ? ` [${conn.customDomain}]` : '';
    log(`  [${i + 1}] ${typeIcon} ${conn.name} → ${conn.target} (${conn.protocol})${domainInfo}`, 'white');
  });

  console.log('');
  const choice = await ask(`Select [1-${connections.length}] or 'b' for back: `);

  if (choice.toLowerCase() === 'b') {
    await startInteractive();
    return;
  }

  const index = parseInt(choice) - 1;
  if (index >= 0 && index < connections.length) {
    const conn = connections[index];

    // Arka planda çalışsın mı?
    let background = runInBackground;
    if (!runInBackground) {
      const bgChoice = await ask('Run in background? (Y/n): ');
      background = bgChoice.toLowerCase() !== 'n';
    }

    log(`\n🚀 Starting tunnel: ${conn.name}`, 'green');
    if (conn.customDomain) {
      log(`🌐 Custom domain: ${conn.customDomain}`, 'cyan');
    }

    await startTunnel({
      name: conn.name,
      server: config.server,
      target: conn.target,
      type: conn.type,
      protocol: conn.protocol,
      ports: conn.ports,
      token: config.token,
      background: background,
      customDomain: conn.customDomain || null,
    });
  } else {
    log('❌ Invalid selection', 'red');
  }
}

// ==================== Create New Connection ====================
async function createNewConnection(config, runInBackground = false) {
  // Tunnel tipi seç
  const typeOptions = showMenu('Select Tunnel Type', [
    { label: 'Web (HTTP/HTTPS)', value: 'web' },
    { label: 'TCP (SSH, RDP, Database, etc.)', value: 'tcp' },
  ]);

  const typeChoice = await ask('Select [1-2]: ');
  const tunnelType = typeChoice === '2' ? 'tcp' : 'web';

  let protocol = 'http';
  let defaultPort = 80;

  if (tunnelType === 'tcp') {
    // Protokol seç
    const protoOptions = showMenu('Select Protocol', [
      { label: 'SSH (port 22)', value: 'ssh' },
      { label: 'RDP (port 3389)', value: 'rdp' },
      { label: 'MySQL (port 3306)', value: 'mysql' },
      { label: 'PostgreSQL (port 5432)', value: 'postgresql' },
      { label: 'FTP (port 21)', value: 'ftp' },
      { label: 'SIP (port 5060)', value: 'sip' },
      { label: 'Custom port', value: 'custom' },
    ]);

    const protoChoice = await ask('Select [1-7]: ');
    const protocols = ['ssh', 'rdp', 'mysql', 'postgresql', 'ftp', 'sip', 'custom'];
    protocol = protocols[parseInt(protoChoice) - 1] || 'ssh';
    defaultPort = protocolPorts[protocol] || 22;
  }

  // Local adres
  console.log('');
  const targetInput = await ask(`Local address (default: 127.0.0.1:${defaultPort}): `);
  const target = targetInput || `127.0.0.1:${defaultPort}`;

  // Domain seçimi
  showMenu('Select Domain Type', [
    { label: 'Auto-generate', value: 'Random subdomain (e.g., swift-cloud-234)' },
    { label: 'Custom domain', value: 'Use your own domain/subdomain' },
  ]);

  const domainChoice = await ask('Select [1-2] (default: 1): ');
  const isCustomDomain = domainChoice === '2';

  let name;
  let customDomain = null;

  if (isCustomDomain) {
    console.log('');
    log('📝 Enter your custom domain (e.g., myapp.example.com)', 'cyan');
    log('   Note: Make sure DNS is pointing to the tunnel server', 'white');
    const customInput = await ask('Custom domain: ');
    if (!customInput || !customInput.includes('.')) {
      log('⚠️  Invalid domain format, using auto-generated subdomain', 'yellow');
      name = generateSubdomain();
    } else {
      customDomain = customInput.trim().toLowerCase();
      name = customDomain.split('.')[0]; // İlk kısım tunnel adı olarak
      log(`✓ Using custom domain: ${customDomain}`, 'green');
    }
  } else {
    const suggestedName = generateSubdomain();
    const nameInput = await ask(`Tunnel name (default: ${suggestedName}): `);
    name = nameInput || suggestedName;
  }

  // TCP portları
  let ports = [];
  if (tunnelType === 'tcp') {
    const portsInput = await ask(`Expose ports (comma-separated, default: ${defaultPort}): `);
    ports = portsInput ? portsInput.split(',').map(p => parseInt(p.trim())) : [defaultPort];
  }

  // Kaydet
  const saveChoice = await ask('Save this connection? (Y/n): ');
  if (saveChoice.toLowerCase() !== 'n') {
    const connections = loadConnections();
    connections.push({
      name,
      target,
      type: tunnelType,
      protocol,
      ports,
      customDomain,
      createdAt: new Date().toISOString(),
    });
    saveConnections(connections);
    log('✓ Connection saved', 'green');
  }

  // Arka planda çalışsın mı?
  let background = runInBackground;
  if (!runInBackground) {
    const bgChoice = await ask('Run in background? (Y/n): ');
    background = bgChoice.toLowerCase() !== 'n';
  }

  // Başlat
  log(`\n🚀 Starting tunnel: ${name}`, 'green');

  await startTunnel({
    name,
    server: config.server,
    target,
    type: tunnelType,
    protocol,
    ports,
    token: config.token,
    background,
    customDomain,
  });
}

// ==================== Start Tunnel ====================
async function startTunnel(options) {
  const { name, server, target, type, protocol, ports, token, background, customDomain } = options;

  // Background modunda çalıştır
  if (background) {
    return startInBackground(options);
  }

  // Parse target
  let targetHost = target;
  let targetPort = protocolPorts[protocol] || 80;
  if (target.includes(':')) {
    const parts = target.split(':');
    targetHost = parts[0];
    targetPort = parseInt(parts[1]);
  }

  // İstatistikler
  const stats = {
    requests: 0,
    bytesUp: 0,
    bytesDown: 0,
    startTime: Date.now(),
  };

  console.log('');
  log('╔═══════════════════════════════════════════════════════════╗', 'cyan');
  log('║                    🚀 PiTunnel Client                     ║', 'cyan');
  log('╠═══════════════════════════════════════════════════════════╣', 'cyan');
  log(`║  Tunnel:   ${name.padEnd(44)}║`, 'cyan');
  log(`║  Type:     ${type.padEnd(44)}║`, 'cyan');
  log(`║  Protocol: ${protocol.padEnd(44)}║`, 'cyan');
  log(`║  Target:   ${(targetHost + ':' + targetPort).padEnd(44)}║`, 'cyan');
  log('╚═══════════════════════════════════════════════════════════╝', 'cyan');
  console.log('');

  const ws = new WebSocket(server);
  const connections = new Map();

  ws.on('open', () => {
    log('🔗 Connected to server', 'green');

    // Token gönder
    if (token) {
      ws.send(JSON.stringify({ type: 'auth', token }));
    } else {
      // Auth gerekmiyorsa direkt register
      registerTunnel();
    }
  });

  function registerTunnel() {
    ws.send(JSON.stringify({
      type: 'register',
      name,
      target: targetHost,
      targetPort,
      tunnelType: type,
      protocol,
      customDomain,
      deviceInfo: getDeviceInfo(),
    }));

    // TCP portlarını aç
    if (ports && ports.length > 0) {
      ports.forEach(port => {
        ws.send(JSON.stringify({ type: 'tcp-listen', port }));
      });
    }
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'auth-success':
          log('🔑 Authentication successful', 'green');
          // Sunucudan gelen domain bilgisini kaydet
          if (msg.domain) {
            const currentConfig = loadConfig();
            currentConfig.domain = msg.domain;
            saveConfig(currentConfig);
            log(`📍 Domain: ${msg.domain}`, 'cyan');
          }
          registerTunnel();
          break;

        case 'auth-failed':
          log(`❌ Authentication failed: ${msg.message}`, 'red');
          process.exit(1);
          break;

        case 'registered':
          log('✅ Tunnel registered successfully', 'green');
          console.log('');

          if (msg.tunnelType === 'web') {
            log('🌐 Access URL:', 'cyan');
            log(`   ${msg.accessUrl}`, 'white');
          } else {
            log('🔌 Connection info:', 'cyan');
            log(`   Host: ${msg.accessUrl}`, 'white');
            if (protocol === 'ssh') {
              log(`   SSH:  ssh user@${msg.accessUrl}`, 'white');
            } else if (protocol === 'rdp') {
              log(`   RDP:  mstsc /v:${msg.accessUrl}`, 'white');
            } else if (protocol === 'mysql') {
              log(`   MySQL: mysql -h ${msg.accessUrl} -u user -p`, 'white');
            } else if (protocol === 'postgresql') {
              log(`   PostgreSQL: psql -h ${msg.accessUrl} -U user`, 'white');
            }
          }
          console.log('');
          log('📊 Press Ctrl+C to stop. Use "piclient status" for statistics.', 'yellow');
          console.log('');
          break;

        case 'tcp-listening':
          if (msg.status === 'ok') {
            log(`🔌 Port ${msg.port} is active`, 'green');
          } else {
            log(`⚠️  Port ${msg.port}: ${msg.status}`, 'yellow');
          }
          break;

        case 'tcp-connect':
          handleTcpConnect(ws, msg, connections, targetHost, targetPort, stats);
          break;

        case 'http-request':
          handleHttpRequest(ws, msg, targetHost, targetPort, stats);
          break;

        case 'http-upgrade':
          handleHttpUpgrade(ws, msg, connections, targetHost, targetPort);
          break;

        case 'data':
          handleData(msg, connections, stats);
          break;

        case 'end':
          handleEnd(msg, connections);
          break;

        case 'error':
          log(`❌ Server error: ${msg.message}`, 'red');
          break;

        case 'command':
          handleServerCommand(msg, ws, options);
          break;
      }
    } catch (err) {
      console.error('Message parse error:', err);
    }
  });

  // Server komutlarını işle
  function handleServerCommand(msg, ws, options) {
    switch (msg.action) {
      case 'stop':
        log(`⚠️  Stop command received: ${msg.reason || 'No reason'}`, 'yellow');
        ws.close();
        process.exit(0);
        break;

      case 'restart':
        log(`🔄 Restart command received: ${msg.reason || 'No reason'}`, 'yellow');
        ws.close();
        setTimeout(() => startTunnel(options), 1000);
        break;

      default:
        log(`Unknown command: ${msg.action}`, 'yellow');
    }
  }

  ws.on('close', async () => {
    log('❌ Disconnected from server', 'red');
    connections.forEach(conn => conn.destroy());
    connections.clear();

    // İnternet bağlantısını kontrol et
    const hasInternet = await checkInternet();
    if (!hasInternet) {
      await waitForInternet();
    }

    log('🔄 Reconnecting in 3 seconds...', 'yellow');
    setTimeout(() => startTunnel(options), 3000);
  });

  ws.on('error', async (err) => {
    log(`❌ Connection error: ${err.message}`, 'red');

    // ENOTFOUND, ENETUNREACH gibi network hatalarında internet kontrolü yap
    if (err.code === 'ENOTFOUND' || err.code === 'ENETUNREACH' || err.code === 'ECONNREFUSED') {
      const hasInternet = await checkInternet();
      if (!hasInternet) {
        log('📡 No internet connection detected', 'yellow');
      }
    }
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('');
    log('👋 Shutting down...', 'yellow');
    ws.close();
    process.exit(0);
  });
}

// ==================== Connect Direct ====================
async function connectDirect(options) {
  const config = loadConfig();

  const token = options.token || config.token;
  const server = options.server || config.server || DEFAULT_SERVER;

  // Parse target
  let targetHost = options.target;
  let targetPort = 80;
  if (options.target.includes(':')) {
    const parts = options.target.split(':');
    targetHost = parts[0];
    targetPort = parseInt(parts[1]);
  }

  const ports = options.ports ? options.ports.split(',').map(p => parseInt(p.trim())) : [];

  await startTunnel({
    name: options.name,
    server: server,
    target: options.target,
    type: options.type,
    protocol: options.protocol,
    ports: ports,
    token: token,
    background: options.background,
    customDomain: options.customDomain || null,
  });
}

// ==================== Status ====================
async function showStatus() {
  const config = loadConfig();
  const connections = loadConnections();
  const pidData = loadPidData();
  const runningNames = Object.keys(pidData);

  console.log('');
  log('╔═══════════════════════════════════════════════════════════╗', 'cyan');
  log('║                   📊 PiTunnel Status                      ║', 'cyan');
  log('╚═══════════════════════════════════════════════════════════╝', 'cyan');
  console.log('');

  // Config bilgileri
  log('⚙️  Configuration:', 'yellow');
  log(`   Server: ${config.server || 'Not configured'}`, 'white');
  log(`   Token:  ${config.token ? '***' + config.token.slice(-4) : 'Not set'}`, 'white');
  console.log('');

  // Çalışan tunnel'lar ve istatistikler
  log('🟢 Running Tunnels:', 'green');
  if (runningNames.length === 0) {
    log('   No running tunnels', 'white');
  } else {
    for (const name of runningNames) {
      const info = pidData[name];
      const uptime = formatUptime(new Date(info.startedAt));

      // Process hala çalışıyor mu kontrol et
      const isAlive = isProcessRunning(info.pid);

      if (isAlive) {
        log(`   • ${name}`, 'green');
        log(`     PID: ${info.pid}`, 'white');
        log(`     Target: ${info.target}`, 'white');
        log(`     Type: ${info.type}/${info.protocol}`, 'white');
        if (info.customDomain) {
          log(`     URL: http://${info.customDomain}`, 'cyan');
        } else if (config.domain) {
          const url = info.type === 'web'
            ? `http://${name}.${config.domain}`
            : `${name}.tcp.${config.domain}`;
          log(`     URL: ${url}`, 'cyan');
        }
        log(`     Uptime: ${uptime}`, 'white');
        log(`     Started: ${new Date(info.startedAt).toLocaleString()}`, 'white');
      } else {
        log(`   • ${name} (dead)`, 'red');
        // Ölü process'i temizle
        delete pidData[name];
        savePidData(pidData);
      }
    }
  }
  console.log('');

  // Kayıtlı bağlantılar özet
  log('📁 Saved Connections:', 'yellow');
  log(`   Total: ${connections.length}`, 'white');
  log(`   Active: ${runningNames.filter(n => connections.some(c => c.name === n)).length}`, 'white');
  console.log('');

  // Sunucu durumu (eğer yapılandırılmışsa)
  let serverTunnels = [];
  if (config.server) {
    log('🌐 Server Status:', 'yellow');
    try {
      const apiUrl = config.server.replace('ws://', 'http://').replace('wss://', 'https://').replace(':8081', ':8082');

      const response = await fetch(`${apiUrl}/tunnels`, {
        headers: {
          'X-Auth-Token': config.token || '',
        }
      });

      if (response.status === 401) {
        log(`   Status: Unauthorized (invalid token)`, 'red');
      } else {
        const data = await response.json();
        serverTunnels = data.tunnels || [];

        log(`   Status: Online`, 'green');
        log(`   Active tunnels on server: ${data.count}`, 'white');
        if (serverTunnels.length > 0) {
          serverTunnels.forEach(t => {
            const isOurs = runningNames.includes(t.name);
            log(`     ${isOurs ? '🟢' : '⚪'} ${t.name} → ${t.target}`, isOurs ? 'green' : 'white');
          });
        }
      }
    } catch (e) {
      log(`   Status: Offline or unreachable`, 'red');
    }
  }

  // Bandwidth istatistikleri
  console.log('');
  log('📈 Bandwidth Stats:', 'yellow');

  let totalRequests = 0;
  let totalBytesIn = 0;
  let totalBytesOut = 0;

  if (serverTunnels.length > 0) {
    for (const t of serverTunnels) {
      if (runningNames.includes(t.name) && t.stats) {
        totalRequests += t.stats.requests || 0;
        totalBytesIn += t.stats.bytesIn || 0;
        totalBytesOut += t.stats.bytesOut || 0;

        log(`   ${t.name}:`, 'cyan');
        log(`     Requests: ${t.stats.requests || 0}`, 'white');
        log(`     In:  ${formatBytes(t.stats.bytesIn || 0)}`, 'white');
        log(`     Out: ${formatBytes(t.stats.bytesOut || 0)}`, 'white');
      }
    }
  }

  console.log('');
  log('📊 Total:', 'yellow');
  log(`   Tunnels: ${runningNames.length}`, 'white');
  log(`   Requests: ${totalRequests}`, 'white');
  log(`   In:  ${formatBytes(totalBytesIn)}  (requests received)`, 'white');
  log(`   Out: ${formatBytes(totalBytesOut)}  (responses sent)`, 'white');
  console.log('');
}

// ==================== Start In Background ====================
function startInBackground(options) {
  const { name, server, target, type, protocol, ports, token, customDomain } = options;

  // Argümanları hazırla
  const args = [
    process.argv[1],
    'connect',
    '-n', name,
    '-s', server,
    '-t', target,
    '--type', type,
    '--protocol', protocol,
  ];

  if (token) {
    args.push('--token', token);
  }

  if (ports && ports.length > 0) {
    args.push('-p', ports.join(','));
  }

  if (customDomain) {
    args.push('--custom-domain', customDomain);
  }

  // Platform-spesifik spawn ayarları
  const spawnOptions = {
    stdio: 'ignore',
    env: process.env,
  };

  if (isWindows) {
    // Windows'ta detached ve windowsHide kullan
    spawnOptions.detached = true;
    spawnOptions.windowsHide = true;
    // Windows'ta shell üzerinden başlat
    spawnOptions.shell = false;
  } else {
    // Unix sistemlerde detached kullan
    spawnOptions.detached = true;
  }

  // Detached child process başlat
  const child = spawn(process.execPath, args, spawnOptions);

  // PID'i kaydet
  const pidData = loadPidData();
  pidData[name] = {
    pid: child.pid,
    target,
    type,
    protocol,
    customDomain: customDomain || null,
    startedAt: new Date().toISOString(),
  };
  savePidData(pidData);

  child.unref();

  // Config'den domain bilgisini al
  const config = loadConfig();
  const domain = config.domain;

  log(`\n✅ Tunnel "${name}" started in background (PID: ${child.pid})`, 'green');
  log(`   Target: ${target}`, 'white');

  // Custom domain varsa onu göster, yoksa standart subdomain
  if (customDomain) {
    log(`   URL: http://${customDomain}`, 'cyan');
  } else if (domain) {
    if (type === 'web') {
      log(`   URL: http://${name}.${domain}`, 'cyan');
    } else {
      log(`   Host: ${name}.tcp.${domain}`, 'cyan');
    }
  }

  log(`   Use "piclient stop -n ${name}" to stop`, 'yellow');
  console.log('');
}

// PID dosyası işlemleri
function loadPidData() {
  if (existsSync(PID_DATA_FILE)) {
    try {
      return JSON.parse(readFileSync(PID_DATA_FILE, 'utf8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function savePidData(data) {
  writeFileSync(PID_DATA_FILE, JSON.stringify(data, null, 2));
}

// ==================== Stop Tunnel ====================
async function stopTunnel(options) {
  const pidData = loadPidData();

  if (options.all) {
    // Tüm tunnel'ları durdur
    const names = Object.keys(pidData);
    if (names.length === 0) {
      log('No running tunnels found', 'yellow');
      return;
    }

    names.forEach(name => {
      if (killProcess(pidData[name].pid)) {
        log(`✅ Stopped tunnel: ${name} (PID: ${pidData[name].pid})`, 'green');
      } else {
        log(`⚠️  Could not stop ${name}`, 'yellow');
      }
    });

    savePidData({});
    return;
  }

  if (options.name) {
    const tunnelInfo = pidData[options.name];
    if (!tunnelInfo) {
      log(`❌ Tunnel "${options.name}" not found`, 'red');
      return;
    }

    if (killProcess(tunnelInfo.pid)) {
      log(`✅ Stopped tunnel: ${options.name} (PID: ${tunnelInfo.pid})`, 'green');
    } else {
      log(`⚠️  Could not stop ${options.name}`, 'yellow');
    }
    delete pidData[options.name];
    savePidData(pidData);
    return;
  }

  // Çalışan tunnel'ları listele ve interaktif seçim
  const names = Object.keys(pidData);
  if (names.length === 0) {
    log('No running tunnels found', 'yellow');
    return;
  }

  console.log('');
  log('🟢 Running Tunnels:', 'cyan');
  names.forEach((name, i) => {
    const info = pidData[name];
    const uptime = formatUptime(new Date(info.startedAt));
    log(`  [${i + 1}] ${name} (PID: ${info.pid}) → ${info.target} | ${uptime}`, 'white');
  });
  log(`  [${names.length + 1}] Stop all tunnels`, 'red');
  console.log('');

  const choice = await ask(`Select tunnel to stop [1-${names.length + 1}] or 'q' to quit: `);

  if (choice.toLowerCase() === 'q') {
    return;
  }

  const index = parseInt(choice) - 1;

  // Stop all seçildiyse
  if (index === names.length) {
    names.forEach(name => {
      if (killProcess(pidData[name].pid)) {
        log(`✅ Stopped: ${name}`, 'green');
      } else {
        log(`⚠️  Could not stop ${name}`, 'yellow');
      }
    });
    savePidData({});
    return;
  }

  // Tek tunnel seçildiyse
  if (index >= 0 && index < names.length) {
    const name = names[index];
    if (killProcess(pidData[name].pid)) {
      log(`✅ Stopped: ${name} (PID: ${pidData[name].pid})`, 'green');
    } else {
      log(`⚠️  Could not stop ${name}`, 'yellow');
    }
    delete pidData[name];
    savePidData(pidData);
  } else {
    log('❌ Invalid selection', 'red');
  }
}

// ==================== List Connections ====================
async function listConnections() {
  const connections = loadConnections();
  const pidData = loadPidData();
  const runningNames = Object.keys(pidData);

  console.log('');
  log('╔═══════════════════════════════════════════════════════════╗', 'cyan');
  log('║                   📋 PiTunnel List                        ║', 'cyan');
  log('╚═══════════════════════════════════════════════════════════╝', 'cyan');

  // Çalışan tunnel'lar
  console.log('');
  log('🟢 Running Tunnels:', 'green');
  if (runningNames.length === 0) {
    log('   No running tunnels', 'white');
  } else {
    runningNames.forEach(name => {
      const info = pidData[name];
      const uptime = formatUptime(new Date(info.startedAt));
      log(`   • ${name}`, 'green');
      log(`     PID: ${info.pid} | Target: ${info.target} | Uptime: ${uptime}`, 'white');
    });
  }

  // Kayıtlı bağlantılar
  console.log('');
  log('📁 Saved Connections:', 'cyan');
  if (connections.length === 0) {
    log('   No saved connections', 'white');
    log('   Run "piclient start" to create one', 'white');
  } else {
    connections.forEach((conn, i) => {
      const typeIcon = conn.type === 'web' ? '🌐' : '🔌';
      const isRunning = runningNames.includes(conn.name);
      const statusIcon = isRunning ? '🟢' : '⚪';
      log(`   [${i + 1}] ${statusIcon} ${typeIcon} ${conn.name}`, isRunning ? 'green' : 'white');
      log(`       Target: ${conn.target} | Type: ${conn.type}/${conn.protocol}`, 'white');
      if (conn.ports && conn.ports.length > 0) {
        log(`       Ports: ${conn.ports.join(', ')}`, 'white');
      }
    });
  }

  console.log('');
  log('Commands:', 'yellow');
  log('  piclient start              Start a new tunnel', 'white');
  log('  piclient stop -n <name>     Stop a running tunnel', 'white');
  log('  piclient delete -n <name>   Delete a saved connection', 'white');
  console.log('');
}

// Uptime formatla
function formatUptime(startDate) {
  const now = new Date();
  const diff = Math.floor((now - startDate) / 1000);

  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d ${Math.floor((diff % 86400) / 3600)}h`;
}

// Byte formatla
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ==================== Delete Connection ====================
async function deleteConnection(options) {
  const connections = loadConnections();
  const pidData = loadPidData();

  if (options.all) {
    // Tüm aktif tunnel'ları durdur
    const runningNames = Object.keys(pidData);
    for (const name of runningNames) {
      if (killProcess(pidData[name].pid)) {
        log(`✅ Stopped tunnel: ${name}`, 'green');
      }
    }
    savePidData({});
    saveConnections([]);
    log('✅ All saved connections deleted', 'green');
    return;
  }

  if (options.name) {
    const index = connections.findIndex(c => c.name === options.name);
    if (index === -1) {
      log(`❌ Connection "${options.name}" not found`, 'red');
      return;
    }

    // Eğer aktifse önce durdur
    if (pidData[options.name]) {
      if (killProcess(pidData[options.name].pid)) {
        log(`✅ Stopped active tunnel: ${options.name}`, 'green');
      }
      delete pidData[options.name];
      savePidData(pidData);
    }

    connections.splice(index, 1);
    saveConnections(connections);
    log(`✅ Deleted connection: ${options.name}`, 'green');
    return;
  }

  // İnteraktif silme
  if (connections.length === 0) {
    log('No saved connections to delete', 'yellow');
    return;
  }

  console.log('');
  log('📁 Saved Connections:', 'cyan');
  connections.forEach((conn, i) => {
    const isRunning = pidData[conn.name] ? '🟢' : '⚪';
    log(`  [${i + 1}] ${isRunning} ${conn.name} → ${conn.target}`, 'white');
  });
  console.log('');

  const choice = await ask(`Select connection to delete [1-${connections.length}] or 'q' to quit: `);

  if (choice.toLowerCase() === 'q') {
    return;
  }

  const index = parseInt(choice) - 1;
  if (index >= 0 && index < connections.length) {
    const conn = connections[index];

    // Eğer aktifse önce durdur
    if (pidData[conn.name]) {
      if (killProcess(pidData[conn.name].pid)) {
        log(`✅ Stopped active tunnel: ${conn.name}`, 'green');
      }
      delete pidData[conn.name];
      savePidData(pidData);
    }

    connections.splice(index, 1);
    saveConnections(connections);
    log(`✅ Deleted connection: ${conn.name}`, 'green');
  } else {
    log('❌ Invalid selection', 'red');
  }
}

// ==================== Login to Server ====================
async function loginToServer() {
  console.log('');
  log('╔═══════════════════════════════════════════════════════════╗', 'cyan');
  log('║                   🔐 PiTunnel Login                       ║', 'cyan');
  log('╚═══════════════════════════════════════════════════════════╝', 'cyan');
  console.log('');

  // Sunucu adresi iste
  log('Enter server address (IP or domain)', 'yellow');
  log('Examples: 165.227.130.187 or tunnel.example.com', 'white');
  console.log('');
  const serverInput = await ask('Server: ');

  if (!serverInput) {
    log('❌ Server address is required', 'red');
    process.exit(1);
  }

  // ws:// formatına çevir
  let serverUrl = serverInput.trim();
  if (!serverUrl.startsWith('ws://') && !serverUrl.startsWith('wss://')) {
    // Port belirtilmemişse 8081 ekle
    if (!serverUrl.includes(':')) {
      serverUrl = `ws://${serverUrl}:8081`;
    } else {
      serverUrl = `ws://${serverUrl}`;
    }
  }

  console.log('');

  // Token iste
  log('Enter your authentication token', 'yellow');
  const token = await ask('Token: ');

  if (!token) {
    log('❌ Token is required', 'red');
    process.exit(1);
  }

  // Bağlantıyı test et
  console.log('');
  log('🔄 Connecting to server...', 'yellow');

  try {
    const serverInfo = await fetchServerInfo(serverUrl, token);

    // Config'e kaydet
    const config = loadConfig();
    config.server = serverUrl;
    config.token = token;
    if (serverInfo.domain) {
      config.domain = serverInfo.domain;
    }
    saveConfig(config);

    console.log('');
    log('╔═══════════════════════════════════════════════════════════╗', 'green');
    log('║                   ✅ Login Successful!                    ║', 'green');
    log('╚═══════════════════════════════════════════════════════════╝', 'green');
    console.log('');
    log(`   Server: ${serverUrl}`, 'white');
    if (serverInfo.domain) {
      log(`   Domain: ${serverInfo.domain}`, 'white');
    }
    log(`   Token:  ***${token.slice(-4)}`, 'white');
    console.log('');
    log('You can now start a tunnel with:', 'cyan');
    log('   piclient start', 'white');
    console.log('');

  } catch (err) {
    console.log('');
    log('╔═══════════════════════════════════════════════════════════╗', 'red');
    log('║                   ❌ Login Failed                         ║', 'red');
    log('╚═══════════════════════════════════════════════════════════╝', 'red');
    console.log('');
    log(`   Error: ${err.message}`, 'red');
    console.log('');
    log('Please check:', 'yellow');
    log('   1. Server address is correct', 'white');
    log('   2. Token is valid', 'white');
    log('   3. Server is running', 'white');
    console.log('');
    process.exit(1);
  }
}

// ==================== Logout from Server ====================
async function logoutFromServer() {
  const config = loadConfig();
  const pidData = loadPidData();
  const runningTunnels = Object.keys(pidData);

  console.log('');

  // Check if logged in
  if (!config.server && !config.token) {
    log('⚠️  You are not logged in', 'yellow');
    console.log('');
    return;
  }

  // Stop all running tunnels first
  if (runningTunnels.length > 0) {
    log('🛑 Stopping all running tunnels...', 'yellow');
    for (const name of runningTunnels) {
      if (killProcess(pidData[name].pid)) {
        log(`   ✅ Stopped: ${name}`, 'green');
      } else {
        log(`   ⚠️  Could not stop: ${name}`, 'yellow');
      }
    }
    savePidData({});
    console.log('');
  }

  // Clear credentials from config
  delete config.server;
  delete config.token;
  delete config.domain;
  saveConfig(config);

  log('╔═══════════════════════════════════════════════════════════╗', 'green');
  log('║                   ✅ Logged Out Successfully              ║', 'green');
  log('╚═══════════════════════════════════════════════════════════╝', 'green');
  console.log('');
  log('Your credentials have been removed.', 'white');
  log('To login again, run: piclient login', 'cyan');
  console.log('');
}

// ==================== Configure Client ====================
async function configureClient(options) {
  const config = loadConfig();

  if (options.show) {
    console.log('');
    log('Current Configuration:', 'cyan');
    log(`  Server: ${config.server || 'Not set'}`, 'white');
    log(`  Token:  ${config.token ? '***' + config.token.slice(-4) : 'Not set'}`, 'white');
    console.log('');
    return;
  }

  if (options.server) {
    config.server = options.server;
    saveConfig(config);
    log('✓ Server URL saved', 'green');
  }

  if (options.token) {
    config.token = options.token;
    saveConfig(config);
    log('✓ Token saved', 'green');
  }

  if (!options.server && !options.token) {
    log('Usage:', 'yellow');
    log('  piclient config --server ws://165.227.130.187:8081', 'white');
    log('  piclient config --token YOUR_TOKEN', 'white');
    log('  piclient config --show', 'white');
  }
}

// ==================== TCP/HTTP Handlers ====================
function handleTcpConnect(ws, msg, connections, targetHost, targetPort, stats) {
  const { requestId, port } = msg;

  const connectPort = port || targetPort;
  const socket = net.connect(connectPort, targetHost, () => {
    stats.requests++;
  });

  connections.set(requestId, socket);

  socket.on('data', (data) => {
    stats.bytesDown += data.length;
    ws.send(JSON.stringify({
      type: 'data',
      requestId,
      data: data.toString('base64'),
    }));
  });

  socket.on('end', () => {
    ws.send(JSON.stringify({ type: 'end', requestId }));
    connections.delete(requestId);
  });

  socket.on('error', (err) => {
    ws.send(JSON.stringify({ type: 'error', requestId, message: err.message }));
    connections.delete(requestId);
  });
}

function handleHttpRequest(ws, msg, targetHost, targetPort, stats) {
  const { requestId, method, url, headers, body } = msg;

  stats.requests++;

  const options = {
    hostname: targetHost,
    port: targetPort,
    path: url,
    method,
    headers: {
      ...headers,
      host: `${targetHost}:${targetPort}`,
    },
  };

  const client = targetPort === 443 ? https : http;

  const req = client.request(options, (res) => {
    let responseHeader = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}\r\n`;
    Object.entries(res.headers).forEach(([key, value]) => {
      responseHeader += `${key}: ${value}\r\n`;
    });
    responseHeader += '\r\n';

    const headerData = Buffer.from(responseHeader);
    stats.bytesDown += headerData.length;

    ws.send(JSON.stringify({
      type: 'data',
      requestId,
      data: headerData.toString('base64'),
    }));

    res.on('data', (chunk) => {
      stats.bytesDown += chunk.length;
      ws.send(JSON.stringify({
        type: 'data',
        requestId,
        data: chunk.toString('base64'),
      }));
    });

    res.on('end', () => {
      ws.send(JSON.stringify({ type: 'end', requestId }));
    });
  });

  req.on('error', (err) => {
    ws.send(JSON.stringify({ type: 'error', requestId, message: err.message }));
  });

  if (body) {
    const bodyData = Buffer.from(body, 'base64');
    stats.bytesUp += bodyData.length;
    req.write(bodyData);
  }
  req.end();
}

function handleHttpUpgrade(ws, msg, connections, targetHost, targetPort) {
  const { requestId, method, url, headers } = msg;

  const socket = net.connect(targetPort, targetHost, () => {
    let request = `${method} ${url} HTTP/1.1\r\n`;
    Object.entries(headers).forEach(([key, value]) => {
      if (key.toLowerCase() !== 'host') {
        request += `${key}: ${value}\r\n`;
      }
    });
    request += `Host: ${targetHost}:${targetPort}\r\n\r\n`;
    socket.write(request);
  });

  connections.set(requestId, socket);

  socket.on('data', (data) => {
    ws.send(JSON.stringify({
      type: 'data',
      requestId,
      data: data.toString('base64'),
    }));
  });

  socket.on('end', () => {
    ws.send(JSON.stringify({ type: 'end', requestId }));
    connections.delete(requestId);
  });

  socket.on('error', (err) => {
    ws.send(JSON.stringify({ type: 'error', requestId, message: err.message }));
    connections.delete(requestId);
  });
}

function handleData(msg, connections, stats) {
  const { requestId, data } = msg;
  const socket = connections.get(requestId);

  if (socket) {
    const buffer = Buffer.from(data, 'base64');
    stats.bytesUp += buffer.length;
    socket.write(buffer);
  }
}

function handleEnd(msg, connections) {
  const { requestId } = msg;
  const socket = connections.get(requestId);

  if (socket) {
    socket.end();
    connections.delete(requestId);
  }
}

// ==================== Install/Uninstall Service ====================
async function installService() {
  const connections = loadConnections();

  if (connections.length === 0) {
    log('❌ No saved connections found. Create a connection first with "piclient start"', 'red');
    return;
  }

  console.log('');
  log('📦 Installing PiTunnel as system service...', 'cyan');

  const scriptPath = process.argv[1];
  const nodePath = process.execPath;

  if (isWindows) {
    await installWindows(nodePath, scriptPath);
  } else if (isMac) {
    await installMac(nodePath, scriptPath);
  } else if (isLinux) {
    await installLinux(nodePath, scriptPath);
  } else {
    log('❌ Unsupported platform', 'red');
  }
}

async function uninstallService() {
  console.log('');
  log('🗑️  Removing PiTunnel from system startup...', 'cyan');

  if (isWindows) {
    await uninstallWindows();
  } else if (isMac) {
    await uninstallMac();
  } else if (isLinux) {
    await uninstallLinux();
  } else {
    log('❌ Unsupported platform', 'red');
  }
}

// ==================== Windows Install ====================
async function installWindows(nodePath, scriptPath) {
  const taskName = 'PiTunnel';
  const command = `"${nodePath}" "${scriptPath}" service`;

  try {
    // Mevcut task'ı sil
    execSync(`schtasks /delete /tn "${taskName}" /f 2>nul`, { stdio: 'pipe' });
  } catch (e) {
    // Task yoksa hata verir, sorun değil
  }

  try {
    // Yeni task oluştur - kullanıcı oturum açtığında çalışsın
    execSync(`schtasks /create /tn "${taskName}" /tr "${command}" /sc onlogon /rl highest /f`, {
      stdio: 'pipe'
    });

    log('✅ PiTunnel installed successfully!', 'green');
    log('   Service will start automatically when you log in.', 'white');
    log('   To start now: piclient service', 'white');
    log('   To remove: piclient uninstall', 'yellow');
  } catch (e) {
    log(`❌ Installation failed: ${e.message}`, 'red');
    log('   Try running as Administrator', 'yellow');
  }
}

async function uninstallWindows() {
  const taskName = 'PiTunnel';

  try {
    execSync(`schtasks /delete /tn "${taskName}" /f`, { stdio: 'pipe' });
    log('✅ PiTunnel removed from system startup', 'green');
  } catch (e) {
    log('⚠️  PiTunnel was not installed or already removed', 'yellow');
  }
}

// ==================== macOS Install ====================
async function installMac(nodePath, scriptPath) {
  const plistPath = join(homedir(), 'Library/LaunchAgents/com.piclient.plist');
  const logPath = join(CONFIG_DIR, 'service.log');

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.piclient</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${scriptPath}</string>
        <string>service</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logPath}</string>
    <key>StandardErrorPath</key>
    <string>${logPath}</string>
</dict>
</plist>`;

  try {
    // LaunchAgents dizini yoksa oluştur
    const launchAgentsDir = join(homedir(), 'Library/LaunchAgents');
    if (!existsSync(launchAgentsDir)) {
      mkdirSync(launchAgentsDir, { recursive: true });
    }

    // Mevcut servisi durdur
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'pipe' });
    } catch (e) {}

    // Plist dosyasını yaz
    writeFileSync(plistPath, plistContent);

    // Servisi yükle ve başlat
    execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });

    log('✅ PiTunnel installed successfully!', 'green');
    log('   Service is now running and will start automatically on login.', 'white');
    log(`   Log file: ${logPath}`, 'white');
    log('   To remove: piclient uninstall', 'yellow');
  } catch (e) {
    log(`❌ Installation failed: ${e.message}`, 'red');
  }
}

async function uninstallMac() {
  const plistPath = join(homedir(), 'Library/LaunchAgents/com.piclient.plist');

  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'pipe' });
  } catch (e) {}

  try {
    if (existsSync(plistPath)) {
      const fs = await import('fs');
      fs.unlinkSync(plistPath);
      log('✅ PiTunnel removed from system startup', 'green');
    } else {
      log('⚠️  PiTunnel was not installed or already removed', 'yellow');
    }
  } catch (e) {
    log(`❌ Uninstall failed: ${e.message}`, 'red');
  }
}

// ==================== Linux Install ====================
async function installLinux(nodePath, scriptPath) {
  const serviceDir = join(homedir(), '.config/systemd/user');
  const servicePath = join(serviceDir, 'piclient.service');
  const logPath = join(CONFIG_DIR, 'service.log');

  const serviceContent = `[Unit]
Description=PiTunnel Client Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${scriptPath} service
Restart=always
RestartSec=10
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;

  try {
    // systemd user dizini yoksa oluştur
    if (!existsSync(serviceDir)) {
      mkdirSync(serviceDir, { recursive: true });
    }

    // Service dosyasını yaz
    writeFileSync(servicePath, serviceContent);

    // Daemon'u yeniden yükle
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });

    // Servisi etkinleştir ve başlat
    execSync('systemctl --user enable piclient.service', { stdio: 'pipe' });
    execSync('systemctl --user start piclient.service', { stdio: 'pipe' });

    // Lingering'i etkinleştir (kullanıcı oturum açmadan da çalışsın)
    try {
      execSync(`loginctl enable-linger ${process.env.USER}`, { stdio: 'pipe' });
    } catch (e) {
      log('⚠️  Could not enable lingering. Service may not start before login.', 'yellow');
    }

    log('✅ PiTunnel installed successfully!', 'green');
    log('   Service is now running and will start automatically.', 'white');
    log(`   Log file: ${logPath}`, 'white');
    log('   Status: systemctl --user status piclient', 'white');
    log('   To remove: piclient uninstall', 'yellow');
  } catch (e) {
    log(`❌ Installation failed: ${e.message}`, 'red');
    log('   Make sure systemd user services are available.', 'yellow');
  }
}

async function uninstallLinux() {
  const servicePath = join(homedir(), '.config/systemd/user/piclient.service');

  try {
    execSync('systemctl --user stop piclient.service 2>/dev/null', { stdio: 'pipe' });
    execSync('systemctl --user disable piclient.service 2>/dev/null', { stdio: 'pipe' });
  } catch (e) {}

  try {
    if (existsSync(servicePath)) {
      const fs = await import('fs');
      fs.unlinkSync(servicePath);
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
      log('✅ PiTunnel removed from system startup', 'green');
    } else {
      log('⚠️  PiTunnel was not installed or already removed', 'yellow');
    }
  } catch (e) {
    log(`❌ Uninstall failed: ${e.message}`, 'red');
  }
}

// ==================== Run as Service ====================
async function runAsService() {
  const config = loadConfig();
  const connections = loadConnections();

  if (!config.token) {
    console.error('No token configured. Run "piclient login" first.');
    process.exit(1);
  }

  if (connections.length === 0) {
    console.error('No saved connections. Run "piclient start" first.');
    process.exit(1);
  }

  log('🚀 PiTunnel Service Starting...', 'cyan');
  log(`   Connections: ${connections.length}`, 'white');

  // Tüm kayıtlı bağlantıları başlat
  for (const conn of connections) {
    log(`   Starting: ${conn.name} → ${conn.target}`, 'white');

    // Her bağlantı için ayrı process başlat (detached değil, service olarak)
    startTunnel({
      name: conn.name,
      server: config.server,
      target: conn.target,
      type: conn.type,
      protocol: conn.protocol,
      ports: conn.ports || [],
      token: config.token,
      background: false,
    });

    // İlk bağlantıdan sonra diğerlerini background'da başlat
    if (connections.indexOf(conn) === 0) {
      // İlk bağlantı foreground'da çalışır, diğerleri için bekle
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Diğer bağlantıları background'da başlat
      for (let i = 1; i < connections.length; i++) {
        const c = connections[i];
        startInBackground({
          name: c.name,
          server: config.server,
          target: c.target,
          type: c.type,
          protocol: c.protocol,
          ports: c.ports || [],
          token: config.token,
        });
      }
    }
    break; // İlk bağlantıyı foreground'da başlattıktan sonra çık
  }
}
