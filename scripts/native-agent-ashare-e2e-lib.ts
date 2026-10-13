import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, realpathSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
export const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export const readJson=(path:string):Record<string,any>=>JSON.parse(readFileSync(path,'utf8'));
export const writeJson=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
export function tree(root:string): {path:string;sha256:string}[] {
 const files:{path:string;sha256:string}[]=[];
 function walk(dir:string){if(!existsSync(dir))return;for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(e.name==='node_modules'||e.name==='.git')continue;const p=join(dir,e.name);if(e.isDirectory())walk(p);else if(e.isFile())files.push({path:relative(root,p),sha256:sha(readFileSync(p))});}}
 walk(root);return files;
}
export const treeHash=(path:string)=>sha(JSON.stringify(tree(path)));
export function installedRuntime(){
 const req=createRequire(join(ROOT,'package.json'));
 const roots=new Map<string,string>();
 for(const base of [join(ROOT,'node_modules/@deepseek-ai'),join(ROOT,'packages/dsh-flow/node_modules/@deepseek-ai')]){
  if(!existsSync(base))continue;
  for(const name of readdirSync(base)){const p=join(base,name);if(existsSync(join(p,'package.json')))roots.set(`@deepseek-ai/${name}`,realpathSync(p));}
 }
 const dsh=process.env.DSH_INSTALL_PATH?resolve(process.env.DSH_INSTALL_PATH):dirname(req.resolve('@deepseek-ai/dsh/package.json'));
 roots.set('@deepseek-ai/dsh',dsh);
 return [...roots].sort(([a],[b])=>a.localeCompare(b)).map(([name,path])=>({name,path,version:readJson(join(path,'package.json')).version,sha256:treeHash(path)}));
}
export function identity(campaign:string){
 return {package:treeHash(join(campaign,'frozen-package')),host:treeHash(join(ROOT,'src/host')),runner:sha(['native-agent-ashare-e2e.ts','native-agent-ashare-e2e-lib.ts','native-agent-ashare-stage.ts'].map(n=>`${n}:${sha(readFileSync(join(ROOT,'scripts',n)))}`).join('\n')),lock:sha(readFileSync(join(ROOT,'pnpm-lock.yaml'))),patches:treeHash(join(ROOT,'patches')),runtime:sha(JSON.stringify(installedRuntime())),task:sha(readFileSync(join(campaign,'task.txt'))),ordinary_mode:sha(readFileSync(join(campaign,'ordinary-mode.txt'))),team_mode:sha(readFileSync(join(campaign,'team-mode.txt'))),profile:sha(readFileSync(join(campaign,'.private/profile.patch.yml'))),credential:sha(readFileSync(join(campaign,'.private/credentials.yml')))};
}
