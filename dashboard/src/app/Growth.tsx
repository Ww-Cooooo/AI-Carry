import {SourceText} from './SourceText';
import {useState} from 'react';
import {ArrowUpRight,ChevronDown,Clock3,Lightbulb,MessageCircle,Repeat2} from 'lucide-react';
import {type Ask,AssistantNotice,Heading,Help,More,Page,Primary,Reveal,SectionTabs} from './shared';
import {useClient} from './client-state';
const groups={todos:{intro:'继续还没完成的任务。',next:'继续这项待办',field:'todo'},learning:{intro:'看看哪些新发现值得记住，或整理成常用方法。',next:'请 Agent 整理这条建议',field:'evolution'},governance:{intro:'定期检查助手的记忆、方法和工作方式。',next:'请 Agent 开始这项改进',field:'governance'}} as const;
export default function Growth({ask}:{ask:Ask}){
  const {assistant}=useClient();
  const [tab,setTab]=useState<keyof typeof groups>('todos'),[open,setOpen]=useState<string|null>(null),[policy,setPolicy]=useState(false);
  const group=groups[tab],items=assistant?.snapshot[group.field]||[],learning=assistant?.snapshot.profile.learning_policy;
  return <Page><Heading title="待办与" accent="成长" action={<button className="secondary-button" onClick={()=>setPolicy(!policy)} aria-expanded={policy}>学习方式<ChevronDown size={17}/></button>}>查看未完成的任务、待整理的新发现，以及助手的改进计划。</Heading>
    <AssistantNotice/>
    {policy&&<Reveal><section className="policy-strip"><div><strong>{learning==='manual-only'?'保存前先询问':learning==='risk-tiered'?'低风险内容可自动保存':assistant?'尚未设置':'先选择助手文件夹'}</strong><p>学习方式决定 Agent 保存新发现前，是否需要先问你。</p></div><Help label="这个学习方式是什么意思？">选择“保存前先询问”，Agent 会先征求你的意见；按风险处理时，已授权的低风险内容可以自动保存。两种方式都会说明记住了什么，已有积累不会被清空。</Help><button className="text-button" disabled={!assistant} onClick={()=>ask({title:'了解并调整学习方式',body:'请先读取并说明这份助手目前的学习方式。用普通话解释会自动做什么、哪些情况需要问我；如果我想调整，再按我的选择修改，不动已有记忆、SOP 和能力。'})}>请 Agent 帮我调整<ArrowUpRight size={17}/></button></section></Reveal>}
    <SectionTabs value={tab} onChange={v=>{setTab(v as keyof typeof groups);setOpen(null);}} label="待办与成长分区" items={[{id:'todos',label:'待办'},{id:'learning',label:'学习建议'},{id:'governance',label:'长期改进'}]}/>
    <div className="growth-intro"><span>{tab==='todos'?<Clock3 size={21}/>:tab==='learning'?<Lightbulb size={21}/>:<Repeat2 size={21}/>}</span><p>{group.intro}</p></div>
    <section className="growth-list">{items.map(item=><article className={`growth-item ${open===item.id?'expanded':''}`} key={item.id}><button className="growth-summary" onClick={()=>setOpen(open===item.id?null:item.id)} aria-expanded={open===item.id}><span className="growth-node">{tab==='todos'?<span/>:tab==='learning'?<Lightbulb size={21}/>:<Repeat2 size={20}/>}</span><span><small>{tab==='governance'?(item.frequency||'已保存的计划'):tab==='learning'?'待整理':'已保存的待办'}</small><strong><SourceText>{item.title}</SourceText></strong><span><SourceText>{item.summary}</SourceText></span></span><span className="view-word">{open===item.id?'收起':'查看详情'}<ChevronDown size={18}/></span></button>{open===item.id&&<Reveal><div className="growth-detail"><div className="reveal-item"><h3>{tab==='todos'?'从这里继续':'具体做什么'}</h3><p>{item.purpose||item.summary}</p>{item.steps&&<ol>{item.steps.map((step:string)=><li key={step}>{step}</li>)}</ol>}<More title="查看依据与范围"><p>记录编号：{item.id}。Agent 会读取这项记录的最新进度，避免从头重做。</p></More></div><div className="reveal-item"><Primary onClick={()=>ask({title:group.next,itemId:item.id,body:`请处理这份助手中「${item.title}」（ID：${item.id}）。先读取这项${tab==='todos'?'待办的已保存进度':tab==='learning'?'学习建议的实际依据':'长期治理任务的计划与范围'}。保留已完成部分，在当前授权内继续；需要额外信息时明确问我。不要把未实践的建议说成已学会，也不要重做无关测试或改其他项目。`})}>{group.next}</Primary><small>复制请求，再到 Agent 中发送。</small></div></div></Reveal>}</article>)}</section>
    {!items.length&&<div className="empty-state"><p>{assistant?(tab==='todos'?'还没有待办。可以让 Agent 记下以后要继续的事。':tab==='learning'?'还没有学习建议。工作中发现值得积累的内容时，Agent 会告诉你。':'还没有长期改进计划。可以和 Agent 商量哪些方面需要定期检查。'):'先在上方选择助手文件夹，查看已保存的任务和计划。'}</p></div>}
    <div className="growth-reminder"><MessageCircle size={20}/><span>Agent 会简短汇报：这次用上了什么，又记住了什么。</span><Help label="学习和使用会怎样告诉我？">用过的内容会说明这次帮了什么忙；新学到的内容会说明是否已保存、以后什么时候用。只是读到一条记录，不会算作已经用上。</Help></div>
  </Page>;
}
