import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

function readIni(filePath) {
    const cfg = {}
    for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        cfg[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
    return cfg
}

const cfg = readIni(path.resolve(__dirname, '../config.ini'))
const apiTarget = `http://${cfg.CORE_ADDRESS}:${cfg.CORE_PORT}`

const proxyConfig = {
    '/api': { target: apiTarget, changeOrigin: true }
}

export default defineConfig({
    plugins: [react()],
    server: {
        port: Number(cfg.CLIENT_PORT),
        proxy: proxyConfig
    },
    preview: {
        port: Number(cfg.CLIENT_PORT),
        proxy: proxyConfig
    }
})
