import {createContext,useCallback,useContext,useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {normalizeSnapshot} from '../lib/data';
import {inspectDashboardIdentity,syncDashboardIdentity} from '../lib/identity';

export type AssistantBinding={root:string;instanceId:string;name:string;synthetic:boolean};
export type Asset={id:string;title:string;summary:string;triggers?:string[];state?:string;maturity?:string;reliability?:string;approval_state?:string;approved_by_user?:boolean;activation_basis?:string;[key:string]:any};
export type AssistantData={demo?:boolean;binding:AssistantBinding;startup:Record<string,unknown>;snapshot:{profile:{display_name:string;learning_policy:string};meta:{state:string;product_version:string;identity_ref?:string};health?:{summary:string;next_step:string};memories:Asset[];sops:Asset[];capabilities:Asset[];experiences:Asset[];evolution:Asset[];governance:Asset[];todo:Asset[];skills:{items?:Asset[];exports?:Asset[]}}};
export type AssistantSource=AssistantBinding&{itemId?:string};
declare global{interface Window{carryClient?:{invoke:(action:string,input?:unknown)=>Promise<{ok:boolean;value?:any;error?:string}>;subscribe?:(callback:()=>void)=>()=>void};AI_CARRY_SNAPSHOT?:any;AGENT_CARRY_SNAPSHOT?:any;AI_CARRY_DEMO?:boolean;AGENT_CARRY_DEMO?:boolean}}
type ContextValue={assistant:AssistantData|null;demo:boolean;dataLoading:boolean;dataError:string;refreshData:()=>Promise<void>;chooseAssistant:()=>Promise<void>;act:(action:string,input?:any)=>Promise<any>;source:(itemId?:string)=>AssistantSource|undefined};
const Context=createContext<ContextValue|null>(null);
function webData():AssistantData{
  const raw=window.AI_CARRY_SNAPSHOT??window.AGENT_CARRY_SNAPSHOT;
  if(!raw?.meta||!raw?.profile)throw new Error('没有读到看板资料。仍可复制请求，让 Agent 从助手目录重新生成看板。');
  const snapshot=normalizeSnapshot(raw),demo=window.AI_CARRY_DEMO===true||window.AGENT_CARRY_DEMO===true;
  const identity=inspectDashboardIdentity({demoMode:demo,state:snapshot.meta.state,displayName:snapshot.profile.display_name,version:snapshot.meta.product_version,identityRef:snapshot.meta.identity_ref,href:location.href});
  document.title=identity.title;
  // An old bookmark is a local navigation issue, never a whole-assistant stop.
  syncDashboardIdentity(identity);
  return{snapshot,demo,startup:{},binding:{root:'',instanceId:snapshot.meta.state==='template'?'template':'',name:snapshot.profile.display_name,synthetic:demo}};
}
function reloadWebSnapshot(){return new Promise<void>((resolve,reject)=>{
  const script=document.createElement('script');script.src=new URL('./snapshot.js?read='+Date.now(),location.href).href;
  const finish=(error?:Error)=>{clearTimeout(timer);script.remove();error?reject(error):resolve();};
  const timer=setTimeout(()=>finish(new Error('本次没有读到新资料，原有内容仍可查看。可以重试，或请 Agent 重新生成看板。')),5000);
  script.onload=()=>finish();script.onerror=()=>finish(new Error('本次重新读取失败。原有内容仍可查看；请确认本地 snapshot.js 仍在。'));document.head.appendChild(script);
});}
export function ClientProvider({children}:{children:ReactNode}){
  const [assistant,setAssistant]=useState<AssistantData|null>(null),[dataLoading,setLoading]=useState(false),[dataError,setError]=useState('');
  const sequence=useRef(0),alive=useRef(true),choosing=useRef(false);
  const act=useCallback(async(action:string,input?:any)=>{
    if(window.carryClient){const result=await window.carryClient.invoke(action,input);if(!result.ok)throw new Error(result.error||'这项操作没有完成，其他页面仍可用。');return result.value;}
    if(action==='assistant-data')return webData();
    if(action==='refresh-data'){await reloadWebSnapshot();return webData();}
    if(action==='assistant-entry'){
      const s=webData().snapshot;const item=[...s.memories,...s.sops,...s.capabilities,...s.experiences].find(row=>row.id===input?.id);
      if(!item)throw new Error('这条记录不在当前快照中。可以重新读取，或让 Agent 按条目找到原资料。');
      return{body:item.body||item.summary||'网页保存的是摘要。让 Agent 读取这条记录，可查看完整正文。'};
    }
    if(action==='copy'){
      if(navigator.clipboard){await navigator.clipboard.writeText(input.text);return true;}
      throw new Error('浏览器不允许自动复制，请选中全文后手动复制。');
    }
    if(action==='choose-skill-source')throw new Error('浏览器不能取得完整本机路径。请粘贴路径，或用桌面客户端旁边的文件夹按钮选择。');
    throw new Error('网页版使用当前目录的资料。要查看另一份助手，请打开那份助手的网页入口。');
  },[]);
  const load=useCallback(async(action:string)=>{
    const serial=++sequence.current;setLoading(true);
    try{const value=await act(action);if(alive.current&&serial===sequence.current){if(value?.snapshot)value.snapshot=normalizeSnapshot(value.snapshot);setAssistant(value);setError('');}}
    catch(e){if(alive.current&&serial===sequence.current)setError((e as Error).message);}
    finally{if(alive.current&&serial===sequence.current)setLoading(false);}
  },[act]);
  const refreshData=useCallback(()=>choosing.current?Promise.resolve():load(window.carryClient?'assistant-data':'refresh-data'),[load]);
  const chooseAssistant=useCallback(async()=>{if(choosing.current)return;choosing.current=true;try{await load('choose-assistant');}finally{choosing.current=false;}},[load]);
  useEffect(()=>{alive.current=true;void load('assistant-data');const focus=()=>{if(window.carryClient)void refreshData();};addEventListener('focus',focus);const unsubscribe=window.carryClient?.subscribe?.(focus);return()=>{alive.current=false;sequence.current++;unsubscribe?.();removeEventListener('focus',focus);};},[load,refreshData]);
  const demo=assistant?.demo===true;
  const source=(itemId?:string):AssistantSource|undefined=>assistant&&!demo?{...assistant.binding,...(itemId?{itemId}:{})}:undefined;
  return <Context.Provider value={{assistant,demo,dataLoading,dataError,refreshData,chooseAssistant,act,source}}>{children}</Context.Provider>;
}
export function useClient(){const value=useContext(Context);if(!value)throw new Error('Missing client state owner');return value;}
