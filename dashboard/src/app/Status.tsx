import {ArrowRight,FolderOpen,RefreshCw} from 'lucide-react';
import {type Ask,AssistantNotice,Consequence,Disclosure,Heading,Page,Summary} from './shared';
import {useClient} from './client-state';
import {SourceText} from './SourceText';
export default function Status({ask}:{ask:Ask}){
 const {assistant,source,chooseAssistant,refreshData,dataLoading}=useClient(),s=assistant?.snapshot as any;
 const settings=[
 {title:'交流方式',value:s?.profile.guidance_mode==='step-by-step'?'一步步讲解':s?.profile.guidance_mode==='direct'?'直接讨论':'按当前设置',button:'调整交流方式',actionId:'profile.adjust-guidance-mode',body:'请说明当前交流方式，再根据我的需要调整讲解的详细程度。'},
 {title:'学习方式',value:s?.profile.learning_policy==='manual-only'?'保存前先询问':s?.profile.learning_policy==='risk-tiered'?'按风险处理':'尚未确认',button:'调整学习方式',body:'请先读取并说明这份助手目前的学习方式。用普通话解释会自动做什么、哪些情况需要问我；如果我想调整，再按我的选择修改，不动已有记忆、SOP 和能力。'},
 {title:'已有偏好',value:'从另一份助手核对后复用',button:'复用已有偏好',actionId:'preference.reuse-from-instance',body:'我想从另一份 AI Carry 复用合适的个人偏好。先引导我提供那份助手的位置，比较以后再决定。'},
 {title:'当前模型',value:s?.model?.name||'尚未确认',button:'核对当前模型',body:'请按项目现有模型确认路线核对当前宿主和模型。不能确认的信息明确说明，不把模型档次当作能否继续工作的门槛。'},
 ];
 return <Page><Heading title="设置">查看助手资料，按需要调整。</Heading><AssistantNotice/><section className="settings-section"><h2>这份助手</h2><Summary rows={[{label:'名称',value:s?.profile.display_name||'尚未读取',source:!!s?.profile.display_name},{label:'版本',value:s?.meta.product_version||'尚未读取'},{label:'资料状态',value:s?.meta.state==='instance'?'已创建助手':s?.meta.state==='template'?'尚未创建':'尚未读取'}]}/>{window.carryClient&&<button className="secondary-button" disabled={dataLoading} onClick={()=>void chooseAssistant()}><FolderOpen size={16}/>{assistant?'更换助手文件夹':'选择助手文件夹'}</button>}</section>
 <section className="settings-section"><h2>交流与学习</h2>{settings.map(a=><div className="setting-row" key={a.title}><div><strong>{a.title}</strong><p>{a.title==='当前模型'&&s?.model?.name?<SourceText>{a.value}</SourceText>:a.value}</p></div><button className="secondary-button" onClick={()=>ask({title:a.button,actionId:a.actionId,body:a.body,assistant:source(),summary:[{label:'当前设置',value:a.value,source:a.title==='当前模型'&&!!s?.model?.name}],impact:'先说明现有设置，再按你的选择调整；已有积累保留。'})}>{a.button}<ArrowRight size={16}/></button></div>)}</section>
 <section className="settings-section"><h2>版本与显示资料</h2><div className="setting-row"><div><strong>检查新版</strong><p>先看变化，再决定是否升级。</p></div><button className="secondary-button" onClick={()=>ask({actionId:'instance.upgrade-template',title:'检查 AI Carry 新版',summary:[{label:'当前版本',value:s?.meta.product_version||'待确认'}],impact:'本次先检查并预览；升级前保留身份、积累、本机绑定与私密资料。',body:'请按母版升级路线检查 AI Carry 是否有可用正式新版，先说明变化和对我现有内容的影响。保留实例身份、记忆、SOP、Skill、本地软件绑定与私密资料；本次只检查并给出预览，等我确认后再升级。'})}>预览检查请求<ArrowRight size={16}/></button></div>
 <div className="setting-row"><div><strong>重新读取</strong><p>显示 Agent 已保存的最新资料。</p></div><button className="secondary-button" disabled={dataLoading} onClick={()=>void refreshData()}><RefreshCw size={16}/>重新读取资料</button></div>
 <Disclosure title="资料仍未更新？"><Consequence>重新生成看板会让 Agent 从正式资料更新显示内容；不会代替你执行其他任务。</Consequence><button className="secondary-button" onClick={()=>ask({title:'重新生成看板',actionId:'dashboard.refresh-snapshot',body:'请从正式资料更新看板。单条记录有问题时只处理那一条，其他内容继续显示。',impact:'只更新显示资料；单条异常局部处理。'})}>预览重新生成请求</button></Disclosure></section>
 <Disclosure title="资料存放位置">{s?.overview?.domain&&<p>助手方向：<SourceText>{s.overview.domain}</SourceText></p>}<p>{assistant?.binding.root?<SourceText>{assistant.binding.root}</SourceText>:'网页版使用当前入口旁保存的看板资料。'}</p><p>请求中会携带可确认的助手信息，供 Agent 核对来源。</p></Disclosure></Page>;
}
