const addonConfig = {
    id: 'stupid-censor',
    directoryName: 'stupid-censor',
    name: 'stupidCensor',
    description: 'Облачная библиотека замен для заблюренных треков Яндекс Музыки.',
    version: '1.3.1',
    author: 'xaunds',
    image: 'Assets/logo.png',
    banner: 'Assets/banner.png',
    libraryLogo: 'Assets/logo.png',
    tags: ['tools', 'yandex-music', 'audio', 'github', 'library'],
    dependencies: [],
    allowedUrls: [
        'https://api.github.com',
        'https://api.github.com/',
        'https://github.com/',
        'https://raw.githubusercontent.com/',
        'https://objects.githubusercontent.com/',
        'https://release-assets.githubusercontent.com/',
    ],
    supportedVersions: [],
    requirements: {
        minHostApi: 1,
        capabilities: ['lifecycle-v1', 'async-start-v1', 'net-per-addon-v1', 'resource-read-v1'],
    },
}

export default addonConfig
