import {mkdir,readFile,rename,writeFile,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {createReadRunner} from './assistant-read-runner.mjs';

// Local data only: no receiver, network listener, Agent process or task queue.
export function createManualClient({stateDirectory,chooseDirectory,initialRoot,reader=createReadRunner()}) {
  const file=path.join(stateDirectory,'assistant.json');
  let binding=null,configuredRoot=initialRoot?path.resolve(initialRoot):null,lastData=null;
  let ready,revision=0,selectionRequest=0,pendingRead,pendingEntry,pendingChoice;
  let commit=Promise.resolve(),disposed=false;
  const stopped=()=>Error('助手选择已经变化，请重新读取当前助手。');
  const assertLive=()=>{if(disposed)throw Error('窗口正在关闭，请重新打开 AI Carry。');};
  async function initialize() {
    if(!ready)ready=(async()=>{
      if(configuredRoot)return;
      let stored;
      try{stored=JSON.parse(await readFile(file,'utf8'));}
      catch(error){
        if(error.code!=='ENOENT')throw Error('没能读到上次选择的助手。请重新选择文件夹；原资料没有改动。');
        try{stored=JSON.parse(await readFile(path.join(stateDirectory,'initial-root.json'),'utf8'));}
        catch(other){if(other.code==='ENOENT')return;throw Error('没能读到安装时的助手位置，请重新选择文件夹。');}
      }
      if(typeof stored?.root!=='string'||!stored.root.trim())throw Error('上次保存的助手位置不完整，请重新选择文件夹。');
      configuredRoot=path.resolve(stored.root);
      if(typeof stored.instanceId==='string'&&stored.instanceId)binding={root:configuredRoot,instanceId:stored.instanceId,name:stored.name||path.basename(configuredRoot),synthetic:false};
    })();
    return ready;
  }
  function cancelReads(){pendingRead?.handle.cancel();pendingEntry?.handle.cancel();pendingRead=null;pendingEntry=null;}
  function usable(data){return data&&data.snapshot&&data.binding?.root&&data.binding?.instanceId;}
  async function read() {
    await initialize();assertLive();
    if(!configuredRoot)return null;
    if(pendingRead)return pendingRead.promise;
    const generation=revision;
    const retain=error=>{
      assertLive();if(generation!==revision)throw stopped();
      if(lastData&&lastData.binding.root===configuredRoot&&lastData.binding.instanceId===binding?.instanceId)
        return{...lastData,readState:'stale',readError:error.message||'本次读取失败，仍显示上次读到的资料。'};
      throw error;
    };
    let handle;try{handle=reader.start({type:'snapshot',root:configuredRoot,binding});}catch(error){return retain(error);}
    const pending={handle};
    pending.promise=handle.promise.then(data=>{
      assertLive();if(generation!==revision)throw stopped();
      if(!usable(data))throw Error('没有读到完整资料，仍保留之前的内容。请重试。');
      binding=data.binding;configuredRoot=binding.root;lastData=data;return data;
    }).catch(retain).finally(()=>{if(pendingRead===pending)pendingRead=null;});
    pendingRead=pending;return pending.promise;
  }
  async function selectRoot(directory) {
    // A completed local commit precedes the next choice. Long validation reads
    // are cancellable; no older read may commit after a newer selection starts.
    await commit;assertLive();
    // A corrupt saved preference must not prevent an explicit folder choice.
    try{await initialize();}catch{/* keep the original preference on failure */}
    const request=++selectionRequest;++revision;cancelReads();
    const handle=reader.start({type:'snapshot',root:directory});
    const pending={handle};pendingRead=pending;
    pending.promise=(async()=>{
      const data=await handle.promise;
      assertLive();if(request!==selectionRequest)throw stopped();
      if(!usable(data))throw Error('没有读到新助手的完整资料，原来的选择仍保留。');
      const save=async()=>{
        const temporary=path.join(stateDirectory,`assistant.${randomUUID()}.tmp`);
        try{
          await mkdir(stateDirectory,{recursive:true});
          await writeFile(temporary,JSON.stringify(data.binding,null,2),{flag:'wx'});
          assertLive();if(request!==selectionRequest)throw stopped();
          await rename(temporary,file);
          binding=data.binding;configuredRoot=binding.root;lastData=data;ready=Promise.resolve();
        }finally{await unlink(temporary).catch(()=>{});}
      };
      commit=save();await commit;return data;
    })().finally(()=>{if(pendingRead===pending)pendingRead=null;});
    // Keep a rejected commit from blocking a later, explicit retry.
    try{return await pending.promise;}finally{commit=commit.catch(()=>{});}
  }
  async function entry(input) {
    await initialize();assertLive();
    if(!binding)await read();
    if(!binding)throw Error('请先选择要查看的助手。');
    if((input.expectedRoot!==undefined||input.expectedInstanceId!==undefined)
      &&(input.expectedRoot!==binding.root||input.expectedInstanceId!==binding.instanceId))throw stopped();
    const generation=revision,selected=binding;
    pendingEntry?.handle.cancel();
    const handle=reader.start({type:'entry',binding:selected,id:input.id});const pending={handle};pendingEntry=pending;
    try{
      const value=await handle.promise;assertLive();
      if(generation!==revision||pendingEntry!==pending||selected.root!==binding?.root||selected.instanceId!==binding?.instanceId)throw stopped();
      return value;
    }finally{if(pendingEntry===pending)pendingEntry=null;}
  }
  return {
    selectRoot,
    ready:initialize,
    getSelectedRoot(){return configuredRoot;},
    dispose(){disposed=true;++revision;++selectionRequest;cancelReads();reader.dispose();},
    async command(action,input={}) {
      assertLive();
      if(action==='assistant-data')return read();
      if(action==='assistant-entry')return entry(input);
      if(action==='choose-assistant') {
        if(pendingChoice)return pendingChoice;
        pendingChoice=(async()=>{
          const directory=await chooseDirectory();
          if(!directory)return{cancelled:true};
          return selectRoot(directory);
        })().finally(()=>{pendingChoice=null;});
        return pendingChoice;
      }
      throw Error('请复制请求后发给 Agent。客户端不会连接 Agent 或直接执行这项任务。');
    },
  };
}
