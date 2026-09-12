import {type Ask,AssistantNotice,Heading,Page,Primary,More} from './shared';
import {useClient} from './client-state';
export default function Status({ask}:{ask:Ask}){
 const {assistant,source}=useClient();const s=assistant?.snapshot as any;
 const actions=[
  {title:'交流方式',actionId:'profile.adjust-guidance-mode',body:'请说明当前交流方式，再根据我的需要调整讲解的详细程度。'},
  {title:'复用已有偏好',actionId:'preference.reuse-from-instance',body:'我想从另一份 AI Carry 复用合适的个人偏好。先引导我提供那份助手的位置，比较以后再决定。'},
  {title:'当前模型',body:'请按项目现有模型确认路线核对当前宿主和模型。不能确认的信息明确说明，不把模型档次当作能否继续工作的门槛。'},
  {title:'重新生成看板',actionId:'dashboard.refresh-snapshot',body:'请从正式资料更新看板。单条记录有问题时只处理那一条，其他内容继续显示。'}
 ];
 return <Page><Heading title="我的助手，" accent="当前状态。">查看这份助手的设置，也可以让 Agent 帮你调整。</Heading><AssistantNotice/>
 <dl className="settings-summary"><div><dt>助手</dt><dd>{s?.profile.display_name||'尚未读取'}</dd></div><div><dt>版本</dt><dd>{s?.meta.product_version||'—'}</dd></div><div><dt>方向</dt><dd>{s?.overview?.domain==='uninstantiated'?'尚未创建':s?.overview?.domain||'待确认'}</dd></div><div><dt>当前模型</dt><dd>{s?.model?.name||'尚未确认'}</dd></div></dl>
 <div className="settings-actions">{actions.map(a=><section key={a.title}><h2>{a.title}</h2><Primary onClick={()=>ask({...a,assistant:source()})}>让 Agent {a.title==='当前模型'?'核对当前模型':a.title==='交流方式'?'调整交流方式':a.title==='复用已有偏好'?'帮我复用偏好':'重新生成看板'}</Primary></section>)}</div>
 <More title="这会直接修改助手吗？">不会。你先预览请求，再复制到想用的 Agent 中发送。Agent 会按实际资料和本次授权处理；不需要重新创建助手。</More></Page>;
}
