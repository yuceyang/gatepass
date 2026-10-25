import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { isTermux } from '../src/system/termux.js';
import { writeHostsBlock, removeHostsBlock, elevatedWriteCommand } from '../src/system/hosts.js';
import { trustCaCommand, tryTrustCa } from '../src/system/certtrust.js';
import { autostartPaths, isAutostartInstalled, installAutostart, removeAutostart } from '../src/system/autostart.js';

const termuxEnv = { PREFIX: '/data/data/com.termux/files/usr' };
const termuxOptions = { platform: 'linux', env: termuxEnv };

test('termux: detect Termux markers without treating ordinary Linux as Termux', () => {
  assert.equal(isTermux('linux', termuxEnv), true);
  assert.equal(isTermux('linux', { TERMUX_VERSION: '0.118.0' }), true);
  assert.equal(isTermux('linux', { PREFIX: '/usr' }), false);
  assert.equal(isTermux('win32', termuxEnv), false);
});

test('termux: default proxy port is unprivileged and explicit config wins', () => {
  assert.equal(loadConfig('/nonexistent/gatepass-termux.json', termuxOptions).proxy.port, 18443);
  assert.equal(loadConfig('/nonexistent/gatepass-linux.json', { platform: 'linux', env: { PREFIX: '/usr' } }).proxy.port, 443);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatepass-termux-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ proxy: { port: 9443 } }));
  assert.equal(loadConfig(configPath, termuxOptions).proxy.port, 9443);
});

test('termux: system integration returns actionable unsupported results', async () => {
  const entries = [{ ip: '127.0.0.1', host: 'app-8080.example.com' }];
  const write = writeHostsBlock(entries, termuxOptions);
  assert.equal(write.supported, false);
  assert.match(write.reason, /DNS|hosts/i);
  assert.equal(removeHostsBlock(termuxOptions).supported, false);
  assert.equal(elevatedWriteCommand(entries, termuxOptions).command, null);

  const trust = trustCaCommand('/tmp/gatepass/ca.crt', termuxOptions);
  assert.equal(trust.supported, false);
  assert.equal(trust.command, null);
  assert.match(trust.note, /Android|NODE_EXTRA_CA_CERTS/);
  assert.equal((await tryTrustCa('/tmp/gatepass/ca.crt', termuxOptions)).supported, false);

  assert.equal(autostartPaths(termuxOptions).kind, 'unsupported');
  assert.equal(isAutostartInstalled(termuxOptions), false);
  assert.equal((await installAutostart(termuxOptions)).supported, false);
  assert.equal((await removeAutostart(termuxOptions)).supported, false);
});
