import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';

/**
 * 生成覆盖真实主机形态的证书。
 *
 * 注意：目标域可能是连字符拼接，如 `app-5006-yuceyang.cn68.ugdocker.link`，
 * 通配符 `*.yuceyang.cn68.ugdocker.link` 盖不住它；必须包含 `*.parent` 与具体主机名。
 *
 * @param {{domainSuffix:string, hosts?:string[], certDir:string, force?:boolean}} opts
 */
export function ensureCerts(opts) {
  const { domainSuffix, hosts = [], certDir, force = false } = opts;
  fs.mkdirSync(certDir, { recursive: true });
  const keyPath = path.join(certDir, 'proxy.key');
  const certPath = path.join(certDir, 'proxy.crt');
  const caPath = path.join(certDir, 'ca.crt');

  if (!force && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
      caPath,
      certPath,
      keyPath,
      fresh: false,
    };
  }

  const parent = domainSuffix.includes('.') ? domainSuffix.split('.').slice(1).join('.') : domainSuffix;
  const san = new Set([
    domainSuffix,
    `*.${domainSuffix}`,
    parent,
    `*.${parent}`,
    ...hosts,
  ]);

  const attrs = [{ name: 'commonName', value: `*.${parent}` }];
  const extensions = [
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    {
      name: 'subjectAltName',
      altNames: [...san].filter(Boolean).map((value) => ({ type: 2, value })),
    },
  ];

  const pems = selfsigned.generate(attrs, {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions,
  });

  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(caPath, pems.cert);

  return {
    key: pems.private,
    cert: pems.cert,
    caPath,
    certPath,
    keyPath,
    fresh: true,
  };
}

/** 证书是否覆盖指定主机名（离线校验） */
export async function certCoversHost(pem, hostname) {
  const tls = await import('node:tls');
  const crypto = await import('node:crypto');
  const x = new crypto.X509Certificate(pem);
  const cert = {
    subject: { CN: x.subject.split('CN=')[1] || x.subject },
    subjectaltname: x.subjectAltName,
  };
  return !tls.checkServerIdentity(hostname, cert);
}
