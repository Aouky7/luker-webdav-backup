import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';

const here = path.dirname(fileURLToPath(import.meta.url));
const parent = fs.realpathSync(os.tmpdir());
const temp = fs.mkdtempSync(path.join(parent, 'luker-network-'));
const resolved = fs.realpathSync(temp);
const certificate = path.join(temp, 'certificate.pem'), key = path.join(temp, 'key.pem');
let server, serverExit;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', key, '-out', certificate], {stdio:'pipe',timeout:30000});
  fs.chmodSync(key, 0o600);
  const env = {...process.env, NODE_EXTRA_CA_CERTS:certificate, TEST_CERT:certificate, TEST_KEY:key};
  if (process.argv.includes('--wsgidav')) {
    const storage = path.join(temp, 'server-storage'); fs.mkdirSync(storage);
    server = spawn(process.env.WEBDAV_TEST_PYTHON || 'python3', [path.join(here, 'wsgidav-server.py'), storage, certificate, key], {stdio:['ignore','pipe','pipe']});
    serverExit = new Promise(resolve => server.once('exit', resolve));
    let stderr = '';
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    env.TEST_DAV_URL = await new Promise((resolve, reject) => {
      const lines = createInterface({input:server.stdout});
      const timer = setTimeout(() => { lines.close(); reject(new Error('WebDAV server startup timed out: ' + stderr)); }, 20000);
      const failed = error => { clearTimeout(timer); lines.close(); reject(error); };
      server.once('error', failed);
      server.once('exit', code => failed(new Error('WebDAV server exited: ' + code + '\n' + stderr)));
      lines.on('line', line => {
        try {
          const value = JSON.parse(line);
          if (value.url) { clearTimeout(timer); lines.close(); resolve(value.url); }
        } catch { /* Server diagnostics are not readiness messages. */ }
      });
    });
  }
  const child = spawn(process.execPath, ['--test', path.join(here, 'integration', 'https.test.mjs')], {env, stdio:'inherit'});
  process.exitCode = await new Promise((resolve,reject) => { child.once('error',reject); child.once('exit', code => resolve(code ?? 1)); });
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
    await serverExit; clearTimeout(timer);
  }
  assert.equal(fs.realpathSync(temp), resolved);
  assert.equal(path.dirname(resolved), parent);
  assert.ok(path.basename(resolved).startsWith('luker-network-'));
  fs.rmSync(resolved, {recursive:true, force:true});
}
