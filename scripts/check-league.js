const { execFileSync } = require('node:child_process');
const https = require('node:https');

function readLeagueUxArgs() {
  const commandLine = execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    "(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'LeagueClientUx.exe' } | Select-Object -First 1 -ExpandProperty CommandLine)"
  ], { encoding: 'utf8' }).trim();

  const value = (name) => {
    const match = commandLine.match(new RegExp(`--${name}=([^"\\s]+|"[^"]+")`));
    return match ? match[1].replace(/^"|"$/g, '') : null;
  };

  return {
    port: value('app-port'),
    token: value('remoting-auth-token')
  };
}

function get(path, port, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path,
      auth: `riot:${token}`,
      rejectUnauthorized: false,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 LeagueOfLegendsClient/16.10.777.2413 (CEF 108)'
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ path, statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const { port, token } = readLeagueUxArgs();
  if (!port || !token) throw new Error('LeagueClientUx.exe not found or missing remoting args.');

  for (const path of ['/bootstrap.html', '/index.html', '/plugin-manager/v1/status']) {
    const result = await get(path, port, token);
    console.log(`${path} ${result.statusCode}`);
    console.log(result.body.slice(0, 500));
  }
})();
