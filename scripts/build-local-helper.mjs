import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const outDir = path.join(root, 'dist', 'local-helper')
const archivePath = path.join(root, 'dist', `stupidcensor-local-helper-${packageJson.version}.zip`)

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(path.join(outDir, 'cloud'), { recursive: true })

for (const file of ['local_publisher.py', 'install-token.command', 'start-local-publisher.command', 'README-local.md', 'requirements-local.txt']) {
    fs.copyFileSync(path.join(root, 'tools', file), path.join(outDir, file))
}
fs.copyFileSync(path.join(root, 'cloud', 'uncensor_worker.py'), path.join(outDir, 'cloud', 'uncensor_worker.py'))
fs.copyFileSync(path.join(root, 'cloud', 'requirements.txt'), path.join(outDir, 'cloud', 'requirements.txt'))
for (const file of ['local_publisher.py', 'install-token.command', 'start-local-publisher.command']) {
    fs.chmodSync(path.join(outDir, file), 0o755)
}

fs.rmSync(archivePath, { force: true })
execFileSync('zip', ['-qr', archivePath, '.'], { cwd: outDir, stdio: 'inherit' })
console.log(`Local helper built: ${path.relative(root, outDir)}`)
console.log(`Archive: ${path.relative(root, archivePath)}`)
