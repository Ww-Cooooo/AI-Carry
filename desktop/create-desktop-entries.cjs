const {existsSync,realpathSync,mkdirSync,writeFileSync,symlinkSync,lstatSync}=require('node:fs');
const path=require('node:path');

// Called by the one-sentence installer after the client package is installed.
// The web entry stays in the installation root; the Desktop gets the client entry.
// Never changes login items or permissions.
exports.createDesktopEntries=({app,shell,root,stateDirectory,desktopDirectory=app.getPath('desktop')})=>{
  root=realpathSync(root);
  if(!existsSync(path.join(root,'instance','manifest.toml'))||!existsSync(path.join(root,'dashboard.html')))throw Error('请选择完整的 AI Carry 安装目录；没有创建指向缺失文件的入口。');
  const desktop=realpathSync(desktopDirectory),icon=path.join(__dirname,'icon.ico'),entries=[];
  const freePath=(name,ext,owns=()=>false)=>{
    for(let n=1;n<100;n++){const file=path.join(desktop,name+(n===1?'':` (${n})`)+ext);if(!existsSync(file)||owns(file))return file;}
    throw Error('桌面已有过多同名入口；没有覆盖其他文件。');
  };
  const webEntry=path.join(root,'dashboard.html');
  if(process.platform==='win32'){
    const label='AI Carry（客户端）',target=process.execPath,args=`--assistant-root "${root}"`,kind='desktop';
    const description=`AI Carry ${kind}: ${root}`;
    const file=freePath(label,'.lnk',file=>{try{return shell.readShortcutLink(file).description===description;}catch{return false;}});
    if(!shell.writeShortcutLink(file,existsSync(file)?'update':'create',{target,args,cwd:root,description,icon,iconIndex:0}))throw Error('这个客户端入口未能创建：'+file+'；安装目录和网页版入口仍保留。');
    entries.push({kind,path:file,target,args});
  }else if(process.platform==='darwin'){
    const bundle=process.execPath.split('.app/')[0]+'.app';
    if(!existsSync(bundle))throw Error('当前不是打包后的 macOS 应用；安装目录中的网页版入口仍保留。');
    const client=freePath('AI Carry（客户端）','.app',file=>{try{return lstatSync(file).isSymbolicLink()&&realpathSync(file)===realpathSync(bundle);}catch{return false;}});
    if(!existsSync(client))symlinkSync(bundle,client,'dir');
    entries.push({kind:'desktop',path:client,target:bundle});
  }else throw Error('当前桌面系统请使用安装目录中的 dashboard.html；本版本客户端入口针对 Windows 与 macOS。');
  mkdirSync(stateDirectory,{recursive:true});writeFileSync(path.join(stateDirectory,'initial-root.json'),JSON.stringify({root}));
  return {entries,webEntry};
};
