import {parentPort,workerData} from 'node:worker_threads';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {readAssistantData,readAssistantEntry} from './assistant-data.mjs';
import {buildVerifiedStartupProjection} from '../dashboard/scripts/query-startup-capsule.mjs';

try {
  let value;
  if(workerData.type==='snapshot') {
    let binding=workerData.binding;
    if(!binding?.instanceId) {
      const root=realpathSync(workerData.root),startup=buildVerifiedStartupProjection(root);
      if(!startup.instance_id)throw Error('这个文件夹没有可读取的 AI Carry 身份；原来的选择仍保留。');
      binding={root,instanceId:startup.instance_id,name:path.basename(root),synthetic:false};
    }
    value=readAssistantData(binding,{localRead:true});
  } else if(workerData.type==='entry') {
    value=readAssistantEntry(workerData.binding,workerData.id,{localRead:true});
  } else throw Error('没有执行未知的读取请求。');
  parentPort.postMessage({ok:true,value});
} catch(error) {
  parentPort.postMessage({ok:false,error:error.message||'资料暂时无法读取。请重试，原资料没有改动。'});
} finally {parentPort.close();}
