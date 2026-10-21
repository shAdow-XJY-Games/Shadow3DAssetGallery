import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';import {join} from 'node:path';
import {PUBLIC_FILES,repositoryRoot} from './build.mjs';import {fetchPagedCatalogEntry} from '../docs/core-catalog-v3.mjs';
test('actual local HTTP serves the unchanged v3 entry and collection shell without asset or legacy routes',async()=>{
 const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';if(!PUBLIC_FILES.includes(path)){res.writeHead(404).end();return;}res.end(await readFile(join(repositoryRoot,'docs',path)));}catch{res.writeHead(500).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
 const base='http://127.0.0.1:'+server.address().port,html=await(await fetch(base)).text();assert.match(html,/THE COLLECTION/);assert.match(html,/探索素材/);assert.match(html,/滚动自动加载/);assert.match(html,/分页浏览/);assert.doesNotMatch(html,/SHADOW 3D ASSET LIBRARY/);
 const entry=await fetchPagedCatalogEntry({fetcher:(url,options)=>fetch(new URL(url,base+'/'),options)});assert.equal(entry.schemaVersion,3);
 for(const path of ['assets/model.glb','catalog.json','catalog-v2.json','metadata/old.json'])assert.equal((await fetch(base+'/'+path)).status,404);
 for(const path of PUBLIC_FILES)assert.equal((await fetch(base+'/'+path)).status,200);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
