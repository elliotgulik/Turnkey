#!/usr/bin/env node
// Standard vendoring + zip packaging, scoped entirely to extension/**.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const extension=path.resolve(__dirname,'..'),root=path.dirname(extension);
for(const file of ['pricing-engine.js','cost-engine.js','pricing-learning-engine.js']) {
  const source=path.join(root,file);
  if(fs.existsSync(source))fs.copyFileSync(source,path.join(extension,'vendor',file));
  else if(file==='pricing-learning-engine.js')console.warn('Learning engine unavailable; extension will use base/manual pricing.');
  else throw Error('Missing required engine: '+file);
}
const {version}=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'),'utf8'));
const output=path.join(extension,'dist',`turnkey-earth-extension-${version}.zip`);
fs.mkdirSync(path.dirname(output),{recursive:true});
const stage=fs.mkdtempSync(path.join(os.tmpdir(),'turnkey-extension-pack-'));
try {
  for(const name of ['manifest.json','README.md','geometry.js','api','background','content','icons','popup','vendor'])fs.cpSync(path.join(extension,name),path.join(stage,name),{recursive:true});
  fs.rmSync(output,{force:true});
  execFileSync('zip',['-q','-r',output,'.'],{cwd:stage});
  console.log(output);
} finally {fs.rmSync(stage,{recursive:true,force:true});}
