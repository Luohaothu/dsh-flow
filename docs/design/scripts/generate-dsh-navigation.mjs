import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderNavigationScene } from '../components/dshNavigationDesign.mjs'

const outputDirectory = fileURLToPath(new URL('../public/images/agent-tree-design/', import.meta.url))
for (const scene of ['global', 'session']) {
  const svg = renderNavigationScene({ scene, progress: 1, annotated: true, logoId: `dsh-${scene}-logo` })
  fs.writeFileSync(`${outputDirectory}dsh-${scene}.svg`, `${svg}\n`)
  console.log(`Generated dsh-${scene}.svg: 1120 × 900; node cards 216px at 1:1`)
}
