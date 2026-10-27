import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { renderPanelScene } from '../components/dshPanelsDesign.mjs'

for (const scene of ['observer', 'settings']) {
  const target = new URL(`../public/images/agent-tree-design/dsh-${scene}.svg`, import.meta.url)
  await writeFile(target, renderPanelScene({ scene, annotated:true, logoId:`dsh-${scene}-logo` }) + '\n')
  console.log(fileURLToPath(target))
}
