const {existsSync,realpathSync,mkdirSync,writeFileSync,symlinkSync,lstatSync}=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');

// Called only by an explicit install command. Never changes login items or permissions.
exports.createDesktopEntries=({app,shell,root,stateDirectory,desktopDirectory=app.getPath('desktop')})=>{
  root=realpathSync(root);
  if(!existsSync(path.join(root,'instance','manifest.toml'))||!existsSync(path.join(root,'dashboard.html')))throw Error('请选择完整的 AI Carry 安装目录；没有创建指向缺失文件的入口。');
  const desktop=realpathSync(desktopDirectory),icon=path.join(__dirname,'icon.ico'),entries=[];
  const freePath=(name,ext,owns=()=>false)=>{
    for(let n=1;n<100;n++){const file=path.join(desktop,name+(n===1?'':` (${n})`)+ext);if(!existsSync(file)||owns(file))return file;}
    throw Error('桌面已有过多同名入口；没有覆盖其他文件。');
  };
  if(process.platform==='win32'){
    for(const [label,target,args,kind] of [
      ['AI Carry（网页版）',path.join(root,'dashboard.html'),'','web'],
      ['AI Carry（客户端）',process.execPath,`--assistant-root "${root}"`,'desktop']
    ]){
      const description=`AI Carry ${kind}: ${root}`;
      const file=freePath(label,'.lnk',file=>{try{return shell.readShortcutLink(file).description===description;}catch{return false;}});
      if(!shell.writeShortcutLink(file,existsSync(file)?'update':'create',{target,args,cwd:root,description,icon,iconIndex:0}))throw Error('这个快捷方式未能创建：'+file+'；已创建的入口仍保留。');
      entries.push({kind,path:file,target,args});
    }
  }else if(process.platform==='darwin'){
    const web=freePath('AI Carry（网页版）','.webloc');
    const url=pathToFileURL(path.join(root,'dashboard.html')).href.replaceAll('&','&amp;');
    writeFileSync(web,`<?xml version="1.0"?><plist version="1.0"><dict><key>URL</key><string>${url}</string></dict></plist>`);
    const bundle=process.execPath.split('.app/')[0]+'.app';
    if(!existsSync(bundle))throw Error('当前不是打包后的 macOS 应用；网页版入口已经保留。');
    const client=freePath('AI Carry（客户端）','.app',file=>{try{return lstatSync(file).isSymbolicLink()&&realpathSync(file)===realpathSync(bundle);}catch{return false;}});
    if(!existsSync(client))symlinkSync(bundle,client,'dir');
    entries.push({kind:'web',path:web,target:path.join(root,'dashboard.html')},{kind:'desktop',path:client,target:bundle});
  }else throw Error('当前桌面系统请使用安装目录的 dashboard.html；本版本客户端安装入口针对 Windows 与 macOS。');
  mkdirSync(stateDirectory,{recursive:true});writeFileSync(path.join(stateDirectory,'initial-root.json'),JSON.stringify({root}));
  return entries;
};
