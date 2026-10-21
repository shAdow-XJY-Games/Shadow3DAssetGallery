import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {fetchVerifiedGLB} from './core.mjs';
export async function createViewer(container,url,file,isCurrent,signal){
 const bytes=await fetchVerifiedGLB(url,file,{signal});if(!isCurrent())return null;
 const scene=new THREE.Scene();scene.background=new THREE.Color('#e7ebe2');const camera=new THREE.PerspectiveCamera(38,1,.01,1000),renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;container.append(renderer.domElement);
 const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;scene.add(new THREE.HemisphereLight(0xffffff,0x66806a,2.4));const light=new THREE.DirectionalLight(0xffecd8,3);light.position.set(4,7,5);scene.add(light);
 let disposed=false,frame;const resize=()=>{const w=container.clientWidth||1,h=container.clientHeight||1;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();};const observer=new ResizeObserver(resize);observer.observe(container);resize();
 const dispose=()=>{if(disposed)return;disposed=true;cancelAnimationFrame(frame);observer.disconnect();controls.dispose();scene.traverse(o=>{o.geometry?.dispose();for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[]){for(const v of Object.values(m))if(v?.isTexture)v.dispose();m.dispose();}});renderer.dispose();renderer.forceContextLoss();renderer.domElement.remove();};
 try{
 const manager=new THREE.LoadingManager();manager.setURLModifier(request=>{if(request.startsWith('blob:')||request.startsWith('data:'))return request;throw Error('External model resource blocked');});
 const gltf=await new GLTFLoader(manager).parseAsync(bytes,'');scene.add(gltf.scene);if(!isCurrent()){dispose();return null;}const box=new THREE.Box3().setFromObject(gltf.scene),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());gltf.scene.position.sub(center);const radius=Math.max(size.length()/2,.01);const distance=radius/Math.sin(THREE.MathUtils.degToRad(camera.fov/2))*1.2;
 camera.near=radius/100;camera.far=radius*100;camera.updateProjectionMatrix();controls.minDistance=radius*.7;controls.maxDistance=radius*12;
 const reset=()=>{controls.target.set(0,0,0);camera.position.set(distance*.7,distance*.5,distance*.85);controls.update();};reset();const animate=()=>{if(disposed)return;frame=requestAnimationFrame(animate);controls.update();renderer.render(scene,camera);};animate();return {dispose,reset};
 }catch(e){dispose();throw e;}
}
