import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,readdir,writeFile,mkdir,cp,rm,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {checkRepository,checkPublicDirectory,build,PUBLIC_FILES,PACKAGE_BUDGET,repositoryRoot} from './build.mjs';
const temporary=()=>mkdtemp(join(tmpdir(),'shadow-gallery-test-'));
test('repository and Pages contain only allowlisted text and the active root, with no copied asset files',async()=>{
 const repo=await checkRepository(),pages=await checkPublicDirectory();assert.ok(repo.files>pages.files);assert.equal(pages.files,PUBLIC_FILES.length);assert.ok(pages.bytes<PACKAGE_BUDGET);
 const temp=await temporary();try{const out=join(temp,'pages');assert.deepEqual(await build(out),pages);assert.deepEqual((await readdir(out)).sort(),[...PUBLIC_FILES].sort());for(const name of PUBLIC_FILES)assert.deepEqual(await readFile(join(out,name)),await readFile(join(repositoryRoot,'docs',name)));}finally{await rm(temp,{recursive:true,force:true});}
});
test('unexpected images, models, legacy metadata, binary content and symlinks are refused',async()=>{
 const temp=await temporary();try{const repo=join(temp,'repo');await cp(repositoryRoot,repo,{recursive:true,filter:s=>!s.includes('/.git')});
 for(const path of ['assets/model.glb','docs/preview.png','docs/catalog.json','unlisted.txt']){await mkdir(join(repo,path,'..'),{recursive:true});await writeFile(join(repo,path),'test');await assert.rejects(()=>checkRepository(repo),/Unexpected|prohibited/);await rm(join(repo,path));}
 const original=await readFile(join(repo,'README.md'));await writeFile(join(repo,'README.md'),Buffer.from([0,1,2]));await assert.rejects(()=>checkRepository(repo),/Binary/);await writeFile(join(repo,'README.md'),original);
 await symlink(join(repo,'README.md'),join(repo,'link'));await assert.rejects(()=>checkRepository(repo),/Symlink/);await rm(join(repo,'link'));
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('future Gallery graph paths are accepted only when JSON content and hash match',async()=>{
 const temp=await temporary();try{const repo=join(temp,'repo');await cp(repositoryRoot,repo,{recursive:true,filter:s=>!s.includes('/.git')});
 const bytes=Buffer.from(JSON.stringify({schemaVersion:3,family:'facets',kind:'leaf',entries:[['theme\u0000test',1]]})+'\n'),hash=createHash('sha256').update(bytes).digest('hex'),path=join(repo,'catalog/v3',hash.slice(0,2),hash+'.json');
 await mkdir(join(path,'..'),{recursive:true});await writeFile(path,bytes);assert.equal((await checkRepository(repo)).metadataNodes,1);await writeFile(path,bytes.toString()+' ');await assert.rejects(()=>checkRepository(repo),/hash mismatch/);
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('output inside the repository or existing output is refused without deleting it',async()=>{
 await assert.rejects(()=>build(join(repositoryRoot,'dist')),/outside/);const temp=await temporary();try{await writeFile(join(temp,'keep.txt'),'keep');await assert.rejects(()=>build(temp),/unexpected files/);assert.equal(await readFile(join(temp,'keep.txt'),'utf8'),'keep');}finally{await rm(temp,{recursive:true,force:true});}
});
