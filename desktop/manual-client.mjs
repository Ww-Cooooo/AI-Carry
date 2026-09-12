import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readAssistantData, readAssistantEntry } from './assistant-data.mjs';
import { buildVerifiedStartupProjection } from '../dashboard/scripts/query-startup-capsule.mjs';

// Local data only: no receiver, network listener, Agent process or task queue.
export function createManualClient({ stateDirectory, chooseDirectory, initialRoot }) {
  const file = path.join(stateDirectory, 'assistant.json');
  function selected() {
    // Only an explicit local folder choice belongs to this client.
    // Old connection experiments must never select an assistant implicitly.
    const installed = path.join(stateDirectory, 'initial-root.json');
    if (!initialRoot && !existsSync(file) && existsSync(installed)) initialRoot = JSON.parse(readFileSync(installed, 'utf8')).root;
    if (initialRoot) { const root = realpathSync(initialRoot); const startup = buildVerifiedStartupProjection(root); return {root, instanceId:startup.instance_id, name:path.basename(root), synthetic:false}; }
    if(!existsSync(file))return null;
    const stored=JSON.parse(readFileSync(file,'utf8'));
    const root=realpathSync(stored.root),startup=buildVerifiedStartupProjection(root);
    return{...stored,root,instanceId:startup.instance_id};
  }
  const read = binding => binding ? readAssistantData(binding, { localRead: true }) : null;
  async function selectRoot(directory){
    const root=realpathSync(directory),startup=buildVerifiedStartupProjection(root);
    if(!startup.instance_id)throw Error('这个文件夹没有可读取的 AI Carry 身份；原来的选择仍保留。');
    const binding={root,instanceId:startup.instance_id,name:path.basename(root),synthetic:false};
    const data=read(binding);binding.name=data.snapshot.profile.display_name||binding.name;
    mkdirSync(stateDirectory,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(binding,null,2));renameSync(file+'.tmp',file);
    initialRoot=root;return data;
  }
  return {
    selectRoot,
    async command(action, input = {}) {
      if (action === 'assistant-data') return read(selected());
      if (action === 'assistant-entry') return readAssistantEntry(selected(), input.id, { localRead: true });
      if (action === 'choose-assistant') {
        const directory = await chooseDirectory();
        if (!directory) return read(selected());
        return selectRoot(directory);
      }
      throw new Error('请复制请求后发给 Agent。客户端不会连接 Agent 或直接执行这项任务。');
    },
  };
}
