import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = process.cwd()
const react18 = path.resolve(root, 'node_modules/react18')
const reactDom18 = path.resolve(root, 'node_modules/react-dom18')

export default defineConfig({
    root,
    resolve: {
        alias: [
            { find: /^react$/, replacement: react18 },
            { find: /^react\/jsx-runtime$/, replacement: path.resolve(react18, 'jsx-runtime.js') },
            { find: /^react\/jsx-dev-runtime$/, replacement: path.resolve(react18, 'jsx-dev-runtime.js') },
            { find: /^react-dom$/, replacement: reactDom18 },
            { find: /^react-dom\/client$/, replacement: path.resolve(reactDom18, 'client.js') },
            { find: '@', replacement: path.resolve(root, 'src') },
        ],
    },
    plugins: [react()],
    define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
    },
    build: {
        target: 'es2020',
        outDir: 'dist/stupid-censor',
        emptyOutDir: true,
        cssCodeSplit: false,
        minify: 'oxc',
        sourcemap: false,
        lib: {
            entry: path.resolve(root, 'src/legacy.tsx'),
            name: 'StupidCensor',
            formats: ['iife'],
            fileName: () => 'script.js',
        },
        rollupOptions: {
            output: {
                inlineDynamicImports: true,
                entryFileNames: 'script.js',
                assetFileNames: 'script.[ext]',
            },
        },
    },
})
