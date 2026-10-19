const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = new Set(['package.json']);
function collect(relative) {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Source symlinks are not packaged: ${relative}`);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute)) collect(path.posix.join(relative, name));
  } else if (stat.isFile()) {
    files.add(relative.replaceAll('\\', '/'));
  }
}
for (const pattern of pkg.files) {
  for (const matched of fs.globSync(pattern, { cwd: root })) collect(matched);
}
const required = ['LICENSE', 'package-lock.json', 'config/rooms.example.json', 'src/cli.cjs'];
for (const file of required) {
  if (!files.has(file)) throw new Error(`Missing source file: ${file}`);
}
const forbidden =
  /(?:^|\/)(?:data|outputs|node_modules|\.git)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|^config\/(?:rooms|settings)\.json$|\.(?:sqlite|db|log|zip|tgz)(?:-|$)/;
const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/,
  /(?:[A-Z]:[\\/](?:Users|projects)[\\/])/i,
];
for (const file of files) {
  if (forbidden.test(file)) throw new Error(`Private runtime file in source package: ${file}`);
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  if (credentialPatterns.some((pattern) => pattern.test(content))) {
    throw new Error(`Review potentially private content before packaging: ${file}`);
  }
}
const destination = path.join(root, 'outputs', 'releases');
fs.mkdirSync(destination, { recursive: true });
const archive = path.join(destination, `${pkg.name}-${pkg.version}-source.tar.gz`);
const temporary = `${archive}.${process.pid}.tmp`;
const result = spawnSync(
  'tar',
  ['--format', 'ustar', '-czf', temporary, '--', ...[...files].sort()],
  {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  },
);
if (result.error)
  throw new Error('Source packaging requires tar in PATH.', { cause: result.error });
if (result.status !== 0) throw new Error(result.stderr || 'tar failed');
fs.renameSync(temporary, archive);
console.log(
  JSON.stringify(
    {
      archive,
      files: files.size,
      bytes: fs.statSync(archive).size,
      sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    },
    null,
    2,
  ),
);
