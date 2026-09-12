const {app,BrowserWindow,protocol,net,session,ipcMain,clipboard,dialog,nativeImage,shell}=require('electron');
const {join,resolve,sep}=require('node:path');
const {mkdirSync,realpathSync}=require('node:fs');
const {pathToFileURL}=require('node:url');
const stateIndex=process.argv.indexOf('--state-dir');
const rootIndex=process.argv.indexOf('--assistant-root');
const initialRoot=rootIndex>=0?resolve(process.argv[rootIndex+1]):undefined;
const stateDirectory=stateIndex>=0?resolve(process.argv[stateIndex+1]):join(app.getPath('userData'),'local');
const profile=join(stateDirectory,'window-profile');
mkdirSync(profile,{recursive:true});
app.setPath('userData',profile);
app.setName('AI Carry');
if(process.platform==='win32')app.setAppUserModelId('com.aicarry.desktop');
let service,win,serviceError;
const installing=process.argv.includes('--install-shortcuts');
if(!installing&&!app.requestSingleInstanceLock())app.quit();
app.on('second-instance',async(_event,argv)=>{
  const index=argv.indexOf('--assistant-root');
  if(index>=0&&argv[index+1]&&service){
    try{await service.selectRoot(resolve(argv[index+1]));win?.webContents.send('carry:changed');}
    catch(error){await dialog.showMessageBox(win,{type:'warning',message:'没有切换助手资料',detail:error.message});}
  }
  if(win){if(win.isMinimized())win.restore();win.show();win.focus();}
});
protocol.registerSchemesAsPrivileged([{scheme:'ai-carry',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.whenReady().then(async()=>{
  if(installing){
    try{
      const {createDesktopEntries}=require('./create-desktop-entries.cjs');
      const di=process.argv.indexOf('--desktop-dir');
      const entries=createDesktopEntries({app,shell,root:initialRoot,stateDirectory,...(di>=0?{desktopDirectory:resolve(process.argv[di+1])}:{})});
      require('node:fs').writeFileSync(join(stateDirectory,'installation-result.json'),JSON.stringify({status:'installed',entries},null,2));
    }catch(error){require('node:fs').writeFileSync(join(stateDirectory,'installation-result.json'),JSON.stringify({status:'partial',error:error.message},null,2));process.exitCode=1;}
    app.quit();return;
  }
  const applicationIcon=nativeImage.createFromPath(join(__dirname,'icon.png'));
  if(process.platform==='darwin'&&!applicationIcon.isEmpty())app.dock?.setIcon(applicationIcon);
  try{
    {
      const {createManualClient}=await import(pathToFileURL(join(__dirname,'manual-client.mjs')).href);
      service=createManualClient({stateDirectory,initialRoot,chooseDirectory:async()=>{
        const result=await dialog.showOpenDialog(win,{title:'选择 AI Carry 助手文件夹',properties:['openDirectory']});
        return result.canceled?null:result.filePaths[0];
      }});
    }
  }catch(error){
    // Data reading can fail locally without blocking the shell or clipboard.
    serviceError=error.message;
  }
  ipcMain.handle('carry:command',async(event,action,input)=>{
    try{
      const source=new URL(event.senderFrame.url);
      if(event.senderFrame!==event.sender.mainFrame||source.protocol!=='ai-carry:'||source.hostname!=='pages'||source.pathname!=='/index.html')throw new Error('只接受当前客户端窗口的操作。');
      if(typeof action!=='string'||JSON.stringify(input??{}).length>40000)throw new Error('请求不完整或过长，没有执行。');
      if(action==='copy'){
        if(typeof input?.text!=='string'||input.text.length>32000)throw new Error('没有可以复制的完整请求。');
        await clipboard.writeText(input.text);return{ok:true,value:true};
      }
      if(action==='choose-skill-source'){
        const kind=input?.sourceType;
        if(kind!=='folder'&&kind!=='zip')throw new Error('请选择文件夹或 ZIP 文件；网页链接直接粘贴即可。');
        const result=await dialog.showOpenDialog(win,kind==='folder'
          ?{title:'选择 Skill 文件夹',buttonLabel:'选择文件夹',properties:['openDirectory','dontAddToRecent']}
          :{title:'选择 Skill ZIP 文件',buttonLabel:'选择 ZIP 文件',properties:['openFile','dontAddToRecent'],filters:[{name:'ZIP 压缩包',extensions:['zip']}]});
        return{ok:true,value:result.canceled?null:result.filePaths[0]||null};
      }
      if(!service){
        throw new Error('本地资料暂时无法读取，仍可复制请求。'+(serviceError||''));
      }
      return{ok:true,value:await service.command(action,input)};
    }catch(error){return{ok:false,error:error.message||'这项操作没有完成；其他页面仍可用。'};}
  });
  const root=realpathSync(join(__dirname,'../dashboard/dist'));
  protocol.handle('ai-carry',request=>{
    try{
      const url=new URL(request.url);
      if(url.hostname!=='pages'||!['GET','HEAD'].includes(request.method))return new Response('Not allowed',{status:403});
      const target=realpathSync(resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname)));
      if(!target.startsWith(root+sep))return new Response('Not allowed',{status:403});
      return net.fetch(pathToFileURL(target).href);
    }catch{return new Response('Local resource not found',{status:404});}
  });
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_r,done)=>done({cancel:true}));
  session.defaultSession.setPermissionRequestHandler((_w,_p,done)=>done(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  session.defaultSession.on('will-download',event=>event.preventDefault());
  win=new BrowserWindow({width:1480,height:970,minWidth:1000,minHeight:700,show:false,backgroundColor:'#f6f7f4',title:'AI Carry · 客户端',icon:applicationIcon.isEmpty()?undefined:applicationIcon,autoHideMenuBar:true,webPreferences:{preload:join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:!process.argv.includes('--capture')&&!process.argv.includes('--headless-check')}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('ai-carry://pages/'))event.preventDefault();});
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  win.once('ready-to-show',()=>{if(!process.argv.includes('--headless-check'))process.argv.includes('--capture')?win.showInactive():win.show();});
  win.loadURL('ai-carry://pages/index.html');
});
app.on('window-all-closed',()=>app.quit());
