import {Fragment,createContext,useCallback,useContext,useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {normalizeSnapshot} from '../lib/data';
import {inspectDashboardIdentity,syncDashboardIdentity} from '../lib/identity';

export type AssistantBinding={root:string;instanceId:string;name:string;synthetic:boolean;entryMismatch?:boolean};
export type Asset={id:string;title:string;summary:string;triggers?:string[];state?:string;maturity?:string;reliability?:string;approval_state?:string;approved_by_user?:boolean;activation_basis?:string;[key:string]:any};
export type AssistantData={demo?:boolean;readState?:'stale';readError?:string;binding:AssistantBinding;startup:Record<string,unknown>;snapshot:{profile:{display_name:string;learning_policy:string};meta:{state:string;product_version:string;identity_ref?:string};health?:{summary:string;next_step:string};memories:Asset[];sops:Asset[];capabilities:Asset[];experiences:Asset[];evolution:Asset[];governance:Asset[];todo:Asset[];skills:{items?:Asset[];exports?:Asset[]};accumulation?:unknown}};
export type AssistantSource=AssistantBinding&{itemId?:string};
declare global{interface Window{carryClient?:{invoke:(action:string,input?:unknown)=>Promise<{ok:boolean;value?:any;error?:string}>;subscribe?:(callback:()=>void)=>()=>void};AI_CARRY_SNAPSHOT?:any;AGENT_CARRY_SNAPSHOT?:any;AI_CARRY_DEMO?:boolean;AGENT_CARRY_DEMO?:boolean}}
type ContextValue={assistant:AssistantData|null;demo:boolean;dataLoading:boolean;dataError:string;refreshData:()=>Promise<void>;chooseAssistant:()=>Promise<void>;act:(action:string,input?:any)=>Promise<any>;source:(itemId?:string)=>AssistantSource|undefined};
const Context=createContext<ContextValue|null>(null);
const readTimeout=25000;
function bounded<T>(work:Promise<T>,milliseconds:number,message:string):Promise<T>{
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(message)),milliseconds);
    work.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
}
function identity(value:AssistantData|null){return value?JSON.stringify([value.binding.root,value.binding.instanceId,value.snapshot.meta.identity_ref||'']):'';}
function usableData(value:any):value is AssistantData{
  const snapshot=value?.snapshot;
  return typeof value?.binding?.root==='string'&&typeof value?.binding?.instanceId==='string'
    &&(!window.carryClient||(value.binding.root.length>0&&value.binding.instanceId.length>0))
    &&['template','instance'].includes(snapshot?.meta?.state)&&typeof snapshot?.profile?.display_name==='string'
    &&['memories','sops','capabilities','experiences','evolution','governance','todo'].every(key=>Array.isArray(snapshot[key]))
    &&snapshot.skills&&typeof snapshot.skills==='object';
}
function webData():AssistantData{
  const raw=window.AI_CARRY_SNAPSHOT??window.AGENT_CARRY_SNAPSHOT;
  if(!raw?.meta||!raw?.profile)throw new Error('没有读到看板资料。仍可复制请求，让 Agent 从助手目录重新生成看板。');
  const snapshot=normalizeSnapshot(raw),demo=window.AI_CARRY_DEMO===true||window.AGENT_CARRY_DEMO===true;
  const identity=inspectDashboardIdentity({demoMode:demo,state:snapshot.meta.state,displayName:snapshot.profile.display_name,version:snapshot.meta.product_version,identityRef:snapshot.meta.identity_ref,href:location.href});
  document.title=identity.title;
  // An old bookmark is a local navigation issue, never a whole-assistant stop.
  syncDashboardIdentity(identity);
  return{snapshot,demo,startup:{},binding:{root:'',instanceId:snapshot.meta.state==='template'?'template':'',name:snapshot.profile.display_name,synthetic:demo,entryMismatch:identity.mismatch}};
}
let webReload:Promise<void>|null=null;
function reloadWebSnapshot(){
  if(webReload)return webReload;
  webReload=new Promise<void>((resolve,reject)=>{
    const previous=window.AI_CARRY_SNAPSHOT,legacy=window.AGENT_CARRY_SNAPSHOT;
    const script=document.createElement('script');script.src=new URL('./snapshot.js?read='+Date.now(),location.href).href;
    let finished=false;
    const finish=(error?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);script.onload=null;script.onerror=null;script.remove();if(error){window.AI_CARRY_SNAPSHOT=previous;window.AGENT_CARRY_SNAPSHOT=legacy;reject(error);}else resolve();};
    const timer=setTimeout(()=>finish(new Error('本次没有读到新资料，原有内容仍可查看。可以重试，或请 Agent 重新生成看板。')),5000);
    script.onload=()=>{
      const fresh=window.AI_CARRY_SNAPSHOT??window.AGENT_CARRY_SNAPSHOT;
      if(!fresh?.meta||!fresh?.profile||(window.AI_CARRY_SNAPSHOT===previous&&window.AGENT_CARRY_SNAPSHOT===legacy)){
        finish(new Error('本次没有读到有效的新资料，仍显示上次读取的内容。请让 Agent 检查看板快照，再重新读取。'));return;
      }
      finish();
    };
    script.onerror=()=>finish(new Error('本次重新读取失败。原有内容仍可查看；请确认本地 snapshot.js 仍在。'));document.head.appendChild(script);
  }).finally(()=>{webReload=null;});
  return webReload;
}
export function ClientProvider({children}:{children:ReactNode}){
  const [assistant,setAssistant]=useState<AssistantData|null>(null),[dataLoading,setLoading]=useState(false),[dataError,setError]=useState('');
  const sequence=useRef(0),alive=useRef(true),choosing=useRef(false);
  const current=useRef<AssistantData|null>(null),entrySequence=useRef(0),refreshWork=useRef<Promise<void>|null>(null),refreshQueued=useRef(false);
  const act=useCallback(async(action:string,input?:any)=>{
    if(window.carryClient){
      const entry=action==='assistant-entry',serial=entry?++entrySequence.current:0,source=current.current,key=identity(source);
      const payload=entry?{...input,expectedRoot:source?.binding.root,expectedInstanceId:source?.binding.instanceId}:input;
      const invocation=window.carryClient.invoke(action,payload);
      // A native file dialog is waiting for the person's choice, not a read.
      // Once a folder is chosen, the main-process reader has its own deadline.
      const result=['choose-assistant','choose-skill-source'].includes(action)?await invocation
        :await bounded(invocation,['assistant-data','assistant-entry'].includes(action)?readTimeout:10000,
          entry?'这条内容还没读完。请重新打开；其他资料仍可查看。':'本次操作等待较久，请重试。之前可用的资料仍保留。');
      if(entry&&(!alive.current||serial!==entrySequence.current||key!==identity(current.current)))throw new Error('当前查看的内容已变化，请重新打开要看的条目。');
      if(!result?.ok)throw new Error(result?.error||'这项操作没有完成，其他页面仍可用。');
      return result.value;
    }
    if(action==='assistant-data')return webData();
    if(action==='refresh-data'){await reloadWebSnapshot();return webData();}
    if(action==='assistant-entry'){
      const s=(current.current||webData()).snapshot;const item=[...s.memories,...s.sops,...s.capabilities,...s.experiences].find(row=>row.id===input?.id);
      if(!item)throw new Error('这条记录不在当前快照中。可以重新读取，或让 Agent 按条目找到原资料。');
      return{body:item.body||item.summary||'网页保存的是摘要。让 Agent 读取这条记录，可查看完整正文。'};
    }
    if(action==='copy'){
      if(navigator.clipboard){await navigator.clipboard.writeText(input.text);return true;}
      throw new Error('浏览器不允许自动复制，请选中全文后手动复制。');
    }
    if(action==='choose-skill-source')throw new Error('浏览器不能取得完整本机路径。请粘贴路径，或用桌面客户端旁边的文件夹按钮选择。');
    if(action==='reload-window'){location.reload();return true;}
    throw new Error('网页版使用当前目录的资料。要查看另一份助手，请打开那份助手的网页入口。');
  },[]);
  const load=useCallback(async(action:string)=>{
    const serial=++sequence.current;setLoading(true);
    try{
      const value=await act(action);
      if(!alive.current||serial!==sequence.current||value?.cancelled===true)return;
      if(value===null&&!current.current){setAssistant(null);setError('');return;}
      if(!usableData(value))throw new Error('没有读到完整的助手资料。请重新读取；之前的内容仍保留。');
      value.snapshot=normalizeSnapshot(value.snapshot);
      current.current=value;setAssistant(value);
      setError(value.readState==='stale'?`仍显示上次读到的资料。${value.readError||'本次读取没有完成，请重试。'}`
        :value.binding.entryMismatch?'入口标识与当前资料不一致。资料仍可查看；执行请求前，请让 Agent 核对助手目录与实例。':'');
    }
    catch(e){if(alive.current&&serial===sequence.current)setError((e as Error).message);}
    finally{if(alive.current&&serial===sequence.current)setLoading(false);}
  },[act]);
  const refreshData=useCallback(()=>{
    if(choosing.current){refreshQueued.current=true;return Promise.resolve();}
    if(refreshWork.current)return refreshWork.current;
    const work=load(window.carryClient?'assistant-data':current.current?'refresh-data':'assistant-data')
      .finally(()=>{if(refreshWork.current===work)refreshWork.current=null;});
    refreshWork.current=work;return work;
  },[load]);
  const chooseAssistant=useCallback(async()=>{
    if(choosing.current)return;choosing.current=true;
    try{await load('choose-assistant');}
    finally{choosing.current=false;if(refreshQueued.current){refreshQueued.current=false;refreshWork.current=null;void refreshData();}}
  },[load,refreshData]);
  useEffect(()=>{alive.current=true;void refreshData();const focus=()=>{if(window.carryClient)void refreshData();};addEventListener('focus',focus);const unsubscribe=window.carryClient?.subscribe?.(focus);return()=>{alive.current=false;sequence.current++;entrySequence.current++;refreshWork.current=null;unsubscribe?.();removeEventListener('focus',focus);};},[refreshData]);
  const demo=assistant?.demo===true;
  const source=(itemId?:string):AssistantSource|undefined=>assistant&&!demo?{...assistant.binding,...(itemId?{itemId}:{})}:undefined;
  return <Context.Provider value={{assistant,demo,dataLoading,dataError,refreshData,chooseAssistant,act,source}}><Fragment key={identity(assistant)}>{children}</Fragment></Context.Provider>;
}
export function useClient(){const value=useContext(Context);if(!value)throw new Error('Missing client state owner');return value;}
