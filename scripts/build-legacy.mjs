import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, 'dist', 'stupid-censor')
const archivePath = path.join(root, 'dist', 'stupid-censor.pext')

execFileSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.legacy.config.ts'], {
    cwd: root,
    stdio: 'inherit',
})

fs.mkdirSync(path.join(outDir, 'Assets'), { recursive: true })
for (const asset of ['logo.png', 'banner.png']) {
    fs.copyFileSync(path.join(root, 'addon', 'Assets', asset), path.join(outDir, 'Assets', asset))
}
fs.writeFileSync(path.join(outDir, 'script.css'), '')

const metadata = {
    id: 'stupid-censor',
    name: 'stupidCensor',
    description: 'Облачная библиотека замен для заблюренных треков Яндекс Музыки.',
    version: '1.1.0',
    author: 'xaunds',
    type: 'script',
    image: 'Assets/logo.png',
    banner: 'Assets/banner.png',
    libraryLogo: '',
    css: 'script.css',
    script: 'script.js',
    tags: ['tools'],
    dependencies: [],
    conflictsWith: [],
    allowedUrls: [
        'https://api.github.com/',
        'https://github.com/',
        'https://raw.githubusercontent.com/',
        'https://objects.githubusercontent.com/',
        'https://release-assets.githubusercontent.com/',
        'https://codeload.github.com/',
    ],
    supportedVersions: [],
    fromPext: true,
    installSource: 'local',
}
fs.writeFileSync(path.join(outDir, 'metadata.json'), `${JSON.stringify(metadata, null, 4)}\n`)

if (fs.existsSync(archivePath)) fs.rmSync(archivePath)
execFileSync('zip', ['-qr', archivePath, '.'], { cwd: outDir, stdio: 'inherit' })

console.log(`Legacy addon built: ${path.relative(root, outDir)}`)
console.log(`Archive: ${path.relative(root, archivePath)}`)
