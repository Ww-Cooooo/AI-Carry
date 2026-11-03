import React,{Component,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowRight,Archive,Backpack,CheckSquare2,ChevronRight,Download,HelpCircle,Layers,RefreshCw,Settings} from 'lucide-react';
import LibraryPage from './LibraryPage';
import Workshop from './Workshop';
import Growth from './Growth';
import Transfer from './Transfer';
import Onboarding from './Onboarding';
import Status from './Status';
import HelpPage from './HelpPage';
import {SourceText} from './SourceText';
import {LocaleRoot,useDashboardLocale} from '../lib/i18n';
import {type Ask,type Request,RequestDialog,AssistantNotice} from './shared';
import {ClientProvider,useClient} from './client-state';
import './pages.css';
import './integrated.css';
type Route='home'|'library'|'workshop'|'growth'|'transfer'|'system'|'create'|'status';
const routes=[{id:'library',label:'我的积累',Icon:Layers},{id:'growth',label:'待办',Icon:CheckSquare2},{id:'workshop',label:'导入与分享',Icon:Download},{id:'transfer',label:'备份与迁移',Icon:Archive}] as const;
const names:Record<Route,string>={home:'欢迎使用',library:'我的积累',workshop:'导入与分享',growth:'待办',transfer:'备份与迁移',system:'帮助',create:'创建助手',status:'设置'};
function readRoute():Route{const name=location.hash.slice(1).split('?')[0];return name in names?name as Route:'home';}
function Home({go}:{go:(r:Route)=>void}){
  const {assistant,dataError,dataLoading,chooseAssistant}=useClient();
  return <main id="main-content" className="welcome-page" tabIndex={-1}><div className="welcome-mark"><Backpack size={45} strokeWidth={1.5}/></div><h1>{dataLoading&&!assistant?'正在读取助手资料':dataError?'先找回你的助手资料':assistant?.snapshot.meta.state==='instance'?'接着用你的积累':'让积累，跟着你走。'}</h1><p>{assistant?.snapshot.meta.state==='instance'?'你的习惯、记忆和常用方法，都可以继续使用。':'保存你的习惯和常用方法，换 Agent 也能接着用。'}</p>{dataError?<AssistantNotice/>:<div className="welcome-actions">{!dataLoading&&<button className="primary-button" onClick={()=>go(assistant?.snapshot.meta.state==='instance'?'library':'create')}>{assistant?.snapshot.meta.state==='instance'?'查看我的积累':'开始设置'}<ArrowRight size={18}/></button>}{window.carryClient&&<button className="secondary-button" onClick={()=>void chooseAssistant()}>打开已有助手</button>}</div>}<button className="text-button" onClick={()=>go('system')}><HelpCircle size={16}/>了解怎样使用</button></main>;
}
class PageBoundary extends Component<{children:React.ReactNode;go:()=>void;help:()=>void},{failed:boolean}>{
  state={failed:false};static getDerivedStateFromError(){return{failed:true};}
  render(){return this.state.failed?<main id="main-content" className="empty-state"><h1>这一页暂时没能打开</h1><p>可以重试这一页，或先查看其他内容。</p><div className="empty-actions"><button className="primary-button" onClick={()=>this.setState({failed:false})}>重试本页<RefreshCw size={17}/></button><button className="secondary-button" onClick={this.props.go}>返回我的积累</button><button className="text-button" onClick={this.props.help}>查看处理方法<HelpCircle size={17}/></button></div></main>:this.props.children;}
}
function App(){
  const {locale,setLocale}=useDashboardLocale(),{assistant,demo,source,dataLoading,dataError,refreshData}=useClient();
  const [route,setRoute]=useState<Route>(readRoute),[request,setRequest]=useState<Request|null>(null);
  const lastLibrary=useRef('#library'),identity=JSON.stringify([assistant?.binding.root,assistant?.binding.instanceId,assistant?.snapshot.meta.identity_ref]),bound=useRef(identity);
  const ask:Ask=value=>setRequest({...value,assistant:route==='create'&&assistant?.snapshot.meta.state!=='template'?undefined:source(value.itemId)});
  useEffect(()=>{if(window.carryClient)document.title=assistant?.snapshot.profile.display_name?assistant.snapshot.profile.display_name+' · AI Carry':'AI Carry';},[assistant?.snapshot.profile.display_name]);
  useEffect(()=>{setRequest(null);if(bound.current!==identity){lastLibrary.current='#library';bound.current=identity;}},[identity]);
  useEffect(()=>{if(!location.hash&&!dataLoading&&assistant)setRoute(assistant.snapshot.meta.state==='instance'?'library':'home');},[assistant,dataLoading]);
  useEffect(()=>{const update=()=>{setRoute(readRoute());setRequest(null);if(location.hash.startsWith('#library'))lastLibrary.current=location.hash;};addEventListener('hashchange',update);return()=>removeEventListener('hashchange',update);},[]);
  const go=(r:Route)=>{const hash=r==='library'?lastLibrary.current:'#'+r;if(location.hash===hash)setRoute(r);else location.hash=hash;};
  return <div className="client-app integrated-app"><a className="skip-link" href="#main-content" onClick={e=>{e.preventDefault();document.getElementById('main-content')?.focus();}}>跳到主要内容</a>
    <aside className="carry-sidebar"><button className="carry-brand" onClick={()=>go(assistant?.snapshot.meta.state==='instance'?'library':'home')} aria-label="AI Carry 首页"><span><Backpack size={25}/></span>AI Carry</button>
      <nav aria-label="主要导航">{routes.map(r=><button key={r.id} className={route===r.id?'current':''} aria-current={route===r.id?'page':undefined} onClick={()=>go(r.id)}><r.Icon size={20}/><span>{r.label}</span>{r.id==='growth'&&!!assistant?.snapshot.todo.length&&<small>{assistant.snapshot.todo.length}</small>}</button>)}</nav>
      <div className="sidebar-bottom"><button className="assistant-identity" onClick={()=>go('status')}><Backpack size={26}/><span><strong><SourceText>{assistant?.snapshot.profile.display_name||'AI Carry 助手'}</SourceText></strong><small>{demo?'示例资料':assistant?.snapshot.meta.state==='template'?'尚未创建助手':assistant?'本机资料':'尚未读取资料'}</small></span></button><div className="sidebar-tools"><button onClick={()=>go('status')} aria-current={route==='status'?'page':undefined}><Settings size={17}/>设置</button><button onClick={()=>go('system')} aria-current={route==='system'?'page':undefined}><HelpCircle size={17}/>帮助</button></div></div>
    </aside><div className="carry-workspace"><header className="carry-topbar"><div className="breadcrumbs"><SourceText>{assistant?.snapshot.profile.display_name||'AI Carry'}</SourceText><ChevronRight size={14}/><strong>{names[route]}</strong></div><div className="carry-top-actions"><span className={'read-status'+(dataError?' has-error':'')}>{demo?'示例资料':dataLoading?'正在读取…':dataError?'资料待检查':'只读查看'}</span><button className="icon-control" onClick={()=>void refreshData()} disabled={dataLoading} aria-label="重新读取资料" title="重新读取资料"><RefreshCw size={17} className={dataLoading?'spin':''}/></button><button className="language-button" onClick={()=>setLocale(locale==='en'?'zh-Hans':'en')} aria-label="中文 / English">{locale==='en'?'中':'EN'}</button></div></header>
      <div className="client-body"><PageBoundary key={route+'|'+identity} go={()=>go('library')} help={()=>go('system')}>{route==='home'?<Home go={go}/>:route==='library'?<div className="library-embed"><LibraryPage ask={ask}/></div>:route==='workshop'?<Workshop ask={ask}/>:route==='growth'?<Growth ask={ask}/>:route==='transfer'?<Transfer ask={ask}/>:route==='create'?<Onboarding ask={ask} home={()=>go('home')}/>:route==='status'?<Status ask={ask}/>:<HelpPage ask={ask}/>}</PageBoundary></div>
      <footer className="carry-footer"><span>{demo?'当前使用示例资料，操作不会修改真实助手。':'这里查看已保存的资料；操作请求交给 Agent 执行。'}</span><button onClick={()=>go('system')}>使用说明<ChevronRight size={12}/></button></footer>
    </div><RequestDialog request={request} onClose={()=>setRequest(null)}/>
  </div>;
}
createRoot(document.getElementById('root')!).render(<LocaleRoot>{locale=><ClientProvider key={locale}><App/></ClientProvider>}</LocaleRoot>);
