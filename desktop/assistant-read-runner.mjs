import {Worker} from 'node:worker_threads';

// Only trusted product code runs here; never import code from an assistant root.
export function createReadRunner({timeoutMs=20000,workerURL=new URL('./assistant-read-worker.mjs',import.meta.url)}={}) {
  const workers=new Set();let disposed=false;
  function start(job) {
    if(disposed)throw Error('窗口正在关闭，请重新打开 AI Carry。');
    if(workers.size>=3)throw Error('上次读取还在结束，请稍后点“重新读取”。现有资料仍保留。');
    const worker=new Worker(workerURL,{workerData:job});workers.add(worker);
    let settled=false,timer,rejectJob;
    const finish=(resolve,reject,error,value)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      error?reject(error):resolve(value);
      void worker.terminate().catch(()=>{});
    };
    const promise=new Promise((resolve,reject)=>{
      rejectJob=error=>finish(resolve,reject,error);
      worker.once('message',result=>{
        if(!result||result.ok!==true)return finish(resolve,reject,Error(result?.error||'没有读到完整资料。请重试，原资料没有改动。'));
        finish(resolve,reject,null,result.value);
      });
      worker.once('error',()=>finish(resolve,reject,Error('读取暂时中断。请点“重新读取”，原资料没有改动。')));
      worker.once('exit',()=>{
        workers.delete(worker);
        if(!settled)finish(resolve,reject,Error('读取提前结束，没有替换当前资料。请重试。'));
      });
      timer=setTimeout(()=>finish(resolve,reject,Error('读取时间较长，已停止本次尝试。可以点“重新读取”；原资料没有改动。')),timeoutMs);
    });
    const cancel=()=>rejectJob(Error('已停止旧的读取请求，请查看当前选择的助手。'));
    worker.cancel=cancel;
    return{promise,cancel};
  }
  return{start,dispose(){disposed=true;for(const worker of workers)worker.cancel();}};
}
