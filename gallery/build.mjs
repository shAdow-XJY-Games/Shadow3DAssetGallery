// Dependency-free, asset-free package validation. No network requests or Git writes.
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {resolve,dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateV3Root,validateV3Descriptor,V3} from '../docs/core-catalog-v3.mjs';
export const PUBLIC_FILES=Object.freeze(['.nojekyll','app-v3.mjs','catalog-v3.json','core-catalog-v2.mjs','core-catalog-v3.mjs','core.mjs','index.html','style.css','viewer.mjs']);
export const PACKAGE_BUDGET=262144,REPOSITORY_FILE_BUDGET=262144;
export const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const graphPath=/^catalog\/v3\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/;
async function filesUnder(dir,prefix=''){
 const files=[];
 for(const name of await readdir(dir)){
  if(!prefix&&name==='.git')continue;
  const path=prefix?prefix+'/'+name:name,entry=await lstat(join(dir,name));
  if(entry.isSymbolicLink())throw Error('Symlink not allowed: '+path);
  if(entry.isDirectory())files.push(...await filesUnder(join(dir,name),path));
  else if(entry.isFile())files.push(path);else throw Error('Unsupported file type: '+path);
 }return files.sort();
}
export async function checkRepository(root=repositoryRoot){
 const manifest=JSON.parse(await readFile(join(root,'repository-files.json'),'utf8'));
 if(!Array.isArray(manifest)||manifest.some(p=>typeof p!=='string'||p.startsWith('/')||p.includes('..'))||new Set(manifest).size!==manifest.length)throw Error('Invalid repository allowlist');
 const names=await filesUnder(root),allowed=new Set(manifest),missing=manifest.filter(p=>!names.includes(p));
 if(missing.length)throw Error('Missing allowlisted files: '+missing.join(', '));
 let bytes=0,metadataNodes=0;
 for(const path of names){
  if(!allowed.has(path)&&!graphPath.test(path))throw Error('Unexpected repository file: '+path);
  if(path.startsWith('assets/')||/\.(?:glb|gltf|blend|png|jpe?g|webp|gif|zip|tar|gz|py)$/i.test(path))throw Error('Asset or binary file prohibited: '+path);
  const content=await readFile(join(root,path));if(content.length>REPOSITORY_FILE_BUDGET)throw Error('Repository file budget exceeded: '+path);
  const text=new TextDecoder('utf-8',{fatal:true}).decode(content);if(text.includes('\0'))throw Error('Binary content prohibited: '+path);
  if(graphPath.test(path)){
   const hash=path.split('/').at(-1).slice(0,64);if(path.split('/')[2]!==hash.slice(0,2)||sha(content)!==hash)throw Error('Metadata graph hash mismatch: '+path);
   const payload=JSON.parse(text);if(payload.schemaVersion!==3||!['records','sources','terms','facets','postings'].includes(payload.family)||!['leaf','branch'].includes(payload.kind))throw Error('Invalid metadata graph node: '+path);metadataNodes++;
  }
  bytes+=content.length;
 }
 const entry=validateV3Root(JSON.parse(await readFile(join(root,'docs/catalog-v3.json'),'utf8')));
 return {files:names.length,bytes,metadataNodes,assetCount:entry.assetCount};
}
export async function checkPublicDirectory(root=repositoryRoot){
 const dir=join(root,'docs'),names=await filesUnder(dir);
 if(JSON.stringify(names)!==JSON.stringify([...PUBLIC_FILES].sort()))throw Error('docs/ must contain only the Pages allowlist');
 let bytes=0;
 for(const name of names){const content=await readFile(join(dir,name));new TextDecoder('utf-8',{fatal:true}).decode(content);bytes+=content.length;}
 const entryBytes=await readFile(join(dir,'catalog-v3.json'));if(entryBytes.length>V3.rootBytes)throw Error('Catalog entry budget exceeded');
 validateV3Root(JSON.parse(entryBytes));if(bytes>PACKAGE_BUDGET)throw Error('Pages package budget exceeded');
 return {files:names.length,bytes,entryBytes:entryBytes.length};
}
export async function build(out,{root=repositoryRoot}={}){
 await checkRepository(root);const report=await checkPublicDirectory(root),target=resolve(out),inside=relative(root,target);
 if(!inside||(!inside.startsWith('..')&&!inside.startsWith('/')))throw Error('Output must be outside the repository');
 await mkdir(target,{recursive:true});if((await readdir(target)).length)throw Error('Output contains unexpected files; use a fresh directory');
 for(const name of PUBLIC_FILES)await writeFile(join(target,name),await readFile(join(root,'docs',name)));
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='--check')console.log(JSON.stringify({repository:await checkRepository(),pages:await checkPublicDirectory()}));
 else if(process.argv[2])console.log(JSON.stringify(await build(process.argv[2])));
 else throw Error('Usage: node gallery/build.mjs --check | <fresh-output-outside-repository>');
}
