// Native recovery stays in the main process; a frozen renderer cannot host it.
function attachWindowRecovery({window,dialog,openWeb}) {
  const contents=window.webContents;
  let showing=false,reloadTimer,hung=false,expectedCrash=false;
  const available=()=>!window.isDestroyed()&&!contents.isDestroyed();
  const failed=async error=>{
    if(available())await dialog.showMessageBox(window,{type:'warning',message:'暂时没能恢复窗口',
      detail:`${error.message}\n可以稍后重试，或从助手文件夹打开 dashboard.html。`}).catch(()=>{});
  };
  const loadPage=()=>{if(available())try{contents.reload();}catch(error){void failed(error);}};
  function reload() {
    if(!available())throw Error('这个窗口已经关闭，请重新打开 AI Carry。');
    if(!reloadTimer)reloadTimer=setTimeout(()=>{
      reloadTimer=null;
      if(available()){
        // A busy renderer may not process an ordinary reload. Only that page
        // process is replaced; the main process, binding and cached data stay.
        if(hung&&!contents.isCrashed()){
          expectedCrash=true;hung=false;
          try{contents.forcefullyCrashRenderer();}catch(error){expectedCrash=false;void failed(error);}
          // Reloading before render-process-gone can send the navigation to the
          // dying renderer. The event below starts the replacement page.
          return;
        }
        hung=false;loadPage();
      }
    },50);
    return true;
  }
  async function recover(crashed) {
    if(showing||!available())return;
    showing=true;
    try {
      const {response}=await dialog.showMessageBox(window,{
        type:'warning',title:'恢复 AI Carry 窗口',
        message:crashed?'AI Carry 页面意外退出':'AI Carry 页面暂时没有响应',
        detail:'可以重新载入这个窗口，或打开当前助手的网页版。重新载入不会重启 Agent，也不会清除已保存的资料或上次选择的助手；未提交的页面输入可能需要重新填写。',
        buttons:['重新载入窗口','打开网页版','稍后处理'],defaultId:0,cancelId:2,noLink:true,
      });
      if(!available())return;
      if(response===0)reload();
      if(response===1)await openWeb();
    } catch(error) {
      await failed(error);
    } finally {showing=false;}
  }
  const unresponsive=()=>{hung=true;void recover(false);};
  const responsive=()=>{hung=false;};
  const gone=(_event,details)=>{
    if(expectedCrash){
      expectedCrash=false;
      clearTimeout(reloadTimer);reloadTimer=setTimeout(()=>{reloadTimer=null;loadPage();},0);
      return;
    }
    if(details.reason!=='clean-exit')void recover(true);
  };
  function dispose(){
    clearTimeout(reloadTimer);reloadTimer=null;expectedCrash=false;
    window.removeListener('unresponsive',unresponsive);window.removeListener('responsive',responsive);
    // BrowserWindow.webContents is no longer readable from the closed event.
    // Retain the original object and skip native cleanup once it is destroyed.
    if(!contents.isDestroyed())contents.removeListener('render-process-gone',gone);
  }
  window.on('unresponsive',unresponsive);window.on('responsive',responsive);contents.on('render-process-gone',gone);window.once('closed',dispose);
  return{reload,dispose};
}
module.exports={attachWindowRecovery};
